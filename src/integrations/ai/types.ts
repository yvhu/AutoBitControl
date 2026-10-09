/**
 * AI 客户端类型定义（integrations/ai 层）：OpenAI 兼容协议的请求/响应类型
 * 依赖方向：纯类型定义，无运行时依赖，供 openai-compatible 与上层消费
 */

export type ChatRole = 'system' | 'user'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatOptions {
  maxTokens?: number
  temperature?: number
  json?: boolean
  timeoutMs?: number
}

export interface AiClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>
}
