import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

const KEY = 'abc-theme'
const EVENT = 'abc-theme-change'

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function readStored(): ThemeMode {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode>(readStored)
  const [system, setSystem] = useState<boolean>(() => systemDark())

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const onChange = () => setModeState(readStored())
    window.addEventListener(EVENT, onChange)
    return () => window.removeEventListener(EVENT, onChange)
  }, [])

  const setMode = useCallback((m: ThemeMode) => {
    localStorage.setItem(KEY, m)
    setModeState(m)
    window.dispatchEvent(new CustomEvent(EVENT))
  }, [])

  return { mode, setMode, effective: mode === 'system' ? (system ? 'dark' : 'light') : mode }
}
