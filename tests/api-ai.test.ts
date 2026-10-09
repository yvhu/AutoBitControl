/**
 * api/ai 单测：askAi / answerQuiz 的问答与兜底逻辑（注入假 ctx，不连真实 AI/浏览器）
 */
import { describe, it, expect, vi } from 'vitest'
import { askAi, answerQuiz } from '../src/api'

interface QuizFake {
  texts?: string[]
  answer?: string
  noAi?: boolean
}

/** 构造假 ctx：page.locator 支持 count/first/nth(textContent/click)，ai.chat mock */
function makeQuizCtx(opts: QuizFake = {}) {
  const clicks: number[] = []
  const loc = {
    count: async () => (opts.texts ?? []).length,
    first: () => ({ textContent: async () => '题干文本' }),
    nth: (i: number) => ({
      textContent: async () => opts.texts?.[i] ?? '',
      click: async () => {
        clicks.push(i)
      },
    }),
  }
  const chat = vi.fn().mockResolvedValue(opts.answer ?? 'B')
  const ctx = {
    page: { locator: () => loc },
    ai: opts.noAi ? undefined : { chat },
    log: { info: vi.fn(), warn: vi.fn() },
    profile: { name: '窗口1' },
  }
  return { ctx: ctx as never, clicks, chat, log: ctx.log }
}

describe('api/ai askAi', () => {
  it('未注入 ai 时抛「AI 未配置（AI_API_KEY）」', async () => {
    const { ctx } = makeQuizCtx({ noAi: true })
    await expect(askAi(ctx, 'hi')).rejects.toThrow('AI 未配置（AI_API_KEY）')
  })

  it('透传 system 与用户消息，返回 chat 结果', async () => {
    const { ctx, chat } = makeQuizCtx({ answer: ' B ' })
    const out = await askAi(ctx, '问题', { system: '只输出字母', maxTokens: 12, timeoutMs: 999 })
    expect(out).toBe(' B ')
    expect(chat).toHaveBeenCalledWith(
      [
        { role: 'system', content: '只输出字母' },
        { role: 'user', content: '问题' },
      ],
      { maxTokens: 12, timeoutMs: 999 },
    )
  })
})

describe('api/ai answerQuiz', () => {
  it("AI 答 'B' → 点第 1 个选项（0 基），fallback:false", async () => {
    const { ctx, clicks } = makeQuizCtx({ texts: ['甲', '乙', '丙'], answer: 'B' })
    const res = await answerQuiz(ctx, { question: '题干', options: { selector: '.opt' } })
    expect(res).toEqual({ answer: 'B', clicked: true, fallback: false })
    expect(clicks).toEqual([1])
  })

  it('默认 match 为 letter，system 提示要求输出字母', async () => {
    const { ctx, chat } = makeQuizCtx({ texts: ['甲', '乙'], answer: 'A' })
    await answerQuiz(ctx, { question: '题干', options: { selector: '.opt' } })
    expect(chat.mock.calls[0][0][0]).toEqual({ role: 'system', content: expect.stringContaining('字母') })
  })

  it('题干用选择器时经 getText 读取', async () => {
    const { ctx, chat } = makeQuizCtx({ texts: ['甲', '乙'], answer: 'A' })
    await answerQuiz(ctx, { question: { selector: '#q' }, options: { selector: '.opt' } })
    expect(chat.mock.calls[0][0][1].content).toContain('题干文本')
  })

  it('AI 返回乱码 → 兜底随机点击一项，fallback:true 且告警', async () => {
    const { ctx, clicks, log } = makeQuizCtx({ texts: ['甲', '乙', '丙'], answer: '???' })
    const res = await answerQuiz(ctx, { question: '题干', options: { selector: '.opt' } })
    expect(res.fallback).toBe(true)
    expect(res.clicked).toBe(true)
    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toBeGreaterThanOrEqual(0)
    expect(clicks[0]).toBeLessThan(3)
    expect(log.warn).toHaveBeenCalled()
  })

  it('AI 字母越界（选项数不足）也走兜底', async () => {
    const { ctx, clicks } = makeQuizCtx({ texts: ['甲', '乙'], answer: 'Z' })
    const res = await answerQuiz(ctx, { question: '题干', options: { selector: '.opt' } })
    expect(res.fallback).toBe(true)
    expect(clicks).toHaveLength(1)
  })

  it('match:index 按下标选择（1 基）', async () => {
    const { ctx, clicks, chat } = makeQuizCtx({ texts: ['甲', '乙', '丙'], answer: '3' })
    const res = await answerQuiz(ctx, { question: '题干', options: { selector: '.opt' }, match: 'index' })
    expect(res).toEqual({ answer: '3', clicked: true, fallback: false })
    expect(clicks).toEqual([2])
    expect(chat.mock.calls[0][0][0].content).toContain('序号')
  })

  it('match:text 按选项文本匹配', async () => {
    const { ctx, clicks, chat } = makeQuizCtx({ texts: ['苹果', '香蕉'], answer: '我选香蕉' })
    const res = await answerQuiz(ctx, { question: '题干', options: { selector: '.opt' }, match: 'text' })
    expect(res.fallback).toBe(false)
    expect(clicks).toEqual([1])
    expect(chat.mock.calls[0][0][0].content).toContain('文本')
  })

  it('无选项元素 → 抛错', async () => {
    const { ctx } = makeQuizCtx({ texts: [] })
    await expect(
      answerQuiz(ctx, { question: '题干', options: { selector: '.opt' } }),
    ).rejects.toThrow('未找到选项元素')
  })
})
