import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, act } from '@testing-library/react'
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

  it('跨实例同步：任一实例 setMode 后其它实例读同一存储值', () => {
    const refs: { first: ReturnType<typeof useThemeMode> | null; second: ReturnType<typeof useThemeMode> | null } = {
      first: null,
      second: null,
    }
    function First() {
      refs.first = useThemeMode()
      return null
    }
    function Second() {
      refs.second = useThemeMode()
      return null
    }
    render(
      <>
        <First />
        <Second />
      </>,
    )
    act(() => refs.first!.setMode('dark'))
    expect(refs.first!.mode).toBe('dark')
    expect(refs.second!.mode).toBe('dark')
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
