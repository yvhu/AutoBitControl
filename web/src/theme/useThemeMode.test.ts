import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useThemeMode } from './useThemeMode'

describe('useThemeMode', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: originalMatchMedia })
  })

  it('默认 system', () => {
    const { result } = renderHook(() => useThemeMode())
    expect(result.current.mode).toBe('system')
  })

  it('localStorage 持久化选择', () => {
    localStorage.setItem('abc-theme', 'dark')
    const { result } = renderHook(() => useThemeMode())
    expect(result.current.mode).toBe('dark')
  })

  it('localStorage 非法值回落 system', () => {
    localStorage.setItem('abc-theme', 'abc')
    const { result } = renderHook(() => useThemeMode())
    expect(result.current.mode).toBe('system')
  })

  it('setMode 写入 localStorage', () => {
    const { result } = renderHook(() => useThemeMode())
    act(() => result.current.setMode('light'))
    expect(result.current.mode).toBe('light')
    expect(localStorage.getItem('abc-theme')).toBe('light')
  })

  it('system 态跟随 prefers-color-scheme', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((q: string) => ({
        matches: q.includes('dark'),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    const { result } = renderHook(() => useThemeMode())
    expect(result.current.effective).toBe('dark')
  })
})
