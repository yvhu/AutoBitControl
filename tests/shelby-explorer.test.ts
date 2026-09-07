/**
 * ShelbyExplorerTask 单测：登录分支 / 上传流程 / 数据源严格模式（注入假 ctx，不连真浏览器）
 * 背景：真机选择器尚未核实（见本计划 Task 3），单测锁定流程逻辑与错误语义，
 * 使后续选择器迭代不破坏已验证的行为
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { ShelbyExplorerTask } from '../src/tasks/shelby-explorer'
import { TaskContext } from '../src/tasks/base'
import { Humanizer } from '../src/automation/humanize'

/** 构造注入假依赖的 TaskContext：run 用到的全部 ctx 能力替换为假实现 */
function makeCtx(task = new ShelbyExplorerTask()) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const page = {
    reload: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
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
    accountRow: { 文件地址: 'C:\\files\\a.png' },
  })
  ctx.closeOtherTabs = vi.fn().mockResolvedValue(undefined)
  ctx.goto = vi.fn().mockResolvedValue(undefined)
  ctx.detectPageState = vi.fn().mockResolvedValue('loggedIn')
  ctx.ensureWalletReady = vi.fn().mockResolvedValue(undefined)
  ctx.assertVisible = vi.fn().mockResolvedValue(undefined)
  ctx.loginByWallet = vi.fn().mockResolvedValue(undefined)
  ctx.waitForTextRecover = vi.fn().mockResolvedValue(true)
  ctx.uploadFile = vi.fn().mockResolvedValue(undefined)
  ctx.account = vi.fn().mockResolvedValue('C:\\files\\a.png')
  ctx.textPresent = vi.fn().mockResolvedValue(true)
  ctx.recoverErrorText = vi.fn().mockResolvedValue('')
  ctx.screenshot = vi.fn().mockResolvedValue('/tmp/s.png')
  return { ctx, log, human }
}

describe('ShelbyExplorerTask run 流程', () => {
  it('已登录：跳过登录，仅上传两次 Approve（loginByWallet 共 2 次）', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    ctx.detectPageState = vi.fn().mockResolvedValue('loggedIn')
    await task.run(ctx)
    expect(ctx.closeOtherTabs).toHaveBeenCalled()
    expect(ctx.goto).toHaveBeenCalled()
    expect(ctx.ensureWalletReady).not.toHaveBeenCalled()
    expect(ctx.loginByWallet).toHaveBeenCalledTimes(2)
    expect(ctx.uploadFile).toHaveBeenCalledTimes(1)
    expect((ctx.uploadFile as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('C:\\files\\a.png')
    expect(ctx.screenshot).toHaveBeenCalled()
  })

  it('未登录：走登录流程（loginByWallet 共 3 次 = 1 登录 + 2 Approve），日志含未登录', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx, log } = makeCtx(task)
    ctx.detectPageState = vi.fn().mockResolvedValue('landing')
    await task.run(ctx)
    expect(ctx.ensureWalletReady).toHaveBeenCalled()
    expect(ctx.loginByWallet).toHaveBeenCalledTimes(3)
    expect(log.info.mock.calls.some((c) => (c[1] as string).includes('未登录'))).toBe(true)
  })

  it('登录后 0x 地址未出现 → 抛登录未完成', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    ctx.detectPageState = vi.fn().mockResolvedValue('landing')
    ctx.waitForTextRecover = vi.fn().mockResolvedValue(false)
    await expect(task.run(ctx)).rejects.toThrow('登录未完成')
  })

  it('数据源缺「文件地址」列 → 严格模式抛错（不硬跑）', async () => {
    const task = new ShelbyExplorerTask()
    const { ctx } = makeCtx(task)
    ctx.account = vi.fn().mockRejectedValue(new Error('数据源缺少列: 文件地址（可用列: ...）'))
    await expect(task.run(ctx)).rejects.toThrow('数据源缺少列')
    expect(ctx.loginByWallet).not.toHaveBeenCalled()
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
})

describe('ShelbyExplorerTask 元信息', () => {
  it('meta 契约正确', () => {
    const t = new ShelbyExplorerTask()
    expect(t.meta.key).toBe('xyz-shelbynet')
    expect(t.meta.name).toBe('shelbynet 领水和任务')
    expect(t.meta.url).toBe('https://explorer.shelby.xyz/shelbynet')
    expect(t.meta.wallet).toBe('petra')
    expect(t.meta.category).toBe('checkin')
    expect(t.meta.enabled).toBe(true)
    expect(t.meta.timeoutSec).toBe(600)
    expect(t.meta.retry).toEqual({ max: 2, backoffSec: 120 })
    expect(t.meta.concurrency).toBe(4)
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

  it('run() 完整流程：登录态 → 登录 → 点 0x → 上传 → 双确认 → 成功文案', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      // 真实临时文件（uploadFile 的 setInputFiles 要求文件存在）
      const uploadFilePath = join(tmpdir(), `shelby-explorer-${Date.now()}.txt`)
      writeFileSync(uploadFilePath, 'hello shelby')
      const task = new ShelbyExplorerTask()
      task.meta.url = baseUrl + '/shelbynet'
      const ctx = new TaskContext({
        page,
        task,
        human: new Humanizer(page),
        profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
        cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        artifactsDir: join(tmpdir(), 'shelby-explorer-test-artifacts'),
        walletPasswords: { petra: 'pw' },
        accountRow: { 文件地址: uploadFilePath },
      })
      // 钱包扩展弹窗无法在测试浏览器模拟：登录/Approve 弹窗全部存根（站点侧状态由 fixture 模拟）
      ctx.ensureWalletReady = vi.fn().mockResolvedValue(undefined)
      ctx.loginByWallet = vi.fn().mockResolvedValue(undefined)
      await task.run(ctx)
      expect(await page.getByText('All files uploaded successfully').count()).toBeGreaterThan(0)
      expect(ctx.loginByWallet).toHaveBeenCalledTimes(3)
    } finally {
      await browser.close()
    }
  }, 90000)
})
