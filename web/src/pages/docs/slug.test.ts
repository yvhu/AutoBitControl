import { describe, it, expect } from 'vitest'
import { slugify } from './slug'

describe('slugify', () => {
  it('序号点与空格 → 连字符（9. 常用模式）', () => {
    expect(slugify('9. 常用模式')).toBe('9-常用模式')
  })

  it('去全角括号（6. 拟人接口（Humanizer））', () => {
    expect(slugify('6. 拟人接口（Humanizer）')).toBe('6-拟人接口humanizer')
  })

  it('纯中文标题原样保留（任务开发与测试）', () => {
    expect(slugify('任务开发与测试')).toBe('任务开发与测试')
  })

  it('首尾空白去除 + 英文转小写（TaskContext 方法全解）', () => {
    expect(slugify('  TaskContext 方法全解 ')).toBe('taskcontext-方法全解')
  })
})
