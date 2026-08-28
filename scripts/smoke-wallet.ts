import { loadConfig } from '../src/infrastructure/config'
import { createLogger } from '../src/infrastructure/logger'
import { createBitBrowserClient } from '../src/integrations/bitbrowser'
import { PatchrightDriver } from '../src/engine/window-runner'
import { waitForPopup } from '../src/automation/wallet/popup'
import { WalletRegistry, type PopupPage } from '../src/automation/wallet/types'
import { MetaMaskAdapter } from '../src/automation/wallet/metamask'
import { PetraAdapter } from '../src/automation/wallet/petra'

async function main(): Promise<void> {
  const profileId = process.env.BITBROWSER_PROFILE_ID
  const walletKey = process.env.WALLET_KEY ?? 'metamask'
  if (!profileId) {
    console.error('用法: BITBROWSER_PROFILE_ID=<窗口ID> WALLET_KEY=metamask|petra npm run smoke:wallet')
    process.exit(1)
  }
  const cfg = loadConfig()
  const logger = createLogger(cfg)
  const client = createBitBrowserClient({ apiBase: cfg.bitbrowser.apiBase, timeoutMs: cfg.bitbrowser.openTimeoutMs })
  const reg = new WalletRegistry()
  reg.register(new MetaMaskAdapter())
  reg.register(new PetraAdapter())
  const adapter = reg.get(walletKey)

  const open = await client.openBrowser(profileId)
  let conn: Awaited<ReturnType<PatchrightDriver['connect']>> | null = null
  try {
    conn = await new PatchrightDriver().connect(`http://${open.http}`)
    await conn.page.goto('https://opensea.io').catch(() => {})
    logger.info('请手动点击页面上的连接钱包按钮（60 秒内）...')
    const popup = await waitForPopup(conn.page.context(), adapter.extensionUrlPatterns, 60000)
    if (!popup) {
      logger.error('未检测到钱包弹窗')
      return
    }
    logger.info({ url: popup.url() }, '检测到钱包弹窗，尝试自动确认')
    await adapter.ensureConnected(popup as unknown as PopupPage)
    logger.info('钱包弹窗处理完成')
  } finally {
    await client.closeBrowser(profileId).catch(() => {})
    await conn?.close().catch(() => {})
  }
}

void main()
