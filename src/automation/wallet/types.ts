export interface PopupLocator {
  click(opts?: { timeout?: number }): Promise<void>
  fill(text: string): Promise<void>
  press?(key: string): Promise<void>
  first(): PopupLocator
}

export interface PopupPage {
  url(): string
  getByRole(role: string, opts: { name: RegExp }): PopupLocator
  getByTestId(id: string): PopupLocator
  locator(selector: string): PopupLocator
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<void>
}

export interface WalletAdapter {
  key: string
  extensionUrlPatterns: string[]
  unlock?(popup: PopupPage, password: string): Promise<void>
  ensureConnected(popup: PopupPage): Promise<void>
}

export class WalletRegistry {
  private map = new Map<string, WalletAdapter>()

  register(adapter: WalletAdapter): void {
    this.map.set(adapter.key, adapter)
  }

  get(key: string): WalletAdapter {
    const a = this.map.get(key)
    if (!a) throw new Error(`未注册的钱包适配器: ${key}`)
    return a
  }

  has(key: string): boolean {
    return this.map.has(key)
  }
}
