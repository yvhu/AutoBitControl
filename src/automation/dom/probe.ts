/**
 * DOM 探针原语（automation/dom 层）：统一「文案 / 选择器」两种定位，供竞速与恢复复用
 * 依赖方向：仅依赖 patchright，被 dom 内 race/recover 与 engine 使用
 */
import type { Locator, Page } from 'patchright'

/**
 * 探针：对一处 UI 目标的声明式描述，让任务与引擎用统一结构表达「要找什么」。
 * 两种形态二选一——带 text 字段表示按可见文案「包含匹配」（不要求完全相等，页面上任意含该文案的元素都可命中）；
 * 带 selector 字段表示按 CSS 选择器定位。文案更贴近用户视角、抗样式改版；选择器更精确、抗文案改版。
 */
export type Probe = { text: string } | { selector: string }

/**
 * 把探针翻译成 patchright 的 Locator（定位句柄）。
 * 执行流程：若探针带 text，走 getByText 并设 exact:false 做包含匹配（允许文案前后还有其它字符）；
 * 否则按 selector 走 locator。
 * @param page 目标页面（patchright 的 Page）
 * @param probe 待解析的探针
 * @returns 仅表达「如何查找」、尚未锁定具体元素的 Locator，调用方可继续 .first()/.waitFor() 等
 */
export function probeLocator(page: Page, probe: Probe): Locator {
  return 'text' in probe ? page.getByText(probe.text, { exact: false }) : page.locator(probe.selector)
}

/**
 * 判断探针当前是否「存在且可见」。
 * 执行流程：先解析出 Locator 并取首个匹配元素；若匹配数为 0 直接判不可见；
 * 否则调用 isVisible 返回真实可见性。整个过程包在 try 中——元素不存在、查找超时、
 * 页面已跳转等任何异常都按「不可见」处理，绝不向调用方抛错（探测语义不应因探测本身而中断流程）。
 * @param page 目标页面
 * @param probe 待探测的目标
 * @returns 目标元素此刻是否可见
 */
export async function probeVisible(page: Page, probe: Probe): Promise<boolean> {
  try {
    const loc = probeLocator(page, probe).first()
    if ((await loc.count()) === 0) return false
    return await loc.isVisible()
  } catch {
    return false
  }
}

/**
 * 在页面里依次查找一组文案，返回第一个「出现」的文案。
 * 执行流程：逐个对每条文案调用 getByText(...).count()，命中数大于 0 即视为出现并立即返回；
 * 单条文案查询抛错只跳过它、继续查下一条（不让一条坏文案拖垮整轮探测）。
 * @param page 目标页面
 * @param texts 候选文案列表（按传入顺序决定优先级）
 * @returns 首个出现的文案；全部未出现返回空串 ''
 */
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

/**
 * 生成探针的可读中文描述，用于日志与错误信息——把结构化探针还原成「文案 xxx」或「选择器 xxx」。
 * @param probe 待描述的探针
 * @returns 可直接拼进日志/错误消息的字符串
 */
export function probeDesc(probe: Probe): string {
  return 'text' in probe ? `文案 ${probe.text}` : `选择器 ${probe.selector}`
}
