import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscordDailyActivityTask, DISCORD_MESSAGE_CHANNEL_URLS, isMessageChannelAllowed, pickMessageForProfile } from '../src/tasks/social/discord-daily-activity'
import { TaskContext } from '../src/tasks/base'

/** 顺序 rng：按给定序列返回，耗尽后返回 0 */
function seqRng(values: number[]): () => number {
  let i = 0
  return () => (i < values.length ? values[i++] : 0)
}

/** 最小假 locator */
function fakeLocator(present: () => boolean, click: () => Promise<void> = async () => {}) {
  return {
    count: async () => (present() ? 1 : 0),
    isVisible: async () => present(),
    click,
    first: () => fakeLocator(present, click),
  }
}

/** 假 Discord 页面：只实现任务用到的 locator/mouse/keyboard/evaluate/screenshot */
function makeDiscordPage(opts: {
  loggedIn?: boolean
  chatLoaded?: boolean
  messages?: Array<{ y: number }>
  chatSelector?: 'data-list' | 'role-log'
  jumpButtonVisible?: boolean
  messageInputVisible?: boolean
} = {}) {
  const loggedIn = opts.loggedIn ?? true
  const chatLoaded = opts.chatLoaded ?? true
  const messages = opts.messages ?? []
  const state = { wheels: [] as number[], screenshots: 0, keys: [] as string[], jumpClicks: 0, typedMessages: [] as string[] }

  const messageLocator = (i: number) => ({
    ...fakeLocator(() => true),
    boundingBox: async () => ({ x: 20, y: messages[i].y, width: 600, height: 80 }),
    hover: async () => {},
  })

  const inputLocator = {
    first: () => inputLocator,
    count: async () => (opts.messageInputVisible ? 1 : 0),
    isVisible: async () => Boolean(opts.messageInputVisible),
    click: async () => {},
    pressSequentially: async (text: string) => { state.typedMessages.push(text) },
  }

  const page = {
    goto: vi.fn(async () => {}),
    locator: (sel: string) => {
      if (sel.includes('data-slate-editor') || sel.includes('contenteditable')) return inputLocator
      if (sel.includes('message-content')) return { count: async () => (opts.messageInputVisible ? 1 : 0) }
      if (sel.includes('Jump to present') || sel.includes('Aller au présent')) {
        return fakeLocator(() => opts.jumpButtonVisible ?? false, async () => { state.jumpClicks++ })
      }
      if (sel === 'li[id^="chat-messages-"]') {
        return {
          ...fakeLocator(() => messages.length > 0),
          count: async () => messages.length,
          nth: (i: number) => messageLocator(i),
        }
      }
      if (sel.includes('role="log"') || sel.includes('data-list-id="chat-messages"')) {
        if (opts.chatSelector === 'role-log' && sel.includes('role="log"')) return fakeLocator(() => loggedIn && chatLoaded)
        if ((opts.chatSelector ?? 'data-list') === 'data-list' && sel.includes('data-list-id="chat-messages"')) return fakeLocator(() => loggedIn && chatLoaded)
        return fakeLocator(() => false)
      }
      if (sel.includes('scrollerInner') || sel.includes('messagesWrapper')) return fakeLocator(() => false)
      if (sel === 'input[name="email"]' || sel === 'button:has-text("Log In")' || sel === 'button:has-text("登录")') return fakeLocator(() => !loggedIn)
      return fakeLocator(() => false)
    },
    mouse: {
      move: async () => {},
      wheel: async (_dx: number, dy: number) => { state.wheels.push(dy) },
    },
    keyboard: {
      press: async (key: string) => { state.keys.push(key) },
    },
    evaluate: async () => ({ width: 1280, height: 800 }),
    url: () => 'https://discord.com/channels/100/200',
    waitForTimeout: async (ms: number) => { await new Promise((r) => setTimeout(r, ms)) },
    screenshot: async () => { state.screenshots++ },
    context: () => ({ pages: () => [] }),
  }

  return { page, state }
}

function makeCtx(page: ReturnType<typeof makeDiscordPage>['page'], task: DiscordDailyActivityTask): TaskContext {
  return new TaskContext({
    page: page as never,
    task,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: mkdtempSync(join(tmpdir(), 'discord-activity-test-')),
    walletPasswords: {},
  })
}

const CHANNEL = DISCORD_MESSAGE_CHANNEL_URLS[0] ?? 'https://discord.com/channels/100/200'

