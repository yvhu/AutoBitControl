/**
 * 拟人化交互层（automation 层）：人类手感的鼠标轨迹/点击/键入/滚动
 * 依赖方向：依赖 ghost-cursor 与 patchright 类型，被 engine/task-context 依赖
 * 设计思路：ghost-cursor 只负责生成贝塞尔轨迹，事件派发走 CDP Input.dispatchMouseEvent——
 *   原生 page.mouse 一步到位是直线，逐点派发轨迹可控、isTrusted 语义与真实输入一致，
 *   且与比特浏览器 CDP 连接模型统一（详见 docs/API-GUIDE.md「CDP 派发原理」）
 */
import { path as ghostPath } from 'ghost-cursor'
import type { Page, CDPSession } from 'patchright'

export interface HumanizeOptions {
  /** 移动类动作的最小停顿（毫秒） */
  minDelayMs?: number
  /** 移动类动作的最大停顿（毫秒） */
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

/**
 * 在元素盒内取随机落点：四周各留 7.5% 边距（margin 0.15 合计 15%），
 * 避开边缘（点击边缘易误触相邻元素或超出点击区）
 */
export function randomPointInBox(box: Box): Point {
  const margin = 0.15
  const w = box.width * (1 - margin)
  const h = box.height * (1 - margin)
  return {
    x: box.x + box.width * margin / 2 + Math.random() * w,
    y: box.y + box.height * margin / 2 + Math.random() * h,
  }
}

/**
 * 拟人操作器：所有交互都带随机节奏（停顿区间随机），
 * 静态方法可直接调用（任务里 Humanizer.sleep 做拟人等待）
 */
export class Humanizer {
  /** CDP 会话懒创建并复用（每页面一个，避免重复握手开销） */
  private session: CDPSession | null = null
  /** 鼠标当前位置：作为下一次轨迹的起点与滚轮派发位置 */
  private last: Point = { x: 200, y: 200 }
  private minDelay: number
  private maxDelay: number

  constructor(private page: Page, opts: HumanizeOptions = {}) {
    // 默认 0.8-3s：停顿过短像脚本，过长拖慢整体节奏
    this.minDelay = opts.minDelayMs ?? 800
    this.maxDelay = opts.maxDelayMs ?? 3000
  }

  /** 区间内均匀随机停顿 */
  static async sleep(minMs: number, maxMs: number): Promise<void> {
    const ms = minMs + Math.random() * (maxMs - minMs)
    await new Promise(r => setTimeout(r, ms))
  }

  /** 获取（或创建）本页面的 CDP 会话 */
  private async cdp(): Promise<CDPSession> {
    if (!this.session) this.session = await this.page.context().newCDPSession(this.page)
    return this.session
  }

  /**
   * 沿贝塞尔轨迹移动鼠标到目标点：
   * ghost-cursor 生成轨迹点 → CDP mouseMoved 逐点派发（间隔 8~23ms 模拟手速抖动）
   */
  async moveTo(x: number, y: number): Promise<void> {
    const points = ghostPath(this.last, { x, y }, { spreadOverride: 25 }) as Point[]
    for (const p of points) {
      const s = await this.cdp()
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
      await new Promise(r => setTimeout(r, 8 + Math.random() * 15))
    }
    this.last = { x, y }
  }

  /**
   * 拟人点击：hover 预热（失败容错，部分元素无 hover 态）→ 轨迹移动 →
   * 短暂停顿 → 按下/抬起（间隔 40-150ms 模拟真实按压时长）
   * @throws 元素不存在（boundingBox 为空）
   */
  async click(selector: string): Promise<void> {
    const box = await this.page.locator(selector).first().boundingBox()
    if (!box) throw new Error(`点击失败: 找不到元素 ${selector}`)
    const target = randomPointInBox(box)
    await this.page.locator(selector).first().hover({ timeout: 5000 }).catch(() => {})
    await this.moveTo(target.x, target.y)
    // 点击前犹豫：使用构造注入的 min/max 停顿区间（默认 0.8-3s，可调快调慢）
    await Humanizer.sleep(this.minDelay, this.maxDelay)
    const s = await this.cdp()
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
    await Humanizer.sleep(40, 150)
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  }

  /**
   * 在指定坐标拟人点击（弹窗遮罩空白处、canvas 按钮等无选择器的场景）：
   * 轨迹移动 → 60-400ms 停顿 → 按下 → 40-150ms → 抬起（复用 click 的按压节奏，不做 hover/随机落点）
   */
  async clickAt(x: number, y: number): Promise<void> {
    await this.moveTo(x, y)
    await Humanizer.sleep(60, 400)
    const s = await this.cdp()
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await Humanizer.sleep(40, 150)
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  /**
   * 拟人键入：先点击聚焦，逐键 40-130ms 延迟；
   * 3% 概率错键后回删重打（模拟真实手误，降低键入节奏的规律性）
   */
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

  /** 在鼠标当前位置派发滚轮事件（正数向下滚），随后随机停顿 */
  async scroll(deltaY: number): Promise<void> {
    const s = await this.cdp()
    await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.last.x, y: this.last.y, deltaX: 0, deltaY })
    await Humanizer.sleep(100, 400)
  }

  /** 在当前位置 ±60px 内随机微移（模拟真实用户无目的的小动作） */
  async randomMicroMove(): Promise<void> {
    const dx = (Math.random() - 0.5) * 120
    const dy = (Math.random() - 0.5) * 120
    await this.moveTo(this.last.x + dx, this.last.y + dy)
  }
}
