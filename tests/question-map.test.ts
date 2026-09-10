import { describe, it, expect } from 'vitest'
import { mapQuestionId } from '../src/automation/captcha/question-map'

describe('mapQuestionId 提示语映射', () => {
  it('中文提示语命中官方问题 ID', () => {
    expect(mapQuestionId('停车计时器')).toBe('/m/015qbp')
    expect(mapQuestionId('消防栓')).toBe('/m/01pns0')
  })

  it('英文提示语命中（官方 DEMO 表）', () => {
    expect(mapQuestionId('traffic lights')).toBe('/m/015qff')
  })

  it('未覆盖提示语返回 null', () => {
    expect(mapQuestionId('潜水艇')).toBeNull()
  })

  it('空串返回 null', () => {
    expect(mapQuestionId('  ')).toBeNull()
  })
})
