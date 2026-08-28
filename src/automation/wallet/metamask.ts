import type { WalletAdapter, PopupPage } from './types'

export class MetaMaskAdapter implements WalletAdapter {
  key = 'metamask'
  extensionUrlPatterns = ['chrome-extension://.*/home.html', 'chrome-extension://.*/notification.html', 'metamask://']

  async unlock(popup: PopupPage, password: string): Promise<void> {
    await popup.getByTestId('unlock-password').fill(password)
    await popup.getByTestId('unlock-submit').click()
    await popup.waitForEvent('close', { timeout: 15000 })
  }

  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const btn = popup.getByRole('button', { name: /connect|next|confirm|approve|sign/i })
      await btn.first().click({ timeout: 8000 })
      const closed = await popup.waitForEvent('close', { timeout: 5000 }).then(() => true).catch(() => false)
      if (closed) return
    }
  }
}
