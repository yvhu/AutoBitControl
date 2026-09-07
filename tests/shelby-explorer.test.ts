/**
 * ShelbyExplorerTask 单测：登录分支 / 账号页上传流程 / 数据源严格模式（注入假 ctx，不连真浏览器）
 * 背景：真机核实（2026-09-07）后选择器/流程已锁定（站内 Petra Web 弹窗静默连接、header 选择器
 * 判定登录态、账号页 Upload Files 入口、隐藏 file input、双签名、选文件后已上传短路：
 * 站点查重报 Blob name already taken 且 Upload 按钮永不启用 → 不点 Upload 直接成功）
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
import { Humanizer } from '../src/automation/humanize'

/** 登录态判定用选择器（与任务实现一致，测试按选择器分流 visible 行为） */
const ADDRESS_SELECTOR = 'header button:has-text("0x")'
const CONNECT_SELECTOR = 'header button:has-text("Connect Wallet")'

/** 构造注入假依赖的 TaskContext：run 用到的全部 ctx 能力替换为假实现 */
function makeCtx(task = new ShelbyExplorerTask()) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const page = {
    reload: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    // 默认：Upload 按钮未禁用 + 元素挂载（file input 的 DOM 存在）
    locator: vi.fn().mockReturnValue({
      first: () => ({ isDisabled: vi.fn().mockResolvedValue(false) }),
      count: vi.fn().mockResolvedValue(1),
    }),
  }
  const human = { click: vi.fn().mockResolvedValue(undefined) }
  const ctx = new TaskContext({
    page: page as never,
    task,
    human: human as never,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: log as never,
    artifactsDir: '',
    walletPasswords: { petra: 'pw' },
    accountRow: { petra钱包地址: '0xabc', 文件地址: 'C:\\files\\a.png' },
  })
  ctx.closeOtherTabs = vi.fn().mockResolvedValue(undefined)
  ctx.goto = vi.fn().mockResolvedValue(undefined)
  ctx.ensureWalletReady = vi.fn().mockResolvedValue(undefined)
  ctx.assertVisible = vi.fn().mockResolvedValue(undefined)
  ctx.loginByWallet = vi.fn().mockResolvedValue(undefined)
  ctx.uploadFile = vi.fn().mockResolvedValue(undefined)
  ctx.account = vi.fn().mockImplementation(async (key: string) => (key === 'petra钱包地址' ? '0xabc' : 'C:\\files\\a.png'))
  // 默认未上传语义：无已上传提示（新上传流程），其余文案都认
  ctx.textPresent = vi.fn((t: string) => Promise.resolve(t !== ALREADY_DONE_TEXT))
  ctx.recoverErrorText = vi.fn().mockResolvedValue('')
  ctx.screenshot = vi.fn().mockResolvedValue('/tmp/s.png')
  // 默认已登录语义：除 Connect Wallet 外全部可见（header 地址 / Upload Files）
  ctx.visible = vi.fn().mockImplementation(async (sel: string) => sel !== CONNECT_SELECTOR)
  return { ctx, log, human }
}

/** 未登录语义的 visible 分流：header 地址的可见性由 addressVisible 动态控制 */
function landingVisible(addressVisible: () => boolean) {
  return vi.fn().mockImplementation(async (sel: string) => {
    if (sel === ADDRESS_SELECTOR) return addressVisible()
    return true
  })
}

