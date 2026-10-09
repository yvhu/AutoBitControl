/**
 * ShelbyExplorerTask 单测：登录分支 / 账号页上传流程 / 数据源严格模式（注入假 ctx，不连真浏览器）
 * 背景：真机核实（2026-09-07）后选择器/流程已锁定（站内 Petra Web 弹窗静默连接、header 选择器
 * 判定登录态、账号页 Upload Files 入口、隐藏 file input、双签名、选文件后已上传短路：
 * 站点查重报 Blob name already taken 且 Upload 按钮永不启用 → 不点 Upload 直接成功）
 * 新架构（Plan 3c）：登录走 SiteTask.login + ctx.wallet.ensureLoggedIn（竞速 selectors）；
 * 上传直调 ctx.page/ctx.recover，双签走 ctx.wallet.sign；钱包弹窗边界在测试中打桩
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { ShelbyExplorerTask, ALREADY_DONE_TEXT } from '../src/tasks/shelby-explorer'
import { TaskContext } from '../src/tasks/base'

/** 登录态判定用选择器（与任务实现一致，测试按选择器分流 visible 行为） */
const ADDRESS_SELECTOR = 'header button:has-text("0x")'
const CONNECT_SELECTOR = 'header button:has-text("Connect Wallet")'
/** 站内弹窗 Connect（login.entry.confirm） */
const DIALOG_CONNECT_SELECTOR = '[role="dialog"] button:has-text("Connect")'
const UPLOAD_FILES_SELECTOR = 'button:has-text("Upload Files")'
const FILE_INPUT_SELECTOR = '[role="dialog"] input[type="file"]'
const UPLOAD_BUTTON_SELECTOR = '[role="dialog"] button:has-text("Upload")'
const SUCCESS_TEXT = 'All files uploaded successfully'
const UPLOADING_TEXT = 'Uploading files'

/** 假 page 的可配置状态：登录态/上传弹窗/文案计数/点击副作用 */
interface HarnessState {
  addressVisible: boolean
  connectVisible: boolean
  uploadFilesVisible: boolean
  fileInputCount: number
  uploadDisabled: boolean
  textCount: (text: string) => number
  /** 记录 locator(...).first().click() 命中的选择器（断言点击层） */
  clicks: string[]
  /** 点击副作用钩子（如点弹窗 Connect 后置登录态可见） */
  onClick: (selector: string) => void
}

function makeState(overrides: Partial<HarnessState> = {}): HarnessState {
  return {
    addressVisible: true,
    connectVisible: false,
    uploadFilesVisible: true,
    fileInputCount: 1,
    uploadDisabled: false,
    // 默认成功终态：成功文案存在，其余（已上传/上传中/可恢复错误）不出现
    textCount: (t) => (t === SUCCESS_TEXT ? 1 : 0),
    clicks: [],
    onClick: () => {},
    ...overrides,
  }
}

/**
 * 假 page：locator/getByText 按选择器与文案分流；goto/reload 记录调用；
 * waitForTimeout 瞬时返回、context().pages() 为空、url 固定（驱动真实 recover/race 内核）
 */
function makePage(state: HarnessState) {
  const countFor = (sel: string): number => {
    if (sel === ADDRESS_SELECTOR) return state.addressVisible ? 1 : 0
    if (sel === CONNECT_SELECTOR) return state.connectVisible ? 1 : 0
    if (sel === UPLOAD_FILES_SELECTOR) return state.uploadFilesVisible ? 1 : 0
    if (sel === FILE_INPUT_SELECTOR) return state.fileInputCount
    return 1
  }
  const visibleFor = (sel: string): boolean => {
    if (sel === ADDRESS_SELECTOR) return state.addressVisible
    if (sel === CONNECT_SELECTOR) return state.connectVisible
    if (sel === UPLOAD_FILES_SELECTOR) return state.uploadFilesVisible
    return true
  }
  const locator = (sel: string) => {
    const first = {
      count: async () => countFor(sel),
      isVisible: async () => visibleFor(sel),
      isDisabled: async () => (sel === UPLOAD_BUTTON_SELECTOR ? state.uploadDisabled : false),
      click: vi.fn(async () => {
        state.clicks.push(sel)
        state.onClick(sel)
      }),
      setInputFiles: vi.fn(async () => {}),
      waitFor: async () => {
        if (await visibleFor(sel)) return
        throw new Error(`等待元素可见超时: ${sel}`)
      },
    }
    return { first: () => first, count: first.count, isVisible: first.isVisible }
  }
  const getByText = (text: string) => {
    const first = {
      count: async () => state.textCount(text),
      isVisible: async () => state.textCount(text) > 0,
      waitFor: async () => {
        if (state.textCount(text) > 0) return
        throw new Error(`等待文案超时: ${text}`)
      },
    }
    return { first: () => first, count: first.count }
  }
  return {
    context: vi.fn(() => ({ pages: () => [] })),
    goto: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    url: () => 'http://localhost/',
    screenshot: vi.fn(async () => ''),
    locator,
    getByText,
  }
}