describe('DiscordDailyActivityTask', () => {
  it('未配置频道：直接抛出明确错误，不打开页面', async () => {
    const task = new DiscordDailyActivityTask([])
    const fake = makeDiscordPage()
    const ctx = makeCtx(fake.page, task)
    await expect(task.run(ctx)).rejects.toThrow('DISCORD_CHANNEL_URLS')
    expect(fake.page.goto).not.toHaveBeenCalled()
  })

  it('未登录：截图并抛出明确错误', async () => {
    const task = new DiscordDailyActivityTask([CHANNEL])
    const fake = makeDiscordPage({ loggedIn: false })
    const ctx = makeCtx(fake.page, task)
    await expect(task.run(ctx)).rejects.toThrow('未登录')
    expect(fake.state.screenshots).toBeGreaterThanOrEqual(1)
  })

  it('已登录：向上滚动阅读、贴表情成功、落成功截图', async () => {
    vi.useFakeTimers()
    try {
      const task = new DiscordDailyActivityTask([CHANNEL], seqRng([1, 1, 1]))
      const fake = makeDiscordPage({
        messages: [
          { y: 120 },
          { y: 260 },
          { y: 400 },
        ],
        messageInputVisible: true,
      })
      const ctx = makeCtx(fake.page, task)
      const running = task.run(ctx)
      await vi.advanceTimersByTimeAsync(200_000)
      await vi.runAllTimersAsync()
      await expect(running).resolves.toBeUndefined()
      expect(fake.state.wheels.filter((d) => d < 0).length).toBeGreaterThanOrEqual(4)
      expect(fake.state.wheels.some((d) => d > 0)).toBe(true)
      expect(fake.state.typedMessages).toHaveLength(1)
      expect(fake.state.keys).toContain('Enter')
      expect(fake.state.screenshots).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('发消息配置：未配置频道或文案时不发', () => {
    expect(isMessageChannelAllowed(CHANNEL, [])).toBe(false)
    expect(isMessageChannelAllowed(CHANNEL, [CHANNEL])).toBe(true)
    expect(pickMessageForProfile('06', [])).toBeNull()
  })

  it('发消息文案：不同窗口轮换', () => {
    const pool = ['a', 'b', 'c']
    const a = pickMessageForProfile('06', pool, 1)
    const b = pickMessageForProfile('07', pool, 1)
    expect(pool).toContain(a)
    expect(pool).toContain(b)
    expect(a).not.toBe(b)
  })

  it('发消息：逐字输入并回车，验证成功后返回 true', async () => {
    const task = new DiscordDailyActivityTask([CHANNEL])
    const typed: string[] = []
    const keys: string[] = []
    const inputLocator = {
      first: () => inputLocator,
      count: async () => 1,
      isVisible: async () => true,
      click: async () => {},
      pressSequentially: async (text: string) => { typed.push(text) },
    }
    const page = {
      locator: (sel: string) => {
        if (sel.includes('data-slate-editor') || sel.includes('contenteditable')) return inputLocator
        if (sel.includes('message-content')) return { count: async () => 1 }
        return { count: async () => 0, first: () => ({ count: async () => 0, isVisible: async () => false }) }
      },
      keyboard: { press: async (key: string) => { keys.push(key) } },
      waitForTimeout: async () => {},
    }
    const ctx = makeCtx(page as never, task)
    const ok = await (task as unknown as { sendChannelMessage(ctx: TaskContext, text: string): Promise<boolean> }).sendChannelMessage(ctx, 'hello')
    expect(ok).toBe(true)
    expect(typed).toEqual(['hello'])
    expect(keys).toContain('Enter')
  })

  it('打开频道后先点「Jump to present」跳到最新', async () => {
    const task = new DiscordDailyActivityTask([CHANNEL], seqRng([0]))
    const fake = makeDiscordPage({ jumpButtonVisible: true })
    const ctx = makeCtx(fake.page, task)
    await (task as unknown as { jumpToLatest(ctx: TaskContext): Promise<void> }).jumpToLatest(ctx)
    expect(fake.state.jumpClicks).toBe(1)
  })

  it('聊天区只有 role=log 时也能识别（回退选择器）', async () => {
    vi.useFakeTimers()
    try {
      const task = new DiscordDailyActivityTask([CHANNEL], seqRng([0, 0, 0]))
      const fake = makeDiscordPage({ chatSelector: 'role-log', messages: [{ y: 120 }] })
      const ctx = makeCtx(fake.page, task)
      const running = task.run(ctx)
      await vi.advanceTimersByTimeAsync(200_000)
      await vi.runAllTimersAsync()
      await expect(running).resolves.toBeUndefined()
      expect(fake.state.screenshots).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

})
