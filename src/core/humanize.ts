import { path as ghostPath } from 'ghost-cursor'
import type { Page, CDPSession } from 'patchright'

export interface HumanizeOptions {
  minDelayMs?: number
  maxDelayMs?: number
}

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export function randomPointInBox(box: Box): Point {
  const margin = 0.15
  const w = box.width * (1 - margin)
  const h = box.height * (1 - margin)
  return {
    x: box.x + box.width * margin / 2 + Math.random() * w,
    y: box.y + box.height * margin / 2 + Math.random() * h,
  }
}

export class Humanizer {
  private session: CDPSession | null = null
  private last: Point = { x: 200, y: 200 }
  private minDelay: number
  private maxDelay: number

  constructor(private page: Page, opts: HumanizeOptions = {}) {
    this.minDelay = opts.minDelayMs ?? 800
    this.maxDelay = opts.maxDelayMs ?? 3000
  }

  static async sleep(minMs: number, maxMs: number): Promise<void> {
    const ms = minMs + Math.random() * (maxMs - minMs)
    await new Promise(r => setTimeout(r, ms))
  }

  private async cdp(): Promise<CDPSession> {
    if (!this.session) this.session = await this.page.context().newCDPSession(this.page)
    return this.session
  }

  async moveTo(x: number, y: number): Promise<void> {
    const points = ghostPath(this.last, { x, y }, { spreadOverride: 25 }) as Point[]
    for (const p of points) {
      const s = await this.cdp()
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
      await new Promise(r => setTimeout(r, 8 + Math.random() * 15))
    }
    this.last = { x, y }
  }

  async click(selector: string): Promise<void> {
    const box = await this.page.locator(selector).first().boundingBox()
    if (!box) throw new Error(`点击失败: 找不到元素 ${selector}`)
    const target = randomPointInBox(box)
    await this.page.locator(selector).first().hover({ timeout: 5000 }).catch(() => {})
    await this.moveTo(target.x, target.y)
    await Humanizer.sleep(60, 400)
    const s = await this.cdp()
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await Humanizer.sleep(40, 150)
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector)
    for (const ch of text) {
      await this.page.keyboard.type(ch, { delay: 40 + Math.random() * 90 })
      if (Math.random() < 0.03) {
        await this.page.keyboard.press('Backspace')
        await Humanizer.sleep(100, 300)
        await this.page.keyboard.type(ch, { delay: 60 + Math.random() * 90 })
      }
    }
  }

  async scroll(deltaY: number): Promise<void> {
    const s = await this.cdp()
    await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.last.x, y: this.last.y, deltaX: 0, deltaY })
    await Humanizer.sleep(100, 400)
  }

  async randomMicroMove(): Promise<void> {
    const dx = (Math.random() - 0.5) * 120
    const dy = (Math.random() - 0.5) * 120
    await this.moveTo(this.last.x + dx, this.last.y + dy)
  }
}
