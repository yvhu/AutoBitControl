import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { shutdown } from 'log4js'
import { formatArgs, createLogger } from '../src/infrastructure/logger'

describe('formatArgs', () => {
  it('单字符串原样透传', () => {
    expect(formatArgs(['任务完成'])).toEqual(['任务完成'])
  })

  it('(obj, msg) 两参合并为 消息 + JSON', () => {
    expect(formatArgs([{ a: 1, b: 'x' }, '任务完成'])).toEqual(['任务完成 {"a":1,"b":"x"}'])
  })

  it('循环引用对象不抛错（回退 String）', () => {
    const o: Record<string, unknown> = {}
    ;(o as { self: unknown }).self = o
    const out = formatArgs([o, '循环'])
    expect(out[0]).toContain('循环')
    expect(out[0]).not.toContain('undefined')
  })

  it('Error 对象保留 message 而非空对象', () => {
    const out = formatArgs([{ err: new Error('boom') }, '失败'])
    expect(out[0]).toContain('boom')
  })

  it('多参透传（首参为字符串时其余参数原样保留）', () => {
    expect(formatArgs(['msg', 'x', 1])).toEqual(['msg', 'x', 1])
  })

  it('单对象参数序列化为 JSON 字符串（不产出 [object Object]）', () => {
    expect(formatArgs([{ a: 1 }])).toEqual(['{"a":1}'])
  })

  it('对象 + 非字符串第二参只序列化对象本身', () => {
    expect(formatArgs([{ a: 1 }, 42])).toEqual(['{"a":1}'])
  })
})

describe('createLogger 毫秒时间戳', () => {
  it('文件与终端日志时间精确到毫秒（yyyy-MM-dd HH:mm:ss.SSS）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-log-ms-'))
    const logger = createLogger({
      storage: { logDir: dir, logLevel: 'info', prettyColorize: false, logRetainDays: 2 },
    } as never)
    logger.info('毫秒测试')
    await new Promise<void>((r) => shutdown(() => r()))
    const line = readFileSync(join(dir, 'app.log'), 'utf-8').trim()
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] INFO 毫秒测试$/)
  })
})
