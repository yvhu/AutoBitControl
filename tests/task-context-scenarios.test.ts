import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { TaskContext } from '../src/tasks/base'
import type { SiteTask, TaskMeta } from '../src/tasks/base'

class FakeTask implements SiteTask {
  meta: TaskMeta = { key: 'fake-scenario', name: '场景假任务', url: '' }
  async run(_ctx: TaskContext) {}
}

function makeCtx(page: import('patchright').Page, accountRow?: Record<string, string> | null): TaskContext {
  const task = new FakeTask()
  return new TaskContext({
    page,
    task,
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
    accountRow,
  })
}

describe('TaskContext 场景方法集成', () => {
  let server: Server
  let baseUrl: string
  let localFile: string

  beforeAll(async () => {
    // fixture 服务提供的小文件：本地路径上传测试用（真文件路径）
    localFile = join(mkdtempSync(join(tmpdir(), 'abc-upload-fixture-')), 'avatar-local.png')
    writeFileSync(localFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    server = createServer((req, res) => {
      // URL 下载路径测试用：返回小 PNG（含扩展名）
      if (req.url === '/avatar.png') {
        res.setHeader('content-type', 'image/png')
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        return
      }
      // 下载失败测试用：404
      if (req.url === '/no-such.png') {
        res.statusCode = 404
        res.end('not found')
        return
      }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'scenarios.html'), 'utf-8'))
    })
    await new Promise<void>(r => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  it('js 在主世界读取站点全局状态', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      const user = await ctx.js<string>(() => (window as never as { __APP_STATE__: { user: string } }).__APP_STATE__.user)
      expect(user).toBe('t1')
    } finally {
      await browser.close()
    }
  })

  it('uploadFile 本地路径：setInputFiles 后 input.files 长度与文件名正确', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      await ctx.uploadFile('#file-input', localFile)
      const files = await page.locator('#file-input').evaluate((el: HTMLInputElement) => ({ len: el.files?.length ?? 0, name: el.files?.[0]?.name ?? '' }))
      expect(files.len).toBe(1)
      expect(files.name).toBe('avatar-local.png')
    } finally {
      await browser.close()
    }
  })

  it('uploadFile URL：自动下载到临时文件并上传（扩展名取自 URL）', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      await ctx.uploadFile('#file-input', `${baseUrl}/avatar.png`)
      const files = await page.locator('#file-input').evaluate((el: HTMLInputElement) => ({ len: el.files?.length ?? 0, name: el.files?.[0]?.name ?? '' }))
      expect(files.len).toBe(1)
      expect(files.name).toMatch(/\.png$/)
    } finally {
      await browser.close()
    }
  })

  it('uploadFile URL 下载失败（HTTP 404）抛错', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      await expect(ctx.uploadFile('#file-input', `${baseUrl}/no-such.png`)).rejects.toThrow('图片下载失败')
    } finally {
      await browser.close()
    }
  })

  it('account 无数据源行抛错（带窗口名提示）', async () => {
    const ctx = makeCtx(null as never, null)
    await expect(ctx.account('邮箱')).rejects.toThrow('数据源无当前窗口对应的行（窗口: 窗口1）')
  })

  it('account 缺列抛错（提示可用列）', async () => {
    const ctx = makeCtx(null as never, { 邮箱: 'a@b.com' })
    await expect(ctx.account('邀请码')).rejects.toThrow('数据源缺少列: 邀请码')
  })

  it('account 列为空抛错（带窗口名与列名）', async () => {
    const ctx = makeCtx(null as never, { 邮箱: '' })
    await expect(ctx.account('邮箱')).rejects.toThrow('数据源列 邮箱 在窗口 窗口1 的行为空')
  })

  it('account 正常取值', async () => {
    const ctx = makeCtx(null as never, { 邮箱: 'a@b.com' })
    expect(await ctx.account('邮箱')).toBe('a@b.com')
  })

  it('accountRow getter：未注入为 null，注入后返回行', async () => {
    expect(makeCtx(null as never).accountRow).toBeNull()
    expect(makeCtx(null as never, { 邮箱: 'x@y.com' }).accountRow).toEqual({ 邮箱: 'x@y.com' })
  })
})
