import { describe, it, expect, vi } from 'vitest'
import { clickTurnstileBox, autoClickTurnstile, turnstileBox, turnstileVisible } from '../src/automation/turnstile'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const BOX = { x: 933, y: 510, width: 60, height: 50 }

const transientErr = () => new Error('cdpSession.send: Protocol error (Input.dispatchMouseEvent): Invalid parameters')

/** 假依赖：boundingBox 依次取 boxes；clickAt 可配置抛错序列；等待缩放加速 */
function makeDeps(
  boxes: Array<{ x: number; y: number; width: number; height: number } | null>,
  clickAt: ReturnType<typeof vi.fn>,
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } = { info: vi.fn(), warn: vi.fn() },
) {
  let i = 0
  const page = {
    locator: () => ({
      first: () => ({
        boundingBox: async () => boxes[Math.min(i++, boxes.length - 1)],
        count: async () => (boxes[Math.min(i, boxes.length - 1)] ? 1 : 0),
      }),
    }),
    waitForTimeout: async (ms: number) => {
      await sleep(Math.min(ms, 10))
    },
  }
  return {
    deps: { page: page as never, human: { clickAt } as never, logger: log as never },
    page,
  }
}

describe('clickTurnstileBox 拟人点击与瞬时重试', () => {
  it('方框存在：点击即返回 true', async () => {
    const clickAt = vi.fn().mockResolvedValue(undefined)
    const { deps } = makeDeps([BOX], clickAt)
    expect(await clickTurnstileBox(deps)).toBe(true)
    expect(clickAt).toHaveBeenCalledTimes(1)
    // 点击坐标为方框左侧中部（x 偏左 30px 内，y 居中）
    expect(clickAt.mock.calls[0][0]).toBeCloseTo(BOX.x + Math.min(30, BOX.width * 0.4), 0)
    expect(clickAt.mock.calls[0][1]).toBeCloseTo(BOX.y + BOX.height / 2, 0)
  })

  it('被浏览器拒绝（Protocol error）后重新取盒重试成功', async () => {
    const clickAt = vi.fn().mockRejectedValueOnce(transientErr()).mockResolvedValueOnce(undefined)
    const warn = vi.fn()
    const { deps } = makeDeps([BOX, BOX], clickAt, { info: vi.fn(), warn })
    expect(await clickTurnstileBox(deps)).toBe(true)
    expect(clickAt).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatchObject({ attempt: 1 })
    expect(warn.mock.calls[0][0].err).toContain('Protocol error')
  })

  it('连续三次被浏览器拒绝后向上抛错', async () => {
    const clickAt = vi.fn().mockRejectedValue(transientErr())
    const { deps } = makeDeps([BOX, BOX, BOX], clickAt)
    await expect(clickTurnstileBox(deps)).rejects.toThrow('Protocol error')
    expect(clickAt).toHaveBeenCalledTimes(3)
  })

  it('非瞬时错误不重试直接抛', async () => {
    const clickAt = vi.fn().mockRejectedValue(new Error('点击失败: 找不到元素 iframe'))
    const { deps } = makeDeps([BOX], clickAt)
    await expect(clickTurnstileBox(deps)).rejects.toThrow('找不到元素')
    expect(clickAt).toHaveBeenCalledTimes(1)
  })

  it('方框不存在返回 false 且不点击', async () => {
    const clickAt = vi.fn()
    const { deps } = makeDeps([null], clickAt)
    expect(await clickTurnstileBox(deps)).toBe(false)
    expect(clickAt).not.toHaveBeenCalled()
  })
})

describe('turnstileBox / turnstileVisible', () => {
  it('尺寸过小的方框视为不存在', async () => {
    const clickAt = vi.fn()
    const { deps } = makeDeps([{ x: 0, y: 0, width: 5, height: 5 }], clickAt)
    expect(await clickTurnstileBox(deps)).toBe(false)
    expect(clickAt).not.toHaveBeenCalled()
  })

  it('turnstileBox 任一选择器命中返回盒', async () => {
    const boxes = [null, BOX]
    let i = 0
    const page = {
      locator: () => ({
        first: () => ({ boundingBox: async () => boxes[Math.min(i++, boxes.length - 1)] }),
      }),
    }
    expect(await turnstileBox(page as never)).toEqual(BOX)
  })

  it('turnstileVisible：任一选择器命中即可见', async () => {
    const counts = [1, 0]
    let i = 0
    const page = {
      locator: () => ({
        first: () => ({ count: async () => counts[Math.min(i++, counts.length - 1)] }),
      }),
    }
    expect(await turnstileVisible(page as never)).toBe(true)
    const counts2 = [0, 0]
    i = 0
    const page2 = {
      locator: () => ({
        first: () => ({ count: async () => counts2[Math.min(i++, counts2.length - 1)] }),
      }),
    }
    expect(await turnstileVisible(page2 as never)).toBe(false)
  })
})

describe('autoClickTurnstile 预算内轮询', () => {
  it('方框在轮询期内出现并点击成功', async () => {
    const clickAt = vi.fn().mockResolvedValue(undefined)
    const boxes: Array<{ x: number; y: number; width: number; height: number } | null> = []
    for (let k = 0; k < 5; k++) boxes.push(null)
    boxes.push(BOX)
    const { deps } = makeDeps(boxes, clickAt)
    expect(await autoClickTurnstile(deps, 2000)).toBe(true)
    expect(clickAt).toHaveBeenCalledTimes(1)
  })

  it('预算耗尽未出现方框返回 false 并记录日志', async () => {
    const clickAt = vi.fn()
    const info = vi.fn()
    const { deps } = makeDeps([null], clickAt, { info, warn: vi.fn() })
    expect(await autoClickTurnstile(deps, 100)).toBe(false)
    expect(clickAt).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalled()
  })
})
