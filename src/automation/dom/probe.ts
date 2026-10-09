/**
 * DOM 探针原语（automation/dom 层）：统一「文案 / 选择器」两种定位，供竞速与恢复复用
 * 依赖方向：仅依赖 patchright，被 dom 内 race/recover 与 engine 使用
 */
import type { Locator, Page } from 'patchright'

/** 探针：命中文案（包含匹配）或命中选择器 */
export type Probe = { text: string } | { selector: string }

/** 探针 -> Locator */
export function probeLocator(page: Page, probe: Probe): Locator {
  return 'text' in probe ? page.getByText(probe.text, { exact: false }) : page.locator(probe.selector)
}

/** 探针当前是否可见（不存在/异常按不可见处理，不抛错） */
export async function probeVisible(page: Page, probe: Probe): Promise<boolean> {
  try {
    const loc = probeLocator(page, probe).first()
    if ((await loc.count()) === 0) return false
    return await loc.isVisible()
  } catch {
    return false
  }
}

/** 任一文案是否出现在页面（包含匹配），命中返回该文案，否则空串 */
export async function firstTextPresent(page: Page, texts: string[]): Promise<string> {
  for (const t of texts) {
    try {
      if ((await page.getByText(t, { exact: false }).count()) > 0) return t
    } catch {
      // 单条文案查询失败不影响其余
    }
  }
  return ''
}

/** 探针的可读描述（拼错误/日志用） */
export function probeDesc(probe: Probe): string {
  return 'text' in probe ? `文案 ${probe.text}` : `选择器 ${probe.selector}`
}
