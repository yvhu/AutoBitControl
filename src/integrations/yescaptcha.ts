import type { Page } from 'patchright'
import { httpJson } from '../infrastructure/http'

export type CaptchaKind = 'turnstile' | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'image'

export interface CaptchaDetected {
  kind: CaptchaKind
  sitekey: string | null
}

export class CaptchaFailure extends Error {}

export const ESTIMATED_COST_POINTS: Record<CaptchaKind, number> = {
  turnstile: 25,
  recaptcha_v2: 15,
  recaptcha_v3: 20,
  hcaptcha: 30,
  image: 4,
}

const DETECTORS: Array<{ kind: CaptchaKind; selector: string; sitekeyAttr: string }> = [
  { kind: 'turnstile', selector: 'iframe[src*="challenges.cloudflare.com"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'recaptcha_v2', selector: 'iframe[src*="recaptcha/api2/anchor"]', sitekeyAttr: 'data-sitekey' },
  { kind: 'hcaptcha', selector: 'iframe[src*="hcaptcha.com/captcha"]', sitekeyAttr: 'data-sitekey' },
]

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

interface YesCaptchaResp {
  errorId?: number
  errorCode?: string
  taskId?: string
  status?: string
  solution?: { token?: string; gRecaptchaResponse?: string; text?: string }
  balance?: number
}

export class YesCaptchaClient {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private cfg: { apiBase: string; clientKey: string; solveTimeoutMs: number; pollIntervalMs: number }, private taskTypes: Record<string, string>) {}

  private async call(path: string, body: unknown): Promise<YesCaptchaResp> {
    return httpJson<YesCaptchaResp>({ baseUrl: this.cfg.apiBase, path, method: 'POST', body, timeoutMs: 30000 })
  }

  private async createTask(task: Record<string, unknown>): Promise<string> {
    const resp = await this.call('/createTask', { clientKey: this.cfg.clientKey, task })
    if (resp.errorId !== 0) throw new CaptchaFailure(`yescaptcha 创建任务失败: ${resp.errorCode ?? resp.errorId}`)
    return resp.taskId!
  }

  private async getResult(taskId: string, kind: CaptchaKind): Promise<string | null> {
    const resp = await this.call('/getTaskResult', { clientKey: this.cfg.clientKey, taskId })
    if (resp.status !== 'ready') return null
    const s = resp.solution ?? {}
    if (kind === 'turnstile') return s.token ?? null
    if (kind === 'image') return s.text ?? null
    return s.gRecaptchaResponse ?? null
  }

  async getBalance(): Promise<number> {
    const resp = await this.call('/getBalance', { clientKey: this.cfg.clientKey })
    return resp.balance ?? 0
  }

  async ensureBalance(minAmount: number): Promise<void> {
    const balance = await this.getBalance()
    if (balance < minAmount) throw new CaptchaFailure(`yescaptcha 余额不足: ${balance} 点 < ${minAmount} 点`)
  }

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
    const result = this.chain.then(run, run)
    this.chain = result.catch(() => {})
    return result
  }
}

export class CaptchaService {
  constructor(private client: YesCaptchaClient, private cfg: { maxCostPerTask: number }) {}

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
