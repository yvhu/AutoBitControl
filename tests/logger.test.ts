import { describe, it, expect } from 'vitest'
import { ConsoleUtf8 } from '../src/infrastructure/logger'

describe('ConsoleUtf8', () => {
  it('Buffer 与字符串输入都按 UTF-8 字符串写出（GBK 控制台不乱码的关键路径）', async () => {
    const out: string[] = []
    const w = new ConsoleUtf8((s, cb) => { out.push(s); cb() })
    w.write(Buffer.from('中文测试\n'))
    w.write('第二行\n')
    await new Promise(r => setTimeout(r, 50))
    expect(out.join('')).toBe('中文测试\n第二行\n')
  })
})
