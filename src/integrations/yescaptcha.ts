/**
 * yescaptcha 打码服务（integrations 层）：验证码检测 + 解题 + token 回填
 * 依赖方向：依赖 infrastructure/http 与 patchright 类型，被 engine/window-runner 与 task-context 依赖
 * 设计思路：解题客户端内部用 promise 链串行排队，满足平台"每账号同时仅 1 个识别任务"的硬限制
 */
import type { Page } from 'patchright'
import { httpJson } from '../infrastructure/http'

/** 支持的验证码类型（recaptcha_v3 无可见 iframe，只支持回填不支持检测） */
export type CaptchaKind = 'turnstile' | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'image'

/** 检测结果：类型 + sitekey（可能为 null，某些站点用动态注入的 sitekey） */
export interface CaptchaDetected {
  kind: CaptchaKind
  sitekey: string | null
}

/** 打码业务失败（余额不足/解题超时/无 sitekey 等），window-runner 以此区分 captcha 失败终态 */
export class CaptchaFailure extends Error {}

/**
 * 各类型单次解题的估算点数（1 点 = ¥0.001）：
 * 解题结果接口不返回单价，按 yescaptcha 官方定价档位估算，仅用于成本日志与看板统计
 */
export const ESTIMATED_COST_POINTS: Record<CaptchaKind, number> = {
  turnstile: 25,
  recaptcha_v2: 15,
  recaptcha_v3: 20,
  hcaptcha: 30,
  image: 4,
}

// iframe 型验证码的识别选择器（按出现频率排序：Turnstile 最常用）
const DETECTORS: Array<{ kind: CaptchaKind; selector: string; sitekeyAttr: string }> = [
  { kind: 'turnstile', selector: 'iframe[src*="challenges.cloudflare.com"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'recaptcha_v2', selector: 'iframe[src*="recaptcha/api2/anchor"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'hcaptcha', selector: 'iframe[src*="hcaptcha.com/captcha"]', sitekeyAttr: 'data-sitekey' },
]

/**
 * 轮询检测页面上的验证码 iframe（直到超时）
 * @param timeoutMs 检测窗口时长，默认 5 秒（验证码 iframe 通常渲染较快）
 * @returns 检测到返回类型与 sitekey；未检测到返回 null
 * 设计权衡：sitekey 优先从 iframe src 的 k=/sitekey= 参数提取（最可靠），
 * 提取失败再查 data-sitekey 属性（部分站点动态注入）
 */
export async function detectCaptcha(page: Page, timeoutMs = 5000): Promise<CaptchaDetected | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const d of DETECTORS) {
      const iframe = page.locator(d.selector).first()
      if (await iframe.count() > 0) {
        const src = (await iframe.getAttribute('src')) ?? ''
        const sitekeyMatch = src.match(/[?&]k=([^&]+)/) ?? src.match(/[?&]sitekey=([^&]+)/)
        let sitekey = sitekeyMatch ? sitekeyMatch[1] : null
        if (!sitekey) {
          const container = page.locator(`[${d.sitekeyAttr}]`).first()
          if (await container.count() > 0) sitekey = await container.getAttribute(d.sitekeyAttr)
        }
        return { kind: d.kind, sitekey }
      }
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}

/** 平台响应包（errorId=0 表示成功；solution 字段随任务类型不同） */
interface YesCaptchaResp {
  errorId?: number
  errorCode?: string
  taskId?: string
  status?: string
  solution?: { token?: string; gRecaptchaResponse?: string; text?: string }
  balance?: number
}

/**
 * yescaptcha 解题客户端
 * 关键设计：serialQueue 机制——所有 solveCaptcha 调用都挂在 this.chain 上依次执行，
 * 即使调度器并发触发多个任务，平台侧也永远只有 1 个识别任务在跑（平台每账号 1 并发硬限制，超限直接报错）
 */
