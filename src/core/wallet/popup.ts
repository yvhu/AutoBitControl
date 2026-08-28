import type { BrowserContext, Page } from 'patchright'

export function matchesWalletUrl(url: string, patterns: string[]): boolean {
  return patterns.some(p => new RegExp(p).test(url))
}

export async function waitForPopup(context: BrowserContext, patterns: string[], timeoutMs: number): Promise<Page | null> {
  const existing = context.pages().find(p => matchesWalletUrl(p.url(), patterns))
  if (existing) return existing
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      context.off('page', handler)
      resolve(null)
    }, timeoutMs)
    const handler = (p: Page) => {
      if (matchesWalletUrl(p.url(), patterns)) {
        clearTimeout(timer)
        context.off('page', handler)
        resolve(p)
      }
    }
    context.on('page', handler)
  })
}
