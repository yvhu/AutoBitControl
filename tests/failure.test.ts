import { describe, it, expect } from 'vitest'
import { classifyFailure } from '../src/engine/failure'
import { TaskExecutionError, TaskTimeoutError, WindowUnavailableError } from '../src/infrastructure/run-errors'

describe('classifyFailure', () => {
  it('显式窗口错误归为 environment', () => {
    expect(classifyFailure('task', new WindowUnavailableError('Target closed'))).toBe('environment')
  })

  it('显式任务错误归为 task', () => {
    expect(classifyFailure('task', new TaskExecutionError('选择器失效'))).toBe('task')
  })

  it('超时归为 timeout', () => {
    expect(classifyFailure('task', new TaskTimeoutError('任务超时'))).toBe('timeout')
  })

  it('开窗/CDP 阶段默认 environment', () => {
    expect(classifyFailure('open', new Error('open boom'))).toBe('environment')
    expect(classifyFailure('connect', new Error('connect boom'))).toBe('environment')
  })

  it('常见窗口/网络消息归为 environment', () => {
    for (const message of [
      'Protocol error',
      'Target closed',
      'session closed',
      '钱包扩展未加载',
      'net::ERR_PROXY_CONNECTION_FAILED',
      'ECONNREFUSED',
    ]) {
      expect(classifyFailure('task', new Error(message))).toBe('environment')
    }
  })

  it('未知错误默认 task', () => {
    expect(classifyFailure('task', new Error('选择器没找到'))).toBe('task')
  })

  it('Navigation failed 不误判为窗口环境失败', () => {
    expect(classifyFailure('task', new Error('Navigation failed'))).toBe('task')
  })
})