export class YesCaptchaClient {
  /** 串行 promise 链：当前链尾，新请求挂在其后 */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private cfg: { apiBase: string; clientKey: string; solveTimeoutMs: number; pollIntervalMs: number }, private taskTypes: Record<string, string>) {}

  /** 平台接口统一调用（30s 固定超时：createTask/getBalance 都是快接口） */
  private async call(path: string, body: unknown): Promise<YesCaptchaResp> {
    return httpJson<YesCaptchaResp>({ baseUrl: this.cfg.apiBase, path, method: 'POST', body, timeoutMs: 30000 })
  }

  /** 创建识别任务，返回 taskId */
  private async createTask(task: Record<string, unknown>): Promise<string> {
    const resp = await this.call('/createTask', { clientKey: this.cfg.clientKey, task })
    if (resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 创建任务失败: ${resp.errorCode ?? resp.errorId}`)
    return resp.taskId!
  }

  /**
   * 查询解题结果
   * @returns 已就绪返回 token（按类型取对应字段）；未就绪返回 null
   */
  private async getResult(taskId: string, kind: CaptchaKind): Promise<string | null> {
    const resp = await this.call('/getTaskResult', { clientKey: this.cfg.clientKey, taskId })
    if (resp.status !== 'ready') return null
    const s = resp.solution ?? {}
    if (kind === 'turnstile') return s.token ?? null
    if (kind === 'image') return s.text ?? null
    return s.gRecaptchaResponse ?? null
  }

  /** 查询账户余额（点） */
  async getBalance(): Promise<number> {
    const resp = await this.call('/getBalance', { clientKey: this.cfg.clientKey })
    return resp.balance ?? 0
  }

  /** 余额校验：低于最低额度抛 CaptchaFailure（解题前调用，避免白跑创建任务） */
  async ensureBalance(minAmount: number): Promise<void> {
    const balance = await this.getBalance()
    if (balance < minAmount) throw new CaptchaFailure(`yescaptcha 余额不足: ${balance} 点 < ${minAmount} 点`)
  }

  /**
   * 解题并返回 token（创建任务 → 轮询结果 → 超时抛错）
   * @param kind 验证码类型（决定平台任务类型与 solution 取值字段）
   * @param sitekey 站点 sitekey（必填，缺失直接抛错）
   * @param pageUrl 触发验证码的页面地址
   * @param extra 透传给平台任务体的附加参数（如 recaptcha_v3 的 minScore）
   * @returns 解题 token
   * @throws CaptchaFailure 无 sitekey / 类型不支持 / 创建失败 / 超时（solveTimeoutMs）
   */
  solveCaptcha(kind: CaptchaKind, sitekey: string | null, pageUrl: string, extra: Record<string, unknown> = {}): Promise<string> {
    const run = async (): Promise<string> => {
      if (!sitekey) throw new CaptchaFailure('验证码未找到 sitekey')
      const taskType = this.taskTypes[kind]
      if (!taskType) throw new CaptchaFailure(`不支持的验证码类型: ${kind}`)
      const taskId = await this.createTask({ type: taskType, websiteURL: pageUrl, websiteKey: sitekey, ...extra })
      const deadline = Date.now() + this.cfg.solveTimeoutMs
      while (Date.now() < deadline) {
        const token = await this.getResult(taskId, kind)
        if (token) return token
        await new Promise(r => setTimeout(r, this.cfg.pollIntervalMs))
      }
      throw new CaptchaFailure(`yescaptcha 解题超时: taskId=${taskId}`)
    }
    // 串行排队：链尾后再跑本次任务；失败不中断链（catch 兜底），后续任务继续排队
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => {})
    return result
  }
}

/**
 * 打码编排服务：检测 → 余额校验 → 解题 → 回填 → 成本记账
 * 设计权衡：clientKey 未配置时 app 层注入 null，任务侧 solveCaptcha 直接返回 none，保证无 Key 也能运行
 */
export class CaptchaService {
  constructor(private client: YesCaptchaClient, private cfg: { maxCostPerTask: number }) {}

  /**
   * 自动打码主入口
   * @param opts.enabled 是否启用（任务 meta.captcha.auto）
   * @param opts.onLog 成本回调（成功/失败都记录到 captcha_logs）
   * @returns 'none' 未启用或未检测到；'solved' 解题并回填成功
   * @throws CaptchaFailure 解题失败时先记失败日志再抛出，由 window-runner 归入 captcha_failed 终态
   */
  async autoSolve(page: Page, opts: { enabled: boolean; profileId: number | null; taskKey: string | null; onLog: (kind: string, ok: boolean, costPoints: number) => void }): Promise<'none' | 'solved' | 'failed'> {
    if (!opts.enabled) return 'none'
    const detected = await detectCaptcha(page)
    if (!detected) return 'none'
    try {
      await this.client.ensureBalance(this.cfg.maxCostPerTask)
      const token = await this.client.solveCaptcha(detected.kind, detected.sitekey, page.url())
      await this.applyToken(page, detected.kind, token)
      opts.onLog(detected.kind, true, ESTIMATED_COST_POINTS[detected.kind] ?? 0)
      return 'solved'
    } catch (e) {
      opts.onLog(detected.kind, false, ESTIMATED_COST_POINTS[detected.kind] ?? 0)
      throw new CaptchaFailure(`验证码处理失败: ${(e as Error).message}`)
    }
  }

  /**
   * 把 token 回填到站点表单并派发 input 事件（触发站点 JS 校验）
   * 关键设计：evaluate 第三参 { isolatedContext: false } 是 patchright 扩展，
   * 把值写进站点主世界——默认隔离世界写的值站点 JS 读不到
   */
  private async applyToken(page: Page, kind: CaptchaKind, token: string): Promise<void> {
    if (kind === 'turnstile') {
      await page.evaluate((t) => {
        const input = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')
        if (input) {
          input.value = t
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }, token, {}, false)
    } else if (kind === 'hcaptcha') {
      await page.evaluate((t) => {
        const h = document.querySelector<HTMLTextAreaElement>('textarea[name="h-captcha-response"]')
        if (h) {
          h.value = t
          h.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const g = document.querySelector<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]')
        if (g) {
          g.value = t
          g.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }, token, {}, false)
    } else {
      await page.evaluate((t) => {
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea[name="g-recaptcha-response"]')
        if (textarea) {
          textarea.value = t
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }, token, {}, false)
    }
  }
}
