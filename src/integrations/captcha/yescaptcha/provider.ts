/**
 * yescaptcha 平台实现（integrations/captcha/yescaptcha 层）：实现 CaptchaProvider
 * 依赖方向：依赖本目录 client 与 task-types，对外只暴露 CaptchaProvider 契约
 * 设计思路：所有解题调用挂在串行 promise 链上（平台每账号 1 并发硬限制，超限直接报错），
 * 即使调度器并发触发多个任务，平台侧也永远只有 1 个识别任务在跑
 * 官方依据（计划核对总表）：请求/响应字段逐字对齐 33351/196857/229767 与各任务类型页；
 * 轮询节奏对齐官方「间隔3秒一次」「120秒任务超时」（由 cfg.solveTimeoutMs/pollIntervalMs 承接）
 */
import type { CaptchaProvider, TokenCaptchaKind, GridResult } from '../provider'
import { CaptchaFailure } from '../provider'
import { YesCaptchaApiClient } from './client'
import { YESCAPTCHA_TOKEN_TASK_TYPES, YESCAPTCHA_GRID_TASK_TYPE } from './task-types'

export interface YesCaptchaProviderCfg {
  solveTimeoutMs: number
  pollIntervalMs: number
}

export class YesCaptchaProvider implements CaptchaProvider {
  readonly platform = 'yescaptcha'
  /** 串行 promise 链：链尾；新请求挂在其后，失败不中断链（catch 兜底） */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private client: YesCaptchaApiClient, private cfg: YesCaptchaProviderCfg) {}

  solveToken(kind: TokenCaptchaKind, sitekey: string | null, pageUrl: string, extra: Record<string, unknown> = {}): Promise<string> {
    const run = async (): Promise<string> => {
      if (!sitekey) throw new CaptchaFailure('验证码未找到 sitekey')
      const taskType = YESCAPTCHA_TOKEN_TASK_TYPES[kind]
      if (!taskType) throw new CaptchaFailure(`不支持的验证码类型: ${kind}`)
      // 官方任务体：type + websiteURL/websiteKey + 各类型可选参数（extra 原样透传）
      const taskId = await this.client.createTask({ type: taskType, websiteURL: pageUrl, websiteKey: sitekey, ...extra })
      const deadline = Date.now() + this.cfg.solveTimeoutMs
      while (Date.now() < deadline) {
        const resp = await this.client.getTaskResult(taskId)
        if (resp.status === 'ready') {
          const s = resp.solution ?? {}
          // 官方：turnstile 取 solution.token；其余取 solution.gRecaptchaResponse
          const token = kind === 'turnstile' ? s.token : s.gRecaptchaResponse
          if (!token) throw new CaptchaFailure(`yescaptcha 解题结果格式异常: taskId=${taskId}`)
          return token
        }
        await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs))
      }
      throw new CaptchaFailure(`yescaptcha 解题超时: taskId=${taskId}`)
    }
    return this.enqueue(run)
  }

  classifyGrid(image: string, questionId: string, confidence?: number): Promise<GridResult> {
    const run = async (): Promise<GridResult> => {
      // 官方任务体（wiki 18055169）：type=ReCaptchaV2Classification + image（无 data: 前缀）+ question（/m/ 开头）+ confidence（可选）
      const taskId = await this.client.createTask({
        type: YESCAPTCHA_GRID_TASK_TYPE,
        image,
        question: questionId,
        ...(confidence === undefined ? {} : { confidence }),
      })
      const deadline = Date.now() + this.cfg.solveTimeoutMs
      while (Date.now() < deadline) {
        const resp = await this.client.getTaskResult(taskId)
        if (resp.status === 'ready') {
          const s = resp.solution ?? {}
          // 官方：multi → objects（需要点击的格子序号）；single（1x1 小图）→ hasObject（是否需要点击）
          if (s.type === 'multi' && Array.isArray(s.objects)) return { type: 'multi', objects: s.objects }
          if (s.type === 'single' && typeof s.hasObject === 'boolean') return { type: 'single', hasObject: s.hasObject }
          if (Array.isArray(s.objects)) return { type: 'multi', objects: s.objects }
          if (typeof s.hasObject === 'boolean') return { type: 'single', hasObject: s.hasObject }
          throw new CaptchaFailure('yescaptcha 分类结果格式异常')
        }
        await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs))
      }
      throw new CaptchaFailure(`yescaptcha 分类超时: taskId=${taskId}`)
    }
    return this.enqueue(run)
  }

  async getBalance(): Promise<number> {
    return this.client.getBalance()
  }

  /** 挂串行链执行：链尾后再跑本次任务；失败不中断链，后续任务继续排队 */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => {})
    return result
  }
}
