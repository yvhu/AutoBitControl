import { describe, it, expect } from 'vitest'
import { formatArgs } from '../src/infrastructure/logger'

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
})
