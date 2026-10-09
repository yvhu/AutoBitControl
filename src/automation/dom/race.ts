/**
 * 多探针竞速（automation/dom 层）：任一探针先可见则返回其键，都等不到返回 null
 * 依赖方向：依赖 ./probe 与 patchright 类型
 */
import type { Page } from 'patchright'
import { probeLocator, type Probe } from './probe'

export async function raceProbes<K extends string>(
  page: Page,
  entries: Array<[K, Probe]>,
  timeoutMs: number,
): Promise<K | null> {
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
