import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { TaskContext } from '../src/tasks/base'
import type { SiteTask, TaskMeta } from '../src/tasks/base'
import { Humanizer } from '../src/core/humanize'

class FakeTask implements SiteTask {
  meta: TaskMeta = { key: 'fake', name: '假任务', url: '' }
  async run(ctx: TaskContext) {
    await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })
  }
}

describe('TaskContext 集成', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(readFileSync(join(__dirname, 'fixtures', 'checkin.html'), 'utf-8'))
    })
    await new Promise<void>(r => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  it('clickCheckin 带成功断言', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const task = new FakeTask()
    task.meta.url = baseUrl
    const ctx = new TaskContext({
      page,
      task,
      human: new Humanizer(page),
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 0 },
      cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      artifactsDir: '',
    })
    await ctx.goto()
    await task.run(ctx)
    const badge = await page.locator('#checked-badge').count()
    expect(badge).toBe(1)
    await browser.close()
  })

  it('断言超时抛异常', async () => {
    const browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const task = new FakeTask()
    task.meta.url = baseUrl
    const ctx = new TaskContext({
      page,
      task,
      human: new Humanizer(page),
      profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, walletPassword: null, circuitBreakerCount: 0 },
      cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      artifactsDir: '',
    })
    await ctx.goto()
    await expect(ctx.assertVisible('#never-exists', 800)).rejects.toThrow(/超时/)
    await browser.close()
  })
})
