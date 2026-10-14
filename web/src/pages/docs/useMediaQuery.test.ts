import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMediaQuery } from './useMediaQuery'

describe('useMediaQuery', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', { writable: true, value: originalMatchMedia })
  })

  it('匹配查询时返回 true', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((q: string) => ({
        matches: q.includes('max-width'),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    const { result } = renderHook(() => useMediaQuery('(max-width: 900px)'))
    expect(result.current).toBe(true)
  })

  it('不匹配查询时返回 false', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((q: string) => ({
        matches: false,
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    })
    const { result } = renderHook(() => useMediaQuery('(max-width: 900px)'))
    expect(result.current).toBe(false)
  })
})
