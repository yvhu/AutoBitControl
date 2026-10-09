/**
 * OpenAI 兼容 AI 客户端（integrations/ai 层）：封装 chat/completions 调用
 * 依赖方向：integrations → infrastructure（httpJson），仅出站 HTTP
 * 设计思路：apiBase 可指向任意 OpenAI 兼容服务；apiKey 缺失时快速失败
 */
import { httpJson } from '../../infrastructure/http'
import type { AiClient, ChatMessage, ChatOptions } from './types'

interface ChatResp {
  choices?: Array<{ message?: { content?: string } }>
}

export function createAiClient(cfg: {
  apiBase: string
  model: string
  apiKey: string
  timeoutMs: number
}): AiClient {
  return {
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
      if (!cfg.apiKey) throw new Error('AI 未配置（AI_API_KEY）')
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages,
        max_tokens: opts.maxTokens ?? 300,
      }
      if (opts.temperature !== undefined) body.temperature = opts.temperature
      if (opts.json) body.response_format = { type: 'json_object' }
      const res = await httpJson<ChatResp>({
        baseUrl: cfg.apiBase,
        path: '/chat/completions',
        method: 'POST',
        timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body,
      })
      return (res.choices?.[0]?.message?.content ?? '').trim()
    },
  }
}
