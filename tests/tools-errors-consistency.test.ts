/**
 * 工具错误码双表一致性防护测试：tools 与 server 两处错误码数值漂移时立即暴露
 * 依赖方向：仅读源码常量，不触达运行时
 */
import { describe, it, expect } from 'vitest'
import { TOOL_ERROR_CODES } from '../src/tools/errors'
import { ERROR_CODES } from '../src/server/http/errors'

describe('工具错误码双表一致性', () => {
  it('server 与 tools 数值一致', () => {
    for (const [key, value] of Object.entries(TOOL_ERROR_CODES)) {
      expect((ERROR_CODES as Record<string, number>)[key]).toBe(value)
    }
  })
})
