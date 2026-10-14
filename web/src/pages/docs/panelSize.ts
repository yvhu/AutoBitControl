/**
 * 文档页左树面板宽度持久化：读取/写入 localStorage，并对非法值钳制到合法区间。
 * 依赖方向：无（仅浏览器存储）。
 */

export const PANEL_SIZE_STORAGE_KEY = 'docs:panelSize'
export const PANEL_DEFAULT_SIZE = 300
export const PANEL_MIN_SIZE = 220
export const PANEL_MAX_SIZE = 480

// 把任意数值收敛到 [min, max]；非有限数（NaN/Infinity）回落到默认宽度
export function clampPanelSize(value: number): number {
  if (!Number.isFinite(value)) return PANEL_DEFAULT_SIZE
  return Math.min(PANEL_MAX_SIZE, Math.max(PANEL_MIN_SIZE, value))
}

// 解析 localStorage 原始字符串：缺失/非法一律回落到默认宽度，合法值再钳制
export function parsePanelSize(raw: string | null): number {
  if (raw === null) return PANEL_DEFAULT_SIZE
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return PANEL_DEFAULT_SIZE
  return clampPanelSize(parsed)
}

export function readStoredPanelSize(): number {
  try {
    return parsePanelSize(localStorage.getItem(PANEL_SIZE_STORAGE_KEY))
  } catch {
    return PANEL_DEFAULT_SIZE
  }
}

// 折叠时 Splitter 会给出 0：非正数视为无效，不覆盖已存宽度
export function persistPanelSize(size: number): void {
  if (!Number.isFinite(size) || size <= 0) return
  try {
    localStorage.setItem(PANEL_SIZE_STORAGE_KEY, String(clampPanelSize(size)))
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