/**
 * 钱包边界打桩：sign/runIntent 由钱包扩展弹窗驱动、测试无法模拟故打桩；
 * ensureLoggedIn 保留真实实现——经 Object.create 原型链委托，真实方法内 this=stub，
 * 因此 runIntent 走桩、ready/deps 走真实（无 walletSession 时 ready 直接返回）
 */
function stubWallet(ctx: TaskContext) {
  const wallet = Object.create(ctx.wallet) as {
    ensureLoggedIn: (spec: unknown) => Promise<{ skipped: boolean }>
    sign: ReturnType<typeof vi.fn>
    runIntent: ReturnType<typeof vi.fn>
  }
  wallet.sign = vi.fn(async () => ({ popupFailed: false })) as ReturnType<typeof vi.fn>
  wallet.runIntent = vi.fn(async () => ({ popupFailed: false })) as ReturnType<typeof vi.fn>
  Object.defineProperty(ctx, 'wallet', { value: wallet, configurable: true })
  return wallet
}

/** 构造注入假依赖的 TaskContext */
function makeCtx(task = new ShelbyExplorerTask(), state = makeState()) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const page = makePage(state)
  const ctx = new TaskContext({
    page: page as never,
    task,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: '',
    walletPasswords: { petra: 'pw' },
    accountRow: { petra钱包地址: '0xabc', 文件地址: 'C:\\files\\a.png' },
  })
  ctx.uploadFile = vi.fn().mockResolvedValue(undefined)
  ctx.account = vi.fn().mockImplementation(async (key: string) => (key === 'petra钱包地址' ? '0xabc' : 'C:\\files\\a.png'))
  ctx.screenshot = vi.fn().mockResolvedValue('/tmp/s.png')
  const wallet = stubWallet(ctx)
  return { ctx, log, page, state, wallet }
}

