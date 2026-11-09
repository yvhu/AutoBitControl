import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { XDailyActivityTask } from '../src/tasks/social/x-daily-activity'
import { TaskContext } from '../src/tasks/base'

interface FakeTweet {
  text: string
  y: number
  liked?: boolean
  likeThrows?: boolean
  noUnlikeUpdate?: boolean
}

/** 顺序 rng：按给定序列返回，耗尽后返回 0（用于固定时长/轮数/点赞上限） */
function seqRng(values: number[]): () => number {
  let i = 0
  return () => (i < values.length ? values[i++] : 0)
}

/** 最小假 locator：present 为函数时每次求值，模拟点击后状态翻转 */
function fakeLocator(present: () => boolean, click: () => Promise<void> = async () => {}) {
  return {
    count: async () => (present() ? 1 : 0),
    isVisible: async () => present(),
    click,
    first: () => fakeLocator(present, click),
  }
}

/** 假 X 页面：只实现任务用到的 locator/mouse/evaluate/screenshot */
function makeXPage(opts: { loggedIn?: boolean; tweets?: FakeTweet[] } = {}) {
  const tweets = opts.tweets ?? []
  const loggedIn = opts.loggedIn ?? true
  const state = { wheels: [] as number[], moves: [] as Array<{ x: number; y: number }>, screenshots: 0 }

  const tweetLocator = (i: number) => {
    const tweet = tweets[i]
    return {
      ...fakeLocator(() => true),
      boundingBox: async () => ({ x: 10, y: tweet.y, width: 500, height: 220 }),
      textContent: async () => tweet.text,
      hover: async () => {},
      locator: (sel: string) => {
        if (sel === 'button[data-testid="like"]') {
          return fakeLocator(() => !tweet.liked, async () => {
            if (tweet.likeThrows) throw new Error('like click failed')
            tweet.liked = true
          })
        }
        if (sel === 'button[data-testid="unlike"]') return fakeLocator(() => Boolean(tweet.liked) && !tweet.noUnlikeUpdate)
        return fakeLocator(() => false)
      },
    }
  }

  const page = {
    goto: vi.fn(async () => {}),
    locator: (sel: string) => {
      if (sel === 'article[data-testid="tweet"]') {
        return {
          ...fakeLocator(() => tweets.length > 0),
          count: async () => tweets.length,
          nth: (i: number) => tweetLocator(i),
        }
      }
      if (sel === '[data-testid="primaryColumn"]' || sel === '[data-testid="SideNav_NewTweet_Button"]') return fakeLocator(() => loggedIn)
      if (sel === '[data-testid="loginButton"]' || sel === 'input[name="text"]') return fakeLocator(() => !loggedIn)
      return fakeLocator(() => false)
    },
    mouse: {
      move: async (x: number, y: number) => { state.moves.push({ x, y }) },
      wheel: async (_dx: number, dy: number) => { state.wheels.push(dy) },
    },
    evaluate: async () => ({ width: 1280, height: 800 }),
    waitForTimeout: async (ms: number) => { await new Promise((r) => setTimeout(r, ms)) },
    screenshot: async () => { state.screenshots++ },
    context: () => ({ pages: () => [] }),
  }

  return { page, state, tweets }
}

function makeCtx(page: ReturnType<typeof makeXPage>['page'], task: XDailyActivityTask): TaskContext {
  return new TaskContext({
    page: page as never,
    task,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: mkdtempSync(join(tmpdir(), 'x-activity-test-')),
    walletPasswords: {},
  })
}

