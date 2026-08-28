import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { chromium } from 'patchright'
import { PatchrightDriver } from '../src/core/windowRunner'

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(err => (err ? reject(err) : resolve(port)))
    })
    srv.on('error', reject)
  })
}

describe('PatchrightDriver', () => {
  it('不同连接独立关闭，互不影响', async () => {
    const port = await freePort()
    const launched = await chromium.launch({ args: [`--remote-debugging-port=${port}`, '--headless'] })
    try {
      const driver = new PatchrightDriver()
      const a = await driver.connect(`http://127.0.0.1:${port}`)
      const b = await driver.connect(`http://127.0.0.1:${port}`)
      await a.close()
      await b.page.goto('data:text/html,<title>ok</title>')
      await expect(b.page.title()).resolves.toBe('ok')
      await b.close()
    } finally {
      await launched.close().catch(() => {})
    }
  }, 60000)
})
