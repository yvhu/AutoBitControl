import { loadConfig } from '../src/infrastructure/config'
import { createLogger } from '../src/infrastructure/logger'
import { createBitBrowserClient } from '../src/integrations/bitbrowser'
import { PatchrightDriver } from '../src/engine/window-runner'

async function main(): Promise<void> {
  const profileId = process.env.BITBROWSER_PROFILE_ID
  if (!profileId) {
    console.error('用法: BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window')
    process.exit(1)
  }
  const cfg = loadConfig()
  const logger = createLogger(cfg)
  const client = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })
  const open = await client.openBrowser(profileId)
  logger.info({ open }, '开窗成功')
  try {
    const conn = await new PatchrightDriver().connect(`http://${open.http}`)
    await conn.page.goto(cfg.execution.probeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
    logger.info({ url: conn.page.url() }, '页面打开成功')
    await conn.close()
  } finally {
    await client.closeBrowser(profileId).catch(() => {})
  }
  logger.info('冒烟通过')
}

void main()
