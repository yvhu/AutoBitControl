/**
 * AI 能力函数（api 层）：任意提问 / 页面问答
 * 依赖方向：engine TaskContext 类型、api/find 的 getText
 */
import type { TaskContext } from '../engine/task-context'
import { getText } from './find'

/** 低层：问 AI 要一段文本（system 可选） */
export async function askAi(ctx: TaskContext, prompt: string, options: { system?: string; maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  if (!ctx.ai) throw new Error('AI 未配置（AI_API_KEY）')
  const messages = [
    ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
    { role: 'user' as const, content: prompt },
  ]
  return ctx.ai.chat(messages, { maxTokens: options.maxTokens, timeoutMs: options.timeoutMs })
}

/** 解析 AI 答案为选项序号（越界/解析不出返回 null） */
function parseIndex(answer: string, match: 'letter' | 'index' | 'text', optionTexts: string[], n: number): number | null {
  const a = answer.trim()
  if (match === 'letter') {
    const m = a.match(/[A-Za-z]/)
    if (!m) return null
    const idx = m[0].toUpperCase().charCodeAt(0) - 65
    return idx >= 0 && idx < n ? idx : null
  }
  if (match === 'index') {
    const m = a.match(/\d+/)
    if (!m) return null
    const idx = Number(m[0]) - 1
    return idx >= 0 && idx < n ? idx : null
  }
  // text：找与答案文本最匹配的选项
  const idx = optionTexts.findIndex((t) => t && a.includes(t))
  return idx >= 0 ? idx : null
}

/** 页面问答：读题干+选项 → 问 AI → 选并点击；解析失败兜底随机点一项（答了就算成功） */
export async function answerQuiz(ctx: TaskContext, spec: { question: string | { selector: string }; options: { selector: string }; match?: 'letter' | 'index' | 'text' }): Promise<{ answer: string; clicked: boolean; fallback: boolean }> {
  const question = typeof spec.question === 'string' ? spec.question : await getText(ctx, spec.question.selector)
  const loc = ctx.page.locator(spec.options.selector)
  const n = await loc.count()
  if (n === 0) throw new Error(`未找到选项元素: ${spec.options.selector}`)
  const texts: string[] = []
  for (let i = 0; i < n; i++) texts.push(((await loc.nth(i).textContent()) ?? '').trim())
  const list = texts.map((t, i) => `${String.fromCharCode(65 + i)}. ${t}`).join('\n')
  const answer = await askAi(ctx, `${question}\n\n${list}`, { system: '你是答题助手，只输出一个选项字母（如 A），不要解释。' })
  const idx = parseIndex(answer, spec.match ?? 'letter', texts, n)
  if (idx === null) {
    const rand = Math.floor(Math.random() * n)
    await loc.nth(rand).click()
    ctx.log.warn({ step: 'quiz', window: ctx.profile.name, answer, n }, 'AI 答案无法解析，兜底随机作答')
    return { answer, clicked: true, fallback: true }
  }
  await loc.nth(idx).click()
  ctx.log.info({ step: 'quiz', window: ctx.profile.name, answer, idx }, 'AI 作答并点击选项')
  return { answer, clicked: true, fallback: false }
}
