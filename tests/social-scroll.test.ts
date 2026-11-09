import { describe, it, expect } from 'vitest'
import { humanScrollBurst, smoothScrollBy } from '../src/tasks/social/scroll'

/** 固定 rng：按给定值返回，便于断言滚动节奏 */
function fixedRng(value: number): () => number {
  return () => value
}

/** 最小假 ctx：只提供 helper 用到的鼠标/视口/等待 */
function makeCtx() {
  const state = { wheels: [] as number[], moves: [] as Array<{ x: number; y: number }> }
  const page = {
    mouse: {
      move: async (x: number, y: number) => { state.moves.push({ x, y }) },
      wheel: async (_dx: number, dy: number) => { state.wheels.push(dy) },
    },
    evaluate: async () => ({ width: 1280, height: 800 }),
    waitForTimeout: async () => {},
  }
  return { page, state, ctx: { page } as never }
}

describe('humanScrollBurst', () => {
  it('rng=0：先向下滚一次，再反向小幅回滚一次', async () => {
    const fake = makeCtx()
    await humanScrollBurst(fake.ctx, { direction: 1, rng: fixedRng(0) })
    expect(fake.state.moves).toHaveLength(1)
    expect(fake.state.wheels.some((d) => d > 0)).toBe(true)
    expect(fake.state.wheels.some((d) => d < 0)).toBe(true)
  })

  it('box：鼠标落在容器内，滚动距离按容器高度计算', async () => {
    const fake = makeCtx()
    const box = { x: 100, y: 50, width: 600, height: 900 }
    await humanScrollBurst(fake.ctx, { direction: 1, rng: fixedRng(0), box })
    expect(fake.state.moves[0].x).toBeGreaterThanOrEqual(box.x)
    expect(fake.state.moves[0].x).toBeLessThanOrEqual(box.x + box.width)
    expect(fake.state.moves[0].y).toBeGreaterThanOrEqual(box.y)
    expect(fake.state.moves[0].y).toBeLessThanOrEqual(box.y + box.height)
    const totalDown = fake.state.wheels.filter((d) => d > 0).reduce((sum, d) => sum + d, 0)
    expect(totalDown).toBeGreaterThanOrEqual(box.height * 0.5)
    expect(totalDown).toBeLessThanOrEqual(box.height * 0.9)
  })

  it('rng=0.7：拆成多段小滚轮，不触发反向回滚', async () => {
    const fake = makeCtx()
    await humanScrollBurst(fake.ctx, { direction: 1, rng: fixedRng(0.7) })
    expect(fake.state.wheels.filter((d) => d > 0).length).toBeGreaterThanOrEqual(6)
    expect(fake.state.wheels.some((d) => d < 0)).toBe(false)
  })

  it('allowReverse=false：只向下 3 段，不上滚', async () => {
    const fake = makeCtx()
    await humanScrollBurst(fake.ctx, {
      direction: 1,
      rng: fixedRng(0),
      allowReverse: false,
      stepsMin: 3,
      stepsMax: 3,
      stepGapMinMs: 0,
      stepGapMaxMs: 0,
    })
    expect(fake.state.wheels.filter((d) => d > 0)).toHaveLength(3)
    expect(fake.state.wheels.some((d) => d < 0)).toBe(false)
  })

  it('steps=1：只发一个 wheel 事件，距离不被缓动放大', async () => {
    const fake = makeCtx()
    const box = { x: 0, y: 0, width: 1000, height: 1000 }
    await humanScrollBurst(fake.ctx, {
      direction: 1,
      rng: fixedRng(0),
      box,
      allowReverse: false,
      stepsMin: 1,
      stepsMax: 1,
      distanceMinRatio: 0.35,
      distanceMaxRatio: 0.55,
    })
    expect(fake.state.wheels.filter((d) => d > 0)).toHaveLength(1)
    expect(fake.state.wheels[0]).toBeGreaterThanOrEqual(350)
    expect(fake.state.wheels[0]).toBeLessThanOrEqual(550)
    expect(fake.state.wheels.some((d) => d < 0)).toBe(false)
  })

  it('distancePx：按指定距离滚动', async () => {
    const fake = makeCtx()
    await humanScrollBurst(fake.ctx, {
      direction: 1,
      rng: fixedRng(0),
      allowReverse: false,
      stepsMin: 1,
      stepsMax: 1,
      distancePx: 320,
    })
    expect(fake.state.wheels.filter((d) => d > 0)).toEqual([320])
  })

  it('notch 模式：600px 拆成 50-80px 小滚轮，逐段慢滚', async () => {
    const fake = makeCtx()
    await humanScrollBurst(fake.ctx, {
      direction: 1,
      rng: fixedRng(0),
      allowReverse: false,
      distancePx: 600,
      notchMinPx: 50,
      notchMaxPx: 80,
      stepGapMinMs: 0,
      stepGapMaxMs: 0,
    })
    const downs = fake.state.wheels.filter((d) => d > 0)
    expect(downs.length).toBeGreaterThanOrEqual(7)
    expect(downs.reduce((sum, d) => sum + d, 0)).toBeGreaterThanOrEqual(580)
    expect(fake.state.wheels.some((d) => d < 0)).toBe(false)
  })

  it('smoothWheel：拆成大量小 wheel，总距离准确，不反向', async () => {
    const fake = makeCtx()
    await humanScrollBurst(fake.ctx, {
      direction: 1,
      rng: fixedRng(0),
      allowReverse: false,
      distancePx: 600,
      smoothWheel: true,
      smoothDurationMinMs: 100,
      smoothDurationMaxMs: 100,
      frameMs: 5,
    })
    const downs = fake.state.wheels.filter((d) => d > 0)
    expect(downs.length).toBeGreaterThanOrEqual(10)
    expect(downs.reduce((sum, d) => sum + d, 0)).toBeGreaterThanOrEqual(600)
    expect(fake.state.wheels.some((d) => d < 0)).toBe(false)
  })

  it('smoothScrollBy：原生平滑滚动发起成功并等待停止', async () => {
    const page = {
      evaluate: async (fn: () => unknown) => {
        if (fn.toString().includes('scrollTo')) return true
        return 0
      },
      waitForTimeout: async () => {},
      locator: () => ({ count: async () => 0 }),
    }
    await expect(smoothScrollBy({ page } as never, 320)).resolves.toBe(true)
  })

  it('弹窗可见：不移动、不滚动，返回 false', async () => {
    const wheels: number[] = []
    const ctx = {
      page: {
        locator: () => ({ count: async () => 1 }),
        mouse: {
          move: async () => {},
          wheel: async (_dx: number, dy: number) => { wheels.push(dy) },
        },
        evaluate: async () => ({ width: 1280, height: 800 }),
      },
    } as never
    await expect(humanScrollBurst(ctx, { direction: 1, rng: fixedRng(0) })).resolves.toBe(false)
    expect(wheels).toHaveLength(0)
  })
})
