import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dismissBlockingOverlays } from '../src/tasks/social/overlay'
import { TaskContext } from '../src/tasks/base'

/** 最小假 locator：present 控制是否可见，click 记录选择器 */
function fakeLocator(present: () => boolean, click: () => Promise<void> = async () => {}) {
  return {
    count: async () => (present() ? 1 : 0),
    isVisible: async () => present(),
    click,
    first: () => fakeLocator(present, click),
  }
}

/** 假页面：只实现 helper 用到的 locator/evaluate/keyboard/waitForTimeout */
function makePage(opts: {
  overlayVisible?: boolean
  closeVisible?: boolean
  subscribeVisible?: boolean
  cookieVisible?: boolean
  frenchOnly?: boolean
} = {}) {
  const overlayVisible = opts.overlayVisible ?? false
  const closeVisible = opts.closeVisible ?? false
  const subscribeVisible = opts.subscribeVisible ?? false
  const cookieVisible = opts.cookieVisible ?? false
  const state = { clicks: [] as string[], escapes: 0 }

  const page = {
    locator: (sel: string) => {
      if (sel.includes(':visible') && (sel.includes('[role="dialog"]') || sel.includes('[data-testid="sheetDialog"]') || sel.includes('[data-testid="BottomBar"]') || sel.includes('[data-testid="interstitialGraphic"]') || sel.includes('cookie'))) {
        return fakeLocator(() => overlayVisible)
      }
      if (sel === '[role="dialog"]' || sel === '[data-testid="sheetDialog"]' || sel === '[data-testid="BottomBar"]' || sel === '[class*="cookie" i]' || sel === '[id*="cookie" i]') {
        return fakeLocator(() => overlayVisible)
      }
      if (sel.includes('Fermer') || sel.includes('Pas maintenant') || sel.includes('Plus tard') || sel.includes('Non merci') || sel.includes('Ignorer')) {
        return fakeLocator(() => closeVisible, async () => { state.clicks.push(sel) })
      }
      if (sel.includes('aria-label="Close"') || sel.includes('Not now') || sel.includes('Maybe later') || sel.includes('No thanks') || sel.includes('Dismiss') || sel.includes('关闭') || sel.includes('暂不') || sel.includes('以后再说') || sel.includes('跳过')) {
        return fakeLocator(() => closeVisible && !opts.frenchOnly, async () => { state.clicks.push(sel) })
      }
      if (sel.includes('Accept all cookies') || sel.includes('接受全部 Cookie') || sel.includes('Accept All') || sel.includes('Reject non-essential') || sel.includes('Tout accepter') || sel.includes('Accepter tous les cookies') || sel.includes('Refuser les cookies non essentiels') || sel.includes('拒绝非必要')) {
        return fakeLocator(() => cookieVisible, async () => { state.clicks.push(sel) })
      }
      if (sel.includes('Subscribe') || sel.includes('Upgrade') || sel.includes('订阅') || sel.includes('升级')) {
        return fakeLocator(() => subscribeVisible, async () => { state.clicks.push(sel) })
      }
      return fakeLocator(() => false)
    },
    evaluate: async () => 'Subscribe to Premium',
    keyboard: { press: async () => { state.escapes++ } },
    waitForTimeout: async () => {},
  }

  return { page, state }
}

function makeCtx(page: ReturnType<typeof makePage>['page']): TaskContext {
  return new TaskContext({
    page: page as never,
    task: { meta: { key: 'x-daily-activity', name: 'X 日常活跃', url: 'https://x.com/home' } } as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: mkdtempSync(join(tmpdir(), 'social-overlay-test-')),
    walletPasswords: {},
  })
}

