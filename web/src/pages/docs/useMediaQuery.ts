/**
 * 媒体查询订阅 Hook：返回当前视口是否匹配查询，用于文档页的响应式分栏。
 * 依赖方向：无（仅浏览器 matchMedia；非浏览器环境安全回落 false）。
 */

import { useEffect, useState } from 'react'

function matchesNow(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(query).matches
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesNow(query))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mq.addEventListener('change', onChange)
    setMatches(mq.matches)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}