describe('ShelbyExplorerTask run 流程', () => {
  it('已登录：跳过登录，仅上传两次签名（loginByWallet 共 2 次），账号页地址取自数据源', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    await task.run(ctx)
    expect(ctx.closeOtherTabs).toHaveBeenCalled()
    expect(ctx.goto).toHaveBeenCalledTimes(2)
    expect(ctx.ensureWalletReady).not.toHaveBeenCalled()
    expect(ctx.loginByWallet).toHaveBeenCalledTimes(2)
    expect(ctx.uploadFile).toHaveBeenCalledTimes(1)
    expect((ctx.uploadFile as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('C:\\files\\a.png')
    // 第二次 goto 是账号页（petra钱包地址 拼 URL）
    const secondGoto = (ctx.goto as ReturnType<typeof vi.fn>).mock.calls[1][0] as string
    expect(secondGoto).toContain('/shelbynet/account/0xabc/blobs')
    expect(ctx.screenshot).toHaveBeenCalled()
  })

  it('未登录：走登录流程（loginByWallet 共 3 次 = 1 登录 + 2 签名），日志含未登录', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, log } = makeCtx(task)
    let addressVisible = false
    ctx.visible = landingVisible(() => addressVisible)
    // 登录调用后地址可见（站点登录完成）
    ctx.loginByWallet = vi.fn().mockImplementation(async () => {
      addressVisible = true
    })
    await task.run(ctx)
    expect(ctx.ensureWalletReady).toHaveBeenCalled()
    expect(ctx.loginByWallet).toHaveBeenCalledTimes(3)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('未登录'))).toBe(true)
  })

  it('登录静默连接（钱包弹窗未出现）：容忍后继续等 header 地址，不抛错', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, log } = makeCtx(task)
    let addressVisible = false
    ctx.visible = landingVisible(() => addressVisible)
    let calls = 0
    ctx.loginByWallet = vi.fn().mockImplementation(async () => {
      calls++
      addressVisible = true
      if (calls === 1) throw new Error('钱包弹窗未出现')
    })
    await expect(task.run(ctx)).resolves.toBeUndefined()
    expect(ctx.loginByWallet).toHaveBeenCalledTimes(3)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('静默连接'))).toBe(true)
  })

  it('登录后 header 地址未出现 → 抛登录未完成', async () => {
    const task = new ShelbyExplorerTask()
    task.loginWaitMs = 10
    const { ctx } = makeCtx(task)
    ctx.visible = landingVisible(() => false)
    await expect(task.run(ctx)).rejects.toThrow('登录未完成')
  })

  it('弹窗点击未注册：Connect 按钮仍可见时补点，弹窗出现后继续登录', async () => {
    const task = new ShelbyExplorerTask()
    task.walletDialogReclickMs = 0
    const { ctx, human } = makeCtx(task)
    let addressVisible = false
    // 弹窗前两次检查不可见（模拟点击未注册），第三次出现；Connect 按钮始终可见
    let dialogChecks = 0
    ctx.visible = vi.fn().mockImplementation(async (sel: string) => {
      if (sel === '[role="dialog"]') {
        dialogChecks++
        return dialogChecks >= 3
      }
      if (sel === ADDRESS_SELECTOR) return addressVisible
      return true
    })
    ctx.loginByWallet = vi.fn().mockImplementation(async () => {
      addressVisible = true
    })
    await task.run(ctx)
    const connectClicks = (human.click as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[0] as string).includes('Connect Wallet'))
    expect(connectClicks.length).toBeGreaterThanOrEqual(2)
    expect(ctx.loginByWallet).toHaveBeenCalled()
  })

  it('数据源缺「petra钱包地址」列 → 严格模式抛错（不跑上传）', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    ctx.account = vi.fn().mockRejectedValue(new Error('数据源缺少列: petra钱包地址（可用列: ...）'))
    await expect(task.run(ctx)).rejects.toThrow('数据源缺少列')
    expect(ctx.loginByWallet).not.toHaveBeenCalled()
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
    const { ctx } = makeCtx(task)
    ctx.page.locator = vi.fn().mockReturnValue({
      first: () => ({ isDisabled: vi.fn().mockResolvedValue(true) }),
      count: vi.fn().mockResolvedValue(1),
    })
    await expect(task.run(ctx)).rejects.toThrow('Upload 按钮未启用')
    expect(ctx.loginByWallet).not.toHaveBeenCalled()
  })

  it('上传弹窗未出现 file input（挂载超时）→ 补点后抛错', async () => {
    const task = new ShelbyExplorerTask()
    task.uploadDialogWaitMs = 10
    const { ctx, human } = makeCtx(task)
    ctx.page.locator = vi.fn().mockReturnValue({
      first: () => ({ isDisabled: vi.fn().mockResolvedValue(false) }),
      count: vi.fn().mockResolvedValue(0),
    })
    await expect(task.run(ctx)).rejects.toThrow('上传弹窗未出现 file input')
    // 点击 Upload Files 补点重试（点击两次：首点 + 补点）
    const uploadClicks = (human.click as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[0] as string).includes('Upload Files'))
    expect(uploadClicks.length).toBe(2)
  })

  it('成功文案超时 → 抛上传未完成；错误文案且不在上传中 → 刷新恢复', async () => {
    const task = new ShelbyExplorerTask()
    task.successWaitMs = 10
    const { ctx } = makeCtx(task)
    ctx.textPresent = vi.fn().mockResolvedValue(false)
    ctx.recoverErrorText = vi.fn().mockResolvedValue('Network Error')
    await expect(task.run(ctx)).rejects.toThrow('上传未完成')
    expect(ctx.page.reload).toHaveBeenCalled()
  })

  it('已上传过：Blob name already taken 出现 → 短路视为成功（不点 Upload 不双签名）', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, log } = makeCtx(task)
    ctx.textPresent = vi.fn((t: string) => Promise.resolve(t === ALREADY_DONE_TEXT))
    await task.run(ctx)
    expect(ctx.screenshot).toHaveBeenCalled()
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('已上传过'))).toBe(true)
    // 已上传短路：站点不启用 Upload 按钮也不发起签名 → 不点 Upload、不调钱包签名
    expect(ctx.loginByWallet).not.toHaveBeenCalled()
    const uploadClicks = (ctx.human.click as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === '[role="dialog"] button:has-text("Upload")')
    expect(uploadClicks.length).toBe(0)
  })

  it('上传途中服务端查重报已上传：双签名弹窗未出现被容忍，仍按已上传成功收尾', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, log } = makeCtx(task)
    // waitSettle 阶段无已上传提示（走 Upload 按钮启用分支）；签名尝试后才报已上传
    let signed = false
    ctx.loginByWallet = vi.fn().mockImplementation(async () => {
      signed = true
      throw new Error('钱包弹窗未出现')
    })
    ctx.textPresent = vi.fn((t: string) => Promise.resolve(signed && t === ALREADY_DONE_TEXT))
    await task.run(ctx)
    expect(ctx.loginByWallet).toHaveBeenCalledTimes(2)
    expect(ctx.screenshot).toHaveBeenCalled()
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('已上传过'))).toBe(true)
  })

  it('上传中（Uploading）即使出现可恢复错误也不刷新', async () => {
    const task = new ShelbyExplorerTask()
    task.successWaitMs = 10
    const { ctx } = makeCtx(task)
    ctx.textPresent = vi.fn((t: string) => Promise.resolve(t === 'Uploading files'))
    ctx.recoverErrorText = vi.fn().mockResolvedValue('Network Error')
    await expect(task.run(ctx)).rejects.toThrow('上传未完成')
    expect(ctx.page.reload).not.toHaveBeenCalled()
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
    expect(t.meta.sourceUrl).toBe('https://cryptorank.io/zh/drophunting/shelby-activity1120')
    expect(t.meta.lastUpdated).toBe('2026-09-07')
    expect(t.meta.captcha).toEqual({ auto: true })
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
        human: new Humanizer(page),
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-explorer-test-artifacts'),
        walletPasswords: { petra: 'pw' },
        accountRow: { petra钱包地址: '0xabc', 文件地址: uploadFilePath },
      })
      // 钱包扩展弹窗无法在测试浏览器模拟：登录/签名弹窗全部存根（站点侧状态由 fixture 模拟）
      ctx.ensureWalletReady = vi.fn().mockResolvedValue(undefined)
      ctx.loginByWallet = vi.fn().mockResolvedValue(undefined)
      await task.run(ctx)
      expect(await page.getByText('All files uploaded successfully').count()).toBeGreaterThan(0)
      expect(ctx.loginByWallet).toHaveBeenCalledTimes(3)
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
        human: new Humanizer(page),
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-explorer-test-artifacts'),
        walletPasswords: { petra: 'pw' },
        accountRow: { petra钱包地址: '0xabc', 文件地址: uploadFilePath },
      })
      ctx.ensureWalletReady = vi.fn().mockResolvedValue(undefined)
      ctx.loginByWallet = vi.fn().mockResolvedValue(undefined)
      await task.run(ctx)
      expect(await page.getByText('Blob name already taken').count()).toBeGreaterThan(0)
      // 已上传短路（真机核实）：选文件后直接视为成功——不点 Upload、不双签名（仅登录 1 次）
      expect(ctx.loginByWallet).toHaveBeenCalledTimes(1)
    } finally {
      await browser.close()
    }
  }, 90000)
})
