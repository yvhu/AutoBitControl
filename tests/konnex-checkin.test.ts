import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KonnexCheckinTask } from '../src/tasks/konnex-checkin'
import { TaskContext } from '../src/tasks/base'

/** 可配置假页面：textDelay 为 null 表示永不出现（100ms 后拒绝，避免抢在出现项之前赢得竞速） */
function makeFakePage(opts: {
  btnVisible: boolean
  bannerVisible: boolean
  resetVisible: boolean
  successTextDelay: number | null
  doneTextDelay: number | null
  cardText?: string
  headings?: string
  screenshotFails?: boolean
}) {
  const clicks: string[] = []
  const textDelays: Record<string, number | null> = {
    'Check-In Succeeded!': opts.successTextDelay,
    'Great job!': opts.doneTextDelay,
  }
  const isVisible = async (sel: string): Promise<boolean> => {
    if (sel.includes('Great job!')) return opts.bannerVisible
    if (sel.includes('RESETS IN')) return opts.resetVisible
    return opts.btnVisible
  }
  return {
    clicks,
    locator: (sel: string) => ({
      first: () => ({
        count: async () => ((await isVisible(sel)) ? 1 : 0),
        isVisible: () => isVisible(sel),
        click: vi.fn(async () => { clicks.push(sel) }),
      }),
    }),
    getByText: (text: string) => ({
      first: () => ({
        waitFor: () => {
          const delay = textDelays[text]
          if (delay === undefined || delay === null) return new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`等待文案超时: ${text}`)), 100))
          return Promise.resolve()
        },
      }),
    }),
    waitForTimeout: async (ms: number) => { await new Promise((r) => setTimeout(r, ms)) },
    evaluate: async (fn: () => unknown) => {
      const exec = new Function('document', `return (${fn.toString()})()`)
      return exec({
        querySelector: () => (opts.cardText === undefined ? null : { textContent: opts.cardText }),
        querySelectorAll: () => [{ textContent: opts.headings ?? '' }],
      })
    },
    screenshot: async () => {
      if (opts.screenshotFails) throw new Error('page.screenshot: Timeout 30000ms exceeded')
      return '/tmp/x.png'
    },
  }
}

function makeCtx(page: ReturnType<typeof makeFakePage>): TaskContext {
  return new TaskContext({
    page: page as never,
    task: new KonnexCheckinTask(),
    human: {} as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: mkdtempSync(join(tmpdir(), 'konnex-test-')),
    walletPasswords: {},
  })
}

const helpers = new KonnexCheckinTask() as unknown as {
  checkin(ctx: TaskContext): Promise<void>
  checkinDone(ctx: TaskContext): Promise<boolean>
}

describe('KonnexCheckinTask 签到逻辑', () => {
  it('checkin：点击后成功弹窗出现 → 完成', async () => {
    const page = makeFakePage({ btnVisible: true, bannerVisible: false, resetVisible: false, successTextDelay: 0, doneTextDelay: null })
    const ctx = makeCtx(page)
    await expect(helpers.checkin(ctx)).resolves.toBeUndefined()
    expect(page.clicks).toContain('button:has-text("Check in")')
  })

  it('checkin：成功截图超时失败 → 任务仍成功（真机实测：站点动画导致 CDP 截图挂起）', async () => {
    const ctx = makeCtx(makeFakePage({ btnVisible: true, bannerVisible: false, resetVisible: false, successTextDelay: 0, doneTextDelay: null, screenshotFails: true }))
    await expect(helpers.checkin(ctx)).resolves.toBeUndefined()
  })

  it('checkin：点击后已签到横幅出现 → 同样算成功', async () => {
    const ctx = makeCtx(makeFakePage({ btnVisible: true, bannerVisible: false, resetVisible: false, successTextDelay: null, doneTextDelay: 0 }))
    await expect(helpers.checkin(ctx)).resolves.toBeUndefined()
  })

  it('checkin：点击后弹窗/横幅均未出现但卡片进入 RESETS IN 暗态 → 算成功', async () => {
    const ctx = makeCtx(makeFakePage({ btnVisible: true, bannerVisible: false, resetVisible: true, successTextDelay: null, doneTextDelay: null }))
    await expect(helpers.checkin(ctx)).resolves.toBeUndefined()
  })

  it('checkin：按钮不存在且卡片显示 Great job! 横幅（当周已签到）→ 完成不点击', async () => {
    const page = makeFakePage({ btnVisible: false, bannerVisible: true, resetVisible: false, successTextDelay: null, doneTextDelay: null })
    const ctx = makeCtx(page)
    await expect(helpers.checkin(ctx)).resolves.toBeUndefined()
    expect(page.clicks).toHaveLength(0)
  })

  it('checkin：按钮不存在且卡片显示 RESETS IN 暗态（横幅已被关闭）→ 完成不点击', async () => {
    const page = makeFakePage({ btnVisible: false, bannerVisible: false, resetVisible: true, successTextDelay: null, doneTextDelay: null })
    const ctx = makeCtx(page)
    await expect(helpers.checkin(ctx)).resolves.toBeUndefined()
    expect(page.clicks).toHaveLength(0)
  })

  it('checkin：按钮与已签到状态均不出现 → 等满预算后抛错', async () => {
    vi.useFakeTimers()
    try {
      const ctx = makeCtx(makeFakePage({ btnVisible: false, bannerVisible: false, resetVisible: false, successTextDelay: null, doneTextDelay: null }))
      const assertion = expect(helpers.checkin(ctx)).rejects.toThrow('签到卡片未出现')
      await vi.advanceTimersByTimeAsync(46_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('checkin：点击后均未出现 → 抛错并带卡片/h1 内容辅助排障', async () => {
    const ctx = makeCtx(makeFakePage({ btnVisible: true, bannerVisible: false, resetVisible: false, successTextDelay: null, doneTextDelay: null, cardText: 'Check In (Weekly)Close', headings: 'Some Modal' }))
    await expect(helpers.checkin(ctx)).rejects.toThrow('点击 Check in 后未出现成功弹窗')
    await expect(helpers.checkin(ctx)).rejects.toThrow('Check In (Weekly)Close')
  })

  it('meta：key/url/钱包/分类正确', () => {
    const t = new KonnexCheckinTask()
    expect(t.meta.key).toBe('konnex-checkin')
    expect(t.meta.url).toBe('https://hub.konnex.world/points')
    expect(t.meta.wallet).toBe('metamask')
    expect(t.meta.category).toBe('checkin')
  })
})
