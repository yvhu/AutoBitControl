/**
 * ai 能力出口（integrations/ai 层）：OpenAI 兼容客户端与类型统一再导出
 * 依赖方向：汇总本目录实现，供上层（engine/tasks/server）统一导入
 */
export { createAiClient } from './openai-compatible'
export type { AiClient, ChatMessage, ChatOptions, ChatRole } from './types'
