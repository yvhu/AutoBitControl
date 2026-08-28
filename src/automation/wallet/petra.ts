import type { WalletAdapter, PopupPage } from './types'

export class PetraAdapter implements WalletAdapter {
  key = 'petra'
  extensionUrlPatterns = ['chrome-extension://.*/index.html', 'chrome-extension://.*/popup.html']

  async unlock(popup: PopupPage, password: string): Promise<void> {
    await popup.locator('input[type="password"]').fill(password)
    await popup.locator('input[type="password"]').press?.('Enter')
  }

  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const btn = popup.getByRole('button', { name: /connect|approve|confirm|sign|unlock/i })
      await btn.first().click({ timeout: 8000 })
      const closed = await popup.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
      if (closed) return
    }
  }
}
