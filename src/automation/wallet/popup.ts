import type { BrowserContext, Page } from 'patchright'

export function matchesWalletUrl(url: string, patterns: string[]): boolean {
  return patterns.some(p => new RegExp(p).test(url))
}

export async function waitForPopup(context: BrowserContext, patterns: string[], timeoutMs: number): Promise<Page | null> {
  const find = () => context.pages().find(p => matchesWalletUrl(p.url(), patterns))
  const existing = find()
  if (existing) return existing
  return new Promise(resolve => {
    let settled = false
    const finish = (p: Page | null) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      context.off('page', handler)
      resolve(p)
    }
    const handler = (p: Page) => {
      if (matchesWalletUrl(p.url(), patterns)) finish(p)
    }
    context.on('page', handler)
    const timer = setInterval(() => {
      const p = find()
      if (p) finish(p)
    }, 100)
    setTimeout(() => finish(null), timeoutMs)
  })
}
