/**
 * 多探针竞速（automation/dom 层）：任一探针先可见则返回其键，都等不到返回 null
 * 依赖方向：依赖 ./probe 与 patchright 类型
 */
import type { Page } from 'patchright'
import { probeLocator, type Probe } from './probe'

/**
 * 多探针竞速：同时监视若干 UI 目标，返回「最先变为可见」的那个的键。
 * 执行流程：空数组直接返回 null（否则 Promise.race([]) 永不 settle，会让调用方悬挂）；
 * 否则为每个条目各起一个等待任务——解析出 Locator、取首个元素、waitFor 可见状态至多 timeoutMs，
 * 成功则 resolve 自己的键、超时/异常则 resolve null；再用 Promise.race 取最先落定的结果。
 * @param page 目标页面
 * @param entries 键与探针的配对数组，键是调用方约定的语义标签（如 'loggedIn'），用于区分谁先出现
 * @param timeoutMs 单个探针的最长等待毫秒数（所有探针同时开始计时）
 * @returns 最先可见探针的键；预算内均未出现返回 null（不抛错）
 */
export async function raceProbes<K extends string>(
  page: Page,
  entries: Array<[K, Probe]>,
  timeoutMs: number,
): Promise<K | null> {
  // 空数组时 Promise.race([]) 永不 settle，直接返回 null 防止调用方悬挂
  if (entries.length === 0) return null
  const r = await Promise.race(
    entries.map(([k, probe]) =>
      probeLocator(page, probe)
        .first()
        .waitFor({ state: 'visible', timeout: timeoutMs })
        .then(() => k)
        .catch(() => null),
    ),
  )
  return r ?? null
}