describe('XDailyActivityTask', () => {
  it('出现时间线错误提示时点击 Retry 恢复', async () => {
    const task = new XDailyActivityTask()
    let errorVisible = true
    let retryClicks = 0
    const page = {
      locator: (selector: string) => {
        if (selector === 'text=Something went wrong. Try reloading.') {
          return fakeLocator(() => errorVisible)
        }
        if (selector === 'button:has-text("Retry")') {
          return fakeLocator(() => errorVisible, async () => {
            retryClicks++
            errorVisible = false
          })
        }
        return fakeLocator(() => false)
      },
      waitForTimeout: async () => {},
      reload: vi.fn(async () => {}),
    }
    const ctx = makeCtx(page as never, task)
    const recover = (task as unknown as { recoverTimelineError(ctx: TaskContext): Promise<boolean> }).recoverTimelineError.bind(task)

    await expect(recover(ctx)).resolves.toBe(true)
    expect(retryClicks).toBe(1)
    expect(page.reload).not.toHaveBeenCalled()
  })

  it('错误提示没有 Retry 按钮时回退到页面刷新', async () => {
    const task = new XDailyActivityTask()
    let errorVisible = true
    const page = {
      locator: (selector: string) => {
        if (selector === 'text=Something went wrong. Try reloading.') return fakeLocator(() => errorVisible)
        if (selector === 'button:has-text("Retry")') return fakeLocator(() => false)
        return fakeLocator(() => false)
      },
      waitForTimeout: async () => {},
      reload: vi.fn(async () => { errorVisible = false }),
    }
    const ctx = makeCtx(page as never, task)
    const recover = (task as unknown as { recoverTimelineError(ctx: TaskContext): Promise<boolean> }).recoverTimelineError.bind(task)

    await expect(recover(ctx)).resolves.toBe(true)
    expect(page.reload).toHaveBeenCalledTimes(1)
  })

  it('时间线框裁剪到视口：滚动后负 top 不会放大距离', async () => {
    const task = new XDailyActivityTask()
    const page = {
      locator: (sel: string) => {
        if (sel === '[data-testid="primaryColumn"]') {
          return { first: () => ({ boundingBox: async () => ({ x: 0, y: -800, width: 600, height: 2000 }) }) }
        }
        return { first: () => ({}) }
      },
      evaluate: async () => ({ width: 1280, height: 800 }),
    }
    const ctx = makeCtx(page as never, task)
    const box = await (task as unknown as { getTimelineBox(ctx: TaskContext): Promise<{ x: number; y: number; width: number; height: number } | null> }).getTimelineBox(ctx)
    expect(box).toEqual({ x: 0, y: 0, width: 600, height: 800 })
  })

  it('未登录：截图并抛出明确错误', async () => {
    const task = new XDailyActivityTask()
    const fake = makeXPage({ loggedIn: false })
    const ctx = makeCtx(fake.page, task)
    await expect(task.run(ctx)).rejects.toThrow('未登录')
    expect(fake.state.screenshots).toBe(1)
  })

  it('已登录：滚动达到下限，点赞不超过上限，并落成功截图', async () => {
    vi.useFakeTimers()
    try {
      const task = new XDailyActivityTask(seqRng([0, 0, 0.9]))
      const fake = makeXPage({
        tweets: [
          { text: '普通推文一', y: 120 },
          { text: '普通推文二', y: 420 },
        ],
      })
      const ctx = makeCtx(fake.page, task)
      const running = task.run(ctx)
      await vi.advanceTimersByTimeAsync(200_000)
      await vi.runAllTimersAsync()
      await expect(running).resolves.toBeUndefined()
      expect(fake.state.wheels.length).toBeGreaterThanOrEqual(8)
      expect(fake.tweets.filter((t) => t.liked)).toHaveLength(2)
      expect(fake.state.screenshots).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('跳过推广推文，只点赞普通推文', async () => {
    const task = new XDailyActivityTask(seqRng([0]))
    const fake = makeXPage({
      tweets: [
        { text: 'Promoted 广告', y: 100 },
        { text: '普通推文', y: 300 },
      ],
    })
    const ctx = makeCtx(fake.page, task)
    const liked = await (task as unknown as { tryLikeVisibleTweet(ctx: TaskContext): Promise<boolean> }).tryLikeVisibleTweet(ctx)
    expect(liked).toBe(true)
    expect(fake.tweets[0].liked).toBeFalsy()
    expect(fake.tweets[1].liked).toBe(true)
  })

  it('点击成功但 unlike 未及时出现：仍计入点赞成功', async () => {
    const task = new XDailyActivityTask(seqRng([0]))
    const fake = makeXPage({
      tweets: [{ text: '普通推文', y: 200, noUnlikeUpdate: true }],
    })
    const ctx = makeCtx(fake.page, task)
    await expect(
      (task as unknown as { tryLikeVisibleTweet(ctx: TaskContext): Promise<boolean> }).tryLikeVisibleTweet(ctx),
    ).resolves.toBe(true)
    expect(fake.tweets[0].liked).toBe(true)
  })

  it('跳过法文推广推文（Sponsorisé），只点赞普通推文', async () => {
    const task = new XDailyActivityTask(seqRng([0]))
    const fake = makeXPage({
      tweets: [
        { text: 'Sponsorisé par une marque', y: 100 },
        { text: '普通推文', y: 300 },
      ],
    })
    const ctx = makeCtx(fake.page, task)
    const liked = await (task as unknown as { tryLikeVisibleTweet(ctx: TaskContext): Promise<boolean> }).tryLikeVisibleTweet(ctx)
    expect(liked).toBe(true)
    expect(fake.tweets[0].liked).toBeFalsy()
    expect(fake.tweets[1].liked).toBe(true)
  })

  it('跳过德/日/繁体/土文推广推文，只点赞普通推文', async () => {
    const task = new XDailyActivityTask(seqRng([0]))
    const fake = makeXPage({
      tweets: [
        { text: 'Anzeige von einer Marke', y: 80 },
        { text: '広告ツイート', y: 160 },
        { text: '廣告貼文', y: 240 },
        { text: 'Sponsorlu içerik', y: 320 },
        { text: '普通推文', y: 400 },
      ],
    })
    const ctx = makeCtx(fake.page, task)
    const liked = await (task as unknown as { tryLikeVisibleTweet(ctx: TaskContext): Promise<boolean> }).tryLikeVisibleTweet(ctx)
    expect(liked).toBe(true)
    expect(fake.tweets.slice(0, 4).some((t) => t.liked)).toBe(false)
    expect(fake.tweets[4].liked).toBe(true)
  })

  it('点赞点击失败：只告警，方法返回 false 不抛错', async () => {
    const task = new XDailyActivityTask(seqRng([0]))
    const fake = makeXPage({
      tweets: [{ text: '普通推文', y: 200, likeThrows: true }],
    })
    const ctx = makeCtx(fake.page, task)
    await expect(
      (task as unknown as { tryLikeVisibleTweet(ctx: TaskContext): Promise<boolean> }).tryLikeVisibleTweet(ctx),
    ).resolves.toBe(false)
  })
})
