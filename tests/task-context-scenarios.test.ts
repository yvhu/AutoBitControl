import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { TaskContext } from '../src/tasks/base'
import type { SiteTask, TaskMeta } from '../src/tasks/base'
import { Humanizer } from '../src/automation/humanize'

class FakeTask implements SiteTask {
  meta: TaskMeta = { key: 'fake-scenario', name: '场景假任务', url: '' }
  async run(_ctx: TaskContext) {}
}

function makeCtx(page: import('patchright').Page): TaskContext {
  const task = new FakeTask()
  return new TaskContext({
    page,
    task,
    human: new Humanizer(page),
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: { captcha: { enabled: false, maxCostPerTask: 1.5, client: null as never } } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('TaskContext 场景方法集成', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/delay') {
        setTimeout(() => {
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, data: 123 }))
        }, 1500)
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

  it('waitForText 等待 3 秒出现的文案成功', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(baseUrl)
      await ctx.waitForText('已签到成功')
      expect(await page.locator('#checkin-text').count()).toBe(1)
    } finally {
      await browser.close()
    }
  })

  it('waitForText 不存在文案超时抛错', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(baseUrl)
      await expect(ctx.waitForText('永远不存在的文案', 800)).rejects.toThrow('等待文案超时: 永远不存在的文案')
    } finally {
      await browser.close()
    }
  })

  it('waitForApi 捕获延迟接口响应并解析 JSON', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(baseUrl)
      const resPromise = ctx.waitForApi('/api/delay', 5000)
      await page.locator('#api-btn').click()
      const body = (await resPromise) as { ok: boolean; data: number }
      expect(body.ok).toBe(true)
      expect(body.data).toBe(123)
    } finally {
      await browser.close()
    }
  })

  it('waitForUrl 点击跳转按钮后等待 hash 变化', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(baseUrl)
      await page.locator('#nav-btn').click()
      await ctx.waitForUrl('#/dashboard')
      expect(page.url()).toContain('#/dashboard')
    } finally {
      await browser.close()
    }
  })

  it('js 在主世界读取站点全局状态', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(baseUrl)
      const user = await ctx.js<string>(() => (window as never as { __APP_STATE__: { user: string } }).__APP_STATE__.user)
      expect(user).toBe('t1')
    } finally {
      await browser.close()
    }
  })

  it('waitForGone 等待 loading 遮罩消失；从未存在的选择器立即返回', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(baseUrl)
      expect(await page.locator('#loading-mask').count()).toBe(1)
      await ctx.waitForGone('#loading-mask', 6000)
      expect(await page.locator('#loading-mask').count()).toBe(0)
      const start = Date.now()
      await ctx.waitForGone('#selector-never-exists', 3000)
      expect(Date.now() - start).toBeLessThan(1000)
    } finally {
      await browser.close()
    }
  })

  it('closeModal 点候选关闭按钮关闭公告弹窗', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(`${baseUrl}?modal=a`)
      expect(await page.locator('#modal-a').count()).toBe(1)
      await ctx.closeModal({ close: ['#modal-a .close'], gone: '#modal-a' })
      expect(await page.locator('#modal-a').count()).toBe(0)
    } finally {
      await browser.close()
    }
  })

  it('closeModal 点遮罩空白处关闭引导弹窗（clickAt 坐标点击）', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(`${baseUrl}?modal=b`)
      expect(await page.locator('#modal-b').count()).toBe(1)
      await ctx.closeModal({ mask: '#modal-b-mask', gone: '#modal-b' })
      expect(await page.locator('#modal-b').count()).toBe(0)
      expect(await page.locator('#modal-b-mask').count()).toBe(0)
    } finally {
      await browser.close()
    }
  })

  it('closeModal 无 close/mask 时按 Esc 关闭弹窗', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(`${baseUrl}?modal=c`)
      expect(await page.locator('#modal-c').count()).toBe(1)
      await ctx.closeModal({ gone: '#modal-c' })
      expect(await page.locator('#modal-c').count()).toBe(0)
    } finally {
      await browser.close()
    }
  })

  it('closeModal 所有策略失败时抛"元素未消失"', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(`${baseUrl}?modal=d`)
      expect(await page.locator('#modal-d').count()).toBe(1)
      await expect(ctx.closeModal({ close: ['#nonexistent'], gone: '#modal-d', timeoutMs: 1200 })).rejects.toThrow('元素未消失: #modal-d')
      expect(await page.locator('#modal-d').count()).toBe(1)
    } finally {
      await browser.close()
    }
  })

  it('closeModal 无 gone 时依次尝试多候选不提前返回', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(`${baseUrl}?modal=a`)
      expect(await page.locator('#modal-a').count()).toBe(1)
      await ctx.closeModal({ close: ['#nonexistent', '#modal-a .close'] })
      expect(await page.locator('#modal-a').count()).toBe(0)
    } finally {
      await browser.close()
    }
  })

  it('closeModal 候选按钮存在但隐藏时回退到遮罩策略', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const ctx = makeCtx(page)
      await ctx.goto(`${baseUrl}?modal=b`)
      expect(await page.locator('#modal-b').count()).toBe(1)
      await ctx.closeModal({ close: ['#modal-e-hidden-close'], mask: '#modal-b-mask', gone: '#modal-b' })
      expect(await page.locator('#modal-b').count()).toBe(0)
    } finally {
      await browser.close()
    }
  })
})
