/**
 * DOM 探针原语（automation/dom 层）：统一「文案 / 选择器 / gone」定位与命中判定，供竞速、恢复与等待复用
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
 * 命中探针（等待/命中场景的扩展形态）：在 Probe 基础上增加「字符串」（等价文案）与
 * 「gone」（目标不可见或已消失）两种形态，让命中判定与等待复用同一套结构。
 */
export type HitProbe = string | Probe | { gone: string }

/**
 * 把探针翻译成 patchright 的 Locator（定位句柄）。
 * 执行流程：字符串或带 text 字段走 getByText 并设 exact:false 做包含匹配（允许文案前后还有其它字符）；
 * 带 selector 或 gone 字段按其中的选择器走 locator。
 * @param page 目标页面（patchright 的 Page）
 * @param probe 待解析的探针
 * @returns 仅表达「如何查找」、尚未锁定具体元素的 Locator，调用方可继续 .first()/.waitFor() 等
 */
export function probeLocator(page: Page, probe: HitProbe): Locator {
  if (typeof probe === 'string') return page.getByText(probe, { exact: false })
  if ('text' in probe) return page.getByText(probe.text, { exact: false })
  return page.locator('selector' in probe ? probe.selector : probe.gone)
}

/**
 * 命中判定（探针统一入口，waitFor/race/recover 共用，单一事实源）。
 * 执行流程：字符串或 { text } 按「存在」判定（count>0，不判可见性，兼容双 DOM/动画态）；
 * { selector } 按「存在且可见」判定；{ gone } 按「不存在或不可见」判定。
 * 整个过程包在 try 中——探测本身的异常不应中断流程：普通探针异常按「未命中」返回 false，
 * 而 gone 探针「查不到元素」本就是命中，故异常时返回 true。
 * @param page 目标页面
 * @param probe 待探测的目标
 * @returns 探针此刻是否命中
 */
export async function probeHit(page: Page, probe: HitProbe): Promise<boolean> {
  try {
    if (typeof probe === 'string') return (await page.getByText(probe, { exact: false }).count()) > 0
    if ('text' in probe) return (await page.getByText(probe.text, { exact: false }).count()) > 0
    const sel = 'selector' in probe ? probe.selector : probe.gone
    const loc = page.locator(sel).first()
    if ('selector' in probe) {
      if ((await loc.count()) === 0) return false
      return await loc.isVisible()
    }
    if ((await loc.count()) === 0) return true
    return !(await loc.isVisible().catch(() => false))
  } catch {
    return typeof probe !== 'string' && 'gone' in probe
  }
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

/** 探针当前是否"命中"：委托 probeHit（文案按存在判定、选择器按可见判定），保持与命中内核单一事实源 */
export async function probePresent(page: Page, probe: Probe): Promise<boolean> {
  return probeHit(page, probe)
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
export function probeDesc(probe: HitProbe): string {
  if (typeof probe === 'string') return `文案 ${probe}`
  if ('text' in probe) return `文案 ${probe.text}`
  if ('selector' in probe) return `选择器 ${probe.selector}`
  return `消失 ${probe.gone}`
}