describe('dismissBlockingOverlays', () => {
  it('有弹窗和关闭按钮：点击关闭并返回关闭数', async () => {
    const fake = makePage({ overlayVisible: true, closeVisible: true })
    const ctx = makeCtx(fake.page)
    await expect(dismissBlockingOverlays(ctx)).resolves.toBeGreaterThanOrEqual(1)
    expect(fake.state.clicks.length).toBeGreaterThanOrEqual(1)
    expect(fake.state.clicks[0]).toContain('Close')
  })

  it('只有订阅按钮：绝不点订阅，按 Esc 兜底并返回 0', async () => {
    const fake = makePage({ overlayVisible: true, subscribeVisible: true })
    const ctx = makeCtx(fake.page)
    await expect(dismissBlockingOverlays(ctx)).resolves.toBe(0)
    expect(fake.state.clicks).toHaveLength(0)
    expect(fake.state.escapes).toBeGreaterThanOrEqual(1)
  })

  it('没有弹窗：不点击、不按 Esc，返回 0', async () => {
    const fake = makePage()
    const ctx = makeCtx(fake.page)
    await expect(dismissBlockingOverlays(ctx)).resolves.toBe(0)
    expect(fake.state.clicks).toHaveLength(0)
    expect(fake.state.escapes).toBe(0)
  })

  it('法文弹窗：点击 Fermer 关闭', async () => {
    const fake = makePage({ overlayVisible: true, closeVisible: true, frenchOnly: true })
    const ctx = makeCtx(fake.page)
    await expect(dismissBlockingOverlays(ctx)).resolves.toBeGreaterThanOrEqual(1)
    expect(fake.state.clicks[0]).toContain('Fermer')
  })

  it('X 广告个性化插屏：默认点 Turn on personalized ads，不点 Keep less relevant ads', async () => {
    const state = { clicks: [] as string[] }
    const page = {
      locator: (sel: string) => {
        if (sel === '[data-testid="interstitialGraphic"]' || (sel.includes(':visible') && sel.includes('interstitialGraphic'))) return fakeLocator(() => true)
        if (sel.includes('Keep less relevant ads')) {
          return fakeLocator(() => true, async () => { state.clicks.push(sel) })
        }
        if (sel.includes('Turn on personalized ads')) {
          return fakeLocator(() => true, async () => { state.clicks.push(sel) })
        }
        return fakeLocator(() => false)
      },
      evaluate: async () => 'You’re in control',
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
    }
    const ctx = makeCtx(page)
    await expect(dismissBlockingOverlays(ctx)).resolves.toBeGreaterThanOrEqual(1)
    expect(state.clicks[0]).toContain('Turn on personalized ads')
    expect(state.clicks.some((s) => s.includes('Keep less relevant ads'))).toBe(false)
  })

  it('X 广告个性化插屏：显式 opt-out 时只点 Keep less relevant ads', async () => {
    const state = { clicks: [] as string[] }
    const page = {
      locator: (sel: string) => {
        if (sel === '[data-testid="interstitialGraphic"]' || (sel.includes(':visible') && sel.includes('interstitialGraphic'))) return fakeLocator(() => true)
        if (sel.includes('Keep less relevant ads')) {
          return fakeLocator(() => true, async () => { state.clicks.push(sel) })
        }
        if (sel.includes('Turn on personalized ads')) {
          return fakeLocator(() => true, async () => { state.clicks.push(sel) })
        }
        return fakeLocator(() => false)
      },
      evaluate: async () => 'You’re in control',
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
    }
    const ctx = makeCtx(page)
    await expect(dismissBlockingOverlays(ctx, { xAdChoice: 'keep-less-relevant' })).resolves.toBeGreaterThanOrEqual(1)
    expect(state.clicks[0]).toContain('Keep less relevant ads')
    expect(state.clicks.some((s) => s.includes('Turn on personalized ads'))).toBe(false)
  })

  it.each(['Schließen', '閉じる', '關閉'])('多语言关闭：%s', async (term) => {
    const state = { clicks: [] as string[] }
    const page = {
      locator: (sel: string) => {
        if ((sel.includes(':visible') && (sel.includes('[role="dialog"]') || sel.includes('sheetDialog') || sel.includes('BottomBar'))) || sel === '[role="dialog"]' || sel === '[data-testid="sheetDialog"]' || sel === '[data-testid="BottomBar"]' || sel === '[class*="cookie" i]' || sel === '[id*="cookie" i]') {
          return fakeLocator(() => true)
        }
        if (sel.includes(`has-text("${term}")`)) {
          return fakeLocator(() => true, async () => { state.clicks.push(sel) })
        }
        return fakeLocator(() => false)
      },
      evaluate: async () => 'dialog',
      keyboard: { press: async () => {} },
      waitForTimeout: async () => {},
    }
    const ctx = makeCtx(page)
    await expect(dismissBlockingOverlays(ctx)).resolves.toBeGreaterThanOrEqual(1)
    expect(state.clicks[0]).toContain(term)
  })

  it('Cookie 横幅：点击接受/拒绝类按钮，返回关闭数', async () => {
    const fake = makePage({ overlayVisible: true, cookieVisible: true })
    const ctx = makeCtx(fake.page)
    await expect(dismissBlockingOverlays(ctx)).resolves.toBeGreaterThanOrEqual(1)
    expect(fake.state.clicks.length).toBeGreaterThanOrEqual(1)
    expect(fake.state.clicks[0]).toMatch(/Cookie|Accept|cookies/)
  })
})
