/**
 * useGuardedMutation（web 公共）：包装 useMutation，pending 或完成后 cooldownMs 内忽略重复 run
 * 依赖方向：仅依赖 @tanstack/react-query 与 react
 * 设计思路：非 Button 入口（Switch/菜单项/复选框）不便用加载态禁用，用本 hook 在逻辑层去重
 */
import { useCallback, useRef } from 'react'
import { useMutation, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query'

const DEFAULT_COOLDOWN_MS = 600

const DEFAULT_KEY = Symbol('default')

export function useGuardedMutation<TData, TError, TVariables, TContext>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
  opts: { cooldownMs?: number; getKey?: (vars: TVariables) => string | number } = {},
): UseMutationResult<TData, TError, TVariables, TContext> & { run: (vars: TVariables) => void } {
  const mutation = useMutation(options)
  const busyKeysRef = useRef<Set<string | number | symbol>>(new Set())
  const coolUntilRef = useRef<Map<string | number | symbol, number>>(new Map())
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const getKey = opts.getKey
  const mutate = mutation.mutate
  const run = useCallback((vars: TVariables) => {
    // getKey 可按变量区分守卫（如逐条待办勾选）；缺省全局单键
    const key = getKey ? getKey(vars) : DEFAULT_KEY
    if (busyKeysRef.current.has(key) || Date.now() < (coolUntilRef.current.get(key) ?? 0)) return
    busyKeysRef.current.add(key)
    mutate(vars, {
      onSettled: () => {
        busyKeysRef.current.delete(key)
        coolUntilRef.current.set(key, Date.now() + cooldownMs)
      },
    })
  }, [mutate, cooldownMs, getKey])
  return { ...mutation, run }
}
