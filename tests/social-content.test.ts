import { describe, it, expect } from 'vitest'
import {
  computeDiscordDwellMs,
  computeXDwellMs,
  isDiscordTooOld,
  readDiscordVisibleContent,
  readXLoadState,
  readXTimelineSignature,
  readXVisibleContent,
  type DiscordContentProfile,
  type XContentProfile,
} from '../src/tasks/social/content'

const rng = () => 0.5

function xProfile(over: Partial<XContentProfile> = {}): XContentProfile {
  return { index: 0, kind: 'text', textLength: 50, collapsed: false, videoDurationSec: null, top: 100, height: 200, ...over }
}

function discordProfile(over: Partial<DiscordContentProfile> = {}): DiscordContentProfile {
  return { index: 0, kind: 'text', textLength: 50, ageDays: 1, top: 100, height: 80, ...over }
}

describe('computeXDwellMs', () => {
  it('折叠长文按长文停留（即使可见文字很少）', () => {
    expect(computeXDwellMs(xProfile({ textLength: 40, collapsed: true }), rng)).toBeGreaterThanOrEqual(5600)
  })

  it('短文字停留明显短于长文', () => {
    expect(computeXDwellMs(xProfile({ textLength: 30 }), rng)).toBeLessThan(6000)
  })

  it('图片停留长于短文字', () => {
    expect(computeXDwellMs(xProfile({ kind: 'image', textLength: 0 }), rng)).toBeGreaterThan(3000)
  })

  it('视频按 duration 计算但限制在 8-30 秒', () => {
    const ms = computeXDwellMs(xProfile({ kind: 'video', textLength: 0, videoDurationSec: 100 }), rng)
    expect(ms).toBeGreaterThanOrEqual(8000)
    expect(ms).toBeLessThanOrEqual(30000)
  })
})

describe('computeDiscordDwellMs / isDiscordTooOld', () => {
  it('超过 7 天：不停留', () => {
    const profile = discordProfile({ ageDays: 10 })
    expect(isDiscordTooOld(profile)).toBe(true)
    expect(computeDiscordDwellMs(profile, rng)).toBe(0)
  })

  it('3-7 天：快速浏览', () => {
    expect(computeDiscordDwellMs(discordProfile({ ageDays: 5 }), rng)).toBeLessThanOrEqual(5000)
  })

  it('3 天内短文字：正常阅读', () => {
    expect(computeDiscordDwellMs(discordProfile({ ageDays: 1, textLength: 40 }), rng)).toBeGreaterThanOrEqual(2000)
  })

  it('无时间戳：按很短停留处理', () => {
    expect(computeDiscordDwellMs(discordProfile({ ageDays: null }), rng)).toBeLessThanOrEqual(3000)
  })
})

describe('readVisibleContent', () => {
  it('X：解析 evaluate 返回的内容档案', async () => {
    const ctx = {
      page: {
        evaluate: async () => [
          { index: 0, kind: 'video', textLength: 10, collapsed: false, videoDurationSec: 20, top: 10, height: 300 },
        ],
      },
    } as never
    const items = await readXVisibleContent(ctx)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('video')
  })

  it('Discord：解析 evaluate 返回的内容档案', async () => {
    const ctx = {
      page: {
        evaluate: async () => [
          { index: 0, kind: 'image', textLength: 0, ageDays: 2, top: 10, height: 80 },
        ],
      },
    } as never
    const items = await readDiscordVisibleContent(ctx)
    expect(items).toHaveLength(1)
    expect(items[0].ageDays).toBe(2)
  })

  it('X 加载状态：解析 loading 与推文数量', async () => {
    const ctx = { page: { evaluate: async () => ({ loading: true, articleCount: 0 }) } } as never
    await expect(readXLoadState(ctx)).resolves.toEqual({ loading: true, articleCount: 0 })
  })

  it('X 时间线标识：解析首尾推文链接', async () => {
    const ctx = { page: { evaluate: async () => '/a/status/1|/b/status/2' } } as never
    await expect(readXTimelineSignature(ctx)).resolves.toBe('/a/status/1|/b/status/2')
  })

  it('X 加载/标识读取异常结构：返回 null', async () => {
    const ctx = { page: { evaluate: async () => ({ width: 1280, height: 800 }) } } as never
    await expect(readXLoadState(ctx)).resolves.toBeNull()
    await expect(readXTimelineSignature(ctx)).resolves.toBeNull()
  })

  it('evaluate 返回异常结构：返回空数组，调用方走旧逻辑', async () => {
    const ctx = { page: { evaluate: async () => ({ width: 1280, height: 800 }) } } as never
    await expect(readXVisibleContent(ctx)).resolves.toEqual([])
    await expect(readDiscordVisibleContent(ctx)).resolves.toEqual([])
  })
})
