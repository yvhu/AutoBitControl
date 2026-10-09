import { describe, it, expect } from 'vitest'
import { collectDiagnostics, writeDiagBundle } from '../src/automation/diag'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('diag bundle', () => {
  it('collectDiagnostics 采集 url/文本/步骤，page 抛错则字段置空', async () => {
    const pageObj = {
      url: () => 'https://x/quests',
      evaluate: async (fn: () => unknown) =>
        new Function('document', `return (${fn.toString()})()`)({ body: { innerText: 'body-文本' }, querySelector: () => ({ textContent: '弹窗文本' }) }),
    }
    const b = await collectDiagnostics({ page: pageObj as never, steps: [{ name: 's', startMs: 0, ms: 1, ok: true }], error: 'err', status: 'failed', windowName: '窗口1', taskKey: 'k' })
    expect(b.url).toBe('https://x/quests')
    expect(b.visibleText).toContain('body-文本')
    expect(b.dialogText).toContain('弹窗文本')
    expect(b.error).toBe('err')

    const bad = { url: () => { throw new Error('closed') }, evaluate: async () => { throw new Error('closed') } }
    const b2 = await collectDiagnostics({ page: bad as never, steps: [], error: 'e', status: 'failed', windowName: 'w', taskKey: 'k' })
    expect(b2.url).toBe('')
    expect(b2.visibleText).toBe('')
  })

  it('writeDiagBundle 写 JSON 文件并返回路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diag-'))
    const file = writeDiagBundle(dir, 'x-attempt1.diag', { taskKey: 'k' } as never)
    expect(file.endsWith('x-attempt1.diag.json')).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).taskKey).toBe('k')
  })
})