describe('ShelbyExplorerTask run 流程', () => {
  it('已登录：跳过登录（不触发连接意图），仅上传两次签名，账号页地址取自数据源', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, page, wallet } = makeCtx(task)
    await task.run(ctx)
    expect(page.context).toHaveBeenCalled()
    expect(page.goto).toHaveBeenCalledTimes(2)
    // 已登录：ensureLoggedIn 竞速命中 loggedIn 直接跳过，未触发钱包连接意图
    expect(wallet.runIntent).not.toHaveBeenCalled()
    expect(wallet.sign).toHaveBeenCalledTimes(2)
    expect(ctx.uploadFile).toHaveBeenCalledTimes(1)
    expect((ctx.uploadFile as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('C:\\files\\a.png')
    // 第二次 goto 是账号页（petra钱包地址 拼 URL）
    const secondGoto = (page.goto as ReturnType<typeof vi.fn>).mock.calls[1][0] as string
    expect(secondGoto).toContain('/shelbynet/account/0xabc/blobs')
    expect(ctx.screenshot).toHaveBeenCalled()
  })

  it('未登录：Connect Wallet → 站内弹窗 Connect → 登录完成（runIntent connect），再上传双签', async () => {
    const task = new ShelbyExplorerTask()
    const state = makeState({ addressVisible: false, connectVisible: true })
    state.onClick = (sel) => {
      if (sel === DIALOG_CONNECT_SELECTOR) state.addressVisible = true
    }
    const { ctx, wallet } = makeCtx(task, state)
    await task.run(ctx)
    expect(wallet.runIntent).toHaveBeenCalledTimes(1)
    expect(wallet.runIntent.mock.calls[0][0]).toBe('connect')
    expect(wallet.sign).toHaveBeenCalledTimes(2)
  })

  it('登录静默连接（钱包弹窗未出现）：容忍后继续等 header 地址，不抛错', async () => {
    const task = new ShelbyExplorerTask()
    const state = makeState({ addressVisible: false, connectVisible: true })
    state.onClick = (sel) => {
      if (sel === DIALOG_CONNECT_SELECTOR) state.addressVisible = true
    }
    const { ctx, log, wallet } = makeCtx(task, state)
    // 静默连接：弹窗未出现（popupFailed）不判失败，以登录态判定
    wallet.runIntent = vi.fn(async () => ({ popupFailed: true })) as ReturnType<typeof vi.fn>
    await expect(task.run(ctx)).resolves.toBeUndefined()
    expect(wallet.runIntent).toHaveBeenCalledTimes(1)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('静默连接'))).toBe(true)
  })

  it('登录后 header 地址未出现 → 抛登录未完成', async () => {
    const task = new ShelbyExplorerTask()
    task.login.waitLoggedInMs = 10
    const state = makeState({ addressVisible: false, connectVisible: true })
    const { ctx } = makeCtx(task, state)
    await expect(task.run(ctx)).rejects.toThrow('登录未完成')
  })

  it('未登录：点击 Connect Wallet 与站内弹窗 Connect 均被触发（登录入口点击层）', async () => {
    const task = new ShelbyExplorerTask()
    const state = makeState({ addressVisible: false, connectVisible: true })
    state.onClick = (sel) => {
      if (sel === DIALOG_CONNECT_SELECTOR) state.addressVisible = true
    }
    const { ctx, wallet } = makeCtx(task, state)
    await task.run(ctx)
    // 弹窗渲染补点（reclick）已下沉 login-flow（见 wallet-login-flow.test.ts），
    // 任务层保留「入口 + 弹窗 Connect」点击经 ctx.page 直调的行为断言
    expect(state.clicks.filter((s) => s === CONNECT_SELECTOR).length).toBeGreaterThanOrEqual(1)
    expect(state.clicks.filter((s) => s === DIALOG_CONNECT_SELECTOR).length).toBeGreaterThanOrEqual(1)
    expect(wallet.runIntent).toHaveBeenCalled()
  })

  it('数据源缺「petra钱包地址」列 → 严格模式抛错（不跑上传）', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, wallet } = makeCtx(task)
    ctx.account = vi.fn().mockRejectedValue(new Error('数据源缺少列: petra钱包地址（可用列: ...）'))
    await expect(task.run(ctx)).rejects.toThrow('数据源缺少列')
    expect(wallet.runIntent).not.toHaveBeenCalled()
  })

  it('数据源缺「文件地址」列 → 严格模式抛错（不硬跑）', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    ctx.account = vi.fn().mockImplementation(async (key: string) => {
      if (key === '文件地址') throw new Error('数据源缺少列: 文件地址（可用列: ...）')
      return '0xabc'
    })
    await expect(task.run(ctx)).rejects.toThrow('数据源缺少列')
    expect(ctx.uploadFile).not.toHaveBeenCalled()
  })

  it('选文件后 Upload 按钮始终禁用 → 抛按钮未启用', async () => {
    const task = new ShelbyExplorerTask()
    task.uploadEnabledWaitMs = 10
    const { ctx, wallet } = makeCtx(task, makeState({ uploadDisabled: true }))
    await expect(task.run(ctx)).rejects.toThrow('Upload 按钮未启用')
    expect(wallet.runIntent).not.toHaveBeenCalled()
  })

  it('上传弹窗未出现 file input（挂载超时）→ 补点后抛错', async () => {
    const task = new ShelbyExplorerTask()
    task.uploadDialogWaitMs = 10
    const state = makeState({ fileInputCount: 0 })
    const { ctx } = makeCtx(task, state)
    await expect(task.run(ctx)).rejects.toThrow('上传弹窗未出现 file input')
    // 点击 Upload Files 补点重试（点击两次：首点 + 补点）
    expect(state.clicks.filter((s) => s === UPLOAD_FILES_SELECTOR).length).toBe(2)
  })

  it('成功文案超时 → 抛上传未完成；错误文案且不在上传中 → 刷新恢复', async () => {
    const task = new ShelbyExplorerTask()
    task.successWaitMs = 10
    const state = makeState({ textCount: (t) => (t === 'Network Error' ? 1 : 0) })
    const { ctx, page } = makeCtx(task, state)
    await expect(task.run(ctx)).rejects.toThrow('上传未完成')
    expect(page.reload).toHaveBeenCalled()
  })

  it('已上传过：Blob name already taken 出现 → 短路视为成功（不点 Upload 不双签）', async () => {
    const task = new ShelbyExplorerTask()
    const state = makeState({ textCount: (t) => (t === ALREADY_DONE_TEXT ? 1 : 0) })
    const { ctx, log, wallet } = makeCtx(task, state)
    await task.run(ctx)
    expect(ctx.screenshot).toHaveBeenCalled()
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('已上传过'))).toBe(true)
    // 已上传短路：站点不启用 Upload 按钮也不发起签名 → 不点 Upload、不调钱包签名
    expect(wallet.sign).not.toHaveBeenCalled()
    expect(state.clicks.filter((s) => s === UPLOAD_BUTTON_SELECTOR).length).toBe(0)
  })

  it('上传途中服务端查重报已上传：双签名弹窗未出现被容忍，仍按已上传成功收尾', async () => {
    const task = new ShelbyExplorerTask()
    const state = makeState()
    // waitSettle 阶段无已上传提示（走 Upload 按钮启用分支）；签名尝试后才报已上传
    let signed = false
    state.textCount = (t) => (signed && t === ALREADY_DONE_TEXT ? 1 : 0)
    const { ctx, log, wallet } = makeCtx(task, state)
    wallet.sign = vi.fn(async () => {
      signed = true
      return { popupFailed: true }
    }) as ReturnType<typeof vi.fn>
    await task.run(ctx)
    expect(wallet.sign).toHaveBeenCalledTimes(2)
    expect(ctx.screenshot).toHaveBeenCalled()
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('已上传过'))).toBe(true)
  })

  it('上传中（Uploading）即使出现可恢复错误也不刷新', async () => {
    const task = new ShelbyExplorerTask()
    task.successWaitMs = 10
    const state = makeState({ textCount: (t) => (t === UPLOADING_TEXT || t === 'Network Error' ? 1 : 0) })
    const { ctx, page } = makeCtx(task, state)
    await expect(task.run(ctx)).rejects.toThrow('上传未完成')
    expect(page.reload).not.toHaveBeenCalled()
  })
})

