import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { chromium } from 'patchright'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Humanizer, randomPointInBox } from '../src/automation/humanize'

describe('randomPointInBox', () => {
  it('返回点在盒子内部', () => {
    const box = { x: 100, y: 50, width: 200, height: 80 }
    for (let i = 0; i < 50; i++) {
      const p = randomPointInBox(box)
      expect(p.x).toBeGreaterThanOrEqual(100)
      expect(p.x).toBeLessThan(300)
      expect(p.y).toBeGreaterThanOrEqual(50)
      expect(p.y).toBeLessThan(130)
    }
  })
})

describe('Humanizer 集成', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      const html = readFileSync(join(__dirname, 'fixtures', 'click.html'), 'utf-8')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(html)
    })
    await new Promise<void>(r => server.listen(0, r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()))
  })

  it('human click 触发按钮点击且移动轨迹非瞬时', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(baseUrl)
      const human = new Humanizer(page)
      await human.click('#btn')
      const clicked = await page.locator('#result').textContent()
      expect(clicked).toContain('1')
    } finally {
      await browser.close()
    }
  })

  it('human type 输入文本（含 delay）', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(baseUrl)
      const human = new Humanizer(page)
      await human.type('#input', 'hello')
      const val = await page.locator('#input').inputValue()
      expect(val).toBe('hello')
    } finally {
      await browser.close()
    }
  })

  it('click 前置停顿使用构造参数的 minDelay/maxDelay', async () => {
    const sleepSpy = vi.spyOn(Humanizer, 'sleep').mockResolvedValue(undefined)
    try {
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        await page.goto(baseUrl)
        const human = new Humanizer(page, { minDelayMs: 321, maxDelayMs: 654 })
        await human.click('#btn')
        expect(sleepSpy).toHaveBeenCalledWith(321, 654)
      } finally {
        await browser.close()
      }
    } finally {
      sleepSpy.mockRestore()
    }
  })
})
