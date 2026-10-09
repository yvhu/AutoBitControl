import { describe, it, expect } from 'vitest'
import { probeLocator, probeVisible, raceProbes, type Probe } from '../src/automation/dom'

/** 假 locator：按 visible/count 配置行为 */
function locator(opts: { count?: number; visible?: boolean; waitDelayMs?: number; never?: boolean }) {
  return {
    first() { return this },
    count: async () => opts.count ?? 0,
    isVisible: async () => opts.visible ?? true,
    waitFor: async ({ timeout }: { state?: string; timeout?: number }) =>
      new Promise<void>((resolve, reject) => {
        if (opts.never) setTimeout(() => reject(new Error('timeout')), 10)
        else setTimeout(resolve, opts.waitDelayMs ?? 5)
      }),
  }
}

/** 假 page：selector -> 行为；text -> 行为 */
function page(map: Record<string, { count?: number; visible?: boolean; waitDelayMs?: number; never?: boolean }>) {
  return {
    locator: (sel: string) => locator(map[sel] ?? { count: 0 }),
    getByText: (text: string) => locator(map[text] ?? { count: 0 }),
    waitForTimeout: async () => {},
    reload: async () => {},
    url: () => 'https://x.test/',
  }
}

describe('dom probe/race', () => {
  it('probeLocator：text 走 getByText，selector 走 locator', () => {
    const p = page({ '文案A': { count: 1 }, '#id': { count: 1 } }) as never
    expect(probeLocator(p, { text: '文案A' })).toBeTruthy()
    expect(probeLocator(p, { selector: '#id' })).toBeTruthy()
  })

  it('probeVisible：不存在/不可见/异常均 false，正常 true', async () => {
    expect(await probeVisible(page({ '#a': { count: 0 } }) as never, { selector: '#a' })).toBe(false)
    expect(await probeVisible(page({ '#a': { count: 1, visible: false } }) as never, { selector: '#a' })).toBe(false)
    expect(await probeVisible(page({ '#a': { count: 1, visible: true } }) as never, { selector: '#a' })).toBe(true)
  })

  it('raceProbes：先出现者返回其键', async () => {
    const p = page({ '快': { waitDelayMs: 5 }, '慢': { waitDelayMs: 500, never: true } }) as never
    const r = await raceProbes(p, [['fast', { text: '快' }], ['slow', { text: '慢' }]], 1000)
    expect(r).toBe('fast')
  })

  it('raceProbes：都不出现返回 null', async () => {
    const p = page({ 'x': { never: true } }) as never
    expect(await raceProbes(p, [['x', { text: 'x' }]], 50)).toBeNull()
  })

  it('raceProbes：空 entries 立即返回 null（不依赖超时）', async () => {
    const p = page({}) as never
    const start = Date.now()
    expect(await raceProbes(p, [], 1000)).toBeNull()
    expect(Date.now() - start).toBeLessThan(500)
  })
})
