/**
 * 左树面板宽度持久化单测：非法值回落默认、越界钳制、正数才覆盖已存值。
 * 依赖方向：jsdom 提供的 localStorage。
 */
import { beforeEach, describe, it, expect } from 'vitest'
import {
  PANEL_DEFAULT_SIZE,
  PANEL_MAX_SIZE,
  PANEL_MIN_SIZE,
  PANEL_SIZE_STORAGE_KEY,
  clampPanelSize,
  parsePanelSize,
  persistPanelSize,
  readStoredPanelSize,
} from './panelSize'

describe('clampPanelSize', () => {
  it('非有限数回落默认宽度', () => {
    expect(clampPanelSize(NaN)).toBe(PANEL_DEFAULT_SIZE)
    expect(clampPanelSize(Infinity)).toBe(PANEL_DEFAULT_SIZE)
  })

  it('低于下限取最小值、高于上限取最大值', () => {
    expect(clampPanelSize(100)).toBe(PANEL_MIN_SIZE)
    expect(clampPanelSize(9999)).toBe(PANEL_MAX_SIZE)
    expect(clampPanelSize(350)).toBe(350)
  })
})

describe('parsePanelSize', () => {
  it('缺失或非法字符串回落默认宽度', () => {
    expect(parsePanelSize(null)).toBe(PANEL_DEFAULT_SIZE)
    expect(parsePanelSize('abc')).toBe(PANEL_DEFAULT_SIZE)
  })

  it('合法数值按区间钳制', () => {
    expect(parsePanelSize('100')).toBe(PANEL_MIN_SIZE)
    expect(parsePanelSize('9999')).toBe(PANEL_MAX_SIZE)
    expect(parsePanelSize('360')).toBe(360)
  })
})

describe('面板宽度读写', () => {
  beforeEach(() => {
    localStorage.removeItem(PANEL_SIZE_STORAGE_KEY)
  })

  it('写入后可按原值读回', () => {
    persistPanelSize(260)
    expect(readStoredPanelSize()).toBe(260)
  })

  it('写入越界值按上限钳制', () => {
    persistPanelSize(9999)
    expect(readStoredPanelSize()).toBe(PANEL_MAX_SIZE)
  })

  it('非正数（折叠态）不覆盖已存宽度', () => {
    persistPanelSize(320)
    persistPanelSize(0)
    expect(readStoredPanelSize()).toBe(320)
  })

  it('无存储记录时读回默认宽度', () => {
    expect(readStoredPanelSize()).toBe(PANEL_DEFAULT_SIZE)
  })
})