describe('ShelbyExplorerTask 元信息', () => {
  it('meta 契约正确', () => {
    const t = new ShelbyExplorerTask()
    expect(t.meta.key).toBe('xyz-shelbynet')
    expect(t.meta.name).toBe('shelbynet 上传任务')
    expect(t.meta.url).toBe('https://explorer.shelby.xyz/shelbynet')
    expect(t.meta.wallet).toBe('petra')
    expect(t.meta.category).toBe('checkin')
    expect(t.meta.enabled).toBe(true)
    expect(t.meta.timeoutSec).toBe(600)
    expect(t.meta.retry).toEqual({ max: 2, backoffSec: 60 })
    expect(t.meta.concurrency).toBe(4)
    expect(t.meta.requiresFileAssign).toBe(true)
    expect(t.meta.sourceUrl).toBe('https://cryptorank.io/zh/drophunting/shelby-activity1120')
    expect(t.meta.lastUpdated).toBe('2026-10-09')
  })
})

describe('ShelbyExplorerTask 集成（真实浏览器 + 本地 fixture，钱包弹窗存根）', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'shelby-explorer.html'), 'utf-8'))
    })
    await new Promise<void>((r) => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('run() 完整流程：登录态 → 登录 → 账号页 → 选文件 → 上传 → 双签名 → 成功文案', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      // 真实临时文件（uploadFile 的 setInputFiles 要求文件存在）
      const uploadFilePath = join(tmpdir(), `shelby-explorer-${Date.now()}.txt`)
      writeFileSync(uploadFilePath, 'hello shelby')
      const task = new ShelbyExplorerTask()
      task.meta.url = baseUrl + '/shelbynet'
      task.accountBaseUrl = baseUrl
      const ctx = new TaskContext({
        page,
        task,
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: {} as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-explorer-test-artifacts'),
        walletPasswords: { petra: 'pw' },
        accountRow: { petra钱包地址: '0xabc', 文件地址: uploadFilePath },
      })
      // 钱包扩展弹窗无法在测试浏览器模拟：连接/签名弹窗存根（站点侧登录态由 fixture 模拟）
      const wallet = stubWallet(ctx)
      await task.run(ctx)
      expect(await page.getByText('All files uploaded successfully').count()).toBeGreaterThan(0)
      expect(wallet.runIntent).toHaveBeenCalledTimes(1)
      expect(wallet.sign).toHaveBeenCalledTimes(2)
    } finally {
      await browser.close()
    }
  }, 90000)

  it('run() 已上传路径：Blob name already taken → 视为成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const uploadFilePath = join(tmpdir(), `shelby-explorer-${Date.now()}.txt`)
      writeFileSync(uploadFilePath, 'hello shelby again')
      const task = new ShelbyExplorerTask()
      task.meta.url = baseUrl + '/shelbynet?alreadydone'
      task.accountBaseUrl = baseUrl
      const ctx = new TaskContext({
        page,
        task,
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: {} as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-explorer-test-artifacts'),
        walletPasswords: { petra: 'pw' },
        accountRow: { petra钱包地址: '0xabc', 文件地址: uploadFilePath },
      })
      const wallet = stubWallet(ctx)
      await task.run(ctx)
      expect(await page.getByText('Blob name already taken').count()).toBeGreaterThan(0)
      // 已上传短路（真机核实）：选文件后直接视为成功——不点 Upload、不双签名（仅登录连接 1 次）
      expect(wallet.runIntent).toHaveBeenCalledTimes(1)
      expect(wallet.sign).not.toHaveBeenCalled()
    } finally {
      await browser.close()
    }
  }, 90000)
})
