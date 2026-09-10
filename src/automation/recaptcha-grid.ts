/**
 * reCAPTCHA 九宫格模拟点击求解（automation 层）：点复选框 → 容器元素截图网格 → yescaptcha 分类 →
 * 按坐标点选（官方 DEMO verify_single_captcha 流程：点前记录该格 img src0 → 拟人点击 → 刷新监测轮询
 * （REFRESH_WATCH_MS 窗口/500ms 间隔：src 变化 = 图片自动刷新新图；class 稳定选中 = 直接完成；
 * 超时无变化无选中 = 点击未注册 warn 不重试）→ 刷新发生后等新图稳定（1.5-2.5s）→ 截图该格 img 做
 * 1x1 分类（hasObject）→ 新图仍是目标才再点该格确认（可能又刷新 → 重新监测 → 下一轮确认，
 * 最多 CONFIRM_MAX 轮）；新图不是目标/截图分类失败 → 完成（select-more 兜底）——
 * 再点与否由 hasObject 决定，绝不盲目再点）→ 点验证前全体动态确认检查 → 验证 → 查 aria-checked →
 * 未通过则下一轮，直到变绿；
 * 挑战 frame 未出现且未变绿时每轮重点 1 次锚点自纠（窗口 92 实证首次点击可能未注册）
 * 真机核实（2026-09-09，faucet.circle.com）：挑战为 reCAPTCHA Enterprise
 * （anchor iframe: recaptcha/enterprise/anchor；网格 iframe: recaptcha/enterprise/bframe），
 * 兼容普通版（recaptcha/api2/anchor / api2/bframe）；正确确认机制为 yescaptcha 官方 Python 教程
 * verify_single_captcha 逻辑（2026-09-10 用户纠正）：点格子后该格图片可能自动刷新新图
 * （刷新在点击后 1-6 秒发生、img src 会变；dynamic-selected=刷新中、tileselected=稳定选中），
 * 对新图做 1x1 分类决定是否再点（旧 fix16「class 含 dynamic-selected 就盲目再点确认」为错误实现已删除）；
 * 全部格子点完后等全体动画收尾再点验证（真机观察：图片还在变化时点 verify，Google 判选择未完成刷题）；
 * 点 verify 前已点格子 class 仍含 dynamic-selected 再等最多 5s（500ms 轮询），仍存在则 warn 照常 verify；
 * 点 verify 前轮询等验证按钮可见（count>0 且 isVisible，约 8s/500ms，勿用 waitFor 30s 默认超时）：
 * 按钮一直不可见 = 选择未完成（点击未注册）→ 补点本轮 class 不含 selected 的格子后再等（约 5s），
 * 仍不可见则放弃本轮（主循环下一轮处理）；按钮可见后点 verify（拟人坐标点击 + locator 兜底）；
 * 点 verify 后轮询错误提示（最多 5s/500ms）：select-more 系列（选择不完整，Google 未刷题可补选）→
 * 重截图网格用 confidence 0.3 放宽阈值分类补选未点过的格子后重验（每轮最多 2 次，成本经 onLog 记账）；
 * incorrect（选错已刷题）→ 返回主循环下一轮；
 * 每轮结束输出 grid-round-state 状态快照日志（识别目标/点选格/错误提示/换图次数，数据收集用）；
 * 每次点格输出 grid-click-diag 点击诊断日志（点前全网格 src 快照 vs 确认流程后快照 → hitTiles 实际命中格 +
 * 前后 class）：hitTiles 空 = 未命中；含非目标格 = 坐标漂移到邻居；[idx] = 命中正确（真机漂移定位用）
 * 网格图一律走容器元素截图（2026-09-09 真机窗口 89：fetch 每格原图拼接拿到的内容与该格视觉图不符，
 * 方案已废弃），截图前先等 1.5-2.5s 随机动画稳定（shotGrid 内部另有 800ms 兜底）；
 * 截图中心裁剪正方形后等比缩放（杜绝容器非正方形时直接 resize 拉伸变形，真机分类空数组/
 * ERROR_GARBAGE_SAMPLE 高发与此相关），raw/std 双图落盘 data/screenshots/grid-debug 供真机诊断；
 * 挑战 frame 内点击一律走拟人坐标点击
 * （humanClickInFrame：frame 内元素中心 + frame 元素页面偏移 → human.clickAt 贝塞尔轨迹 CDP 派发；
 * 窗口 92 高频「点击可能未注册」——Google 忽略瞬移式程序化点击），拿不到坐标回退 locator 直点
 * 依赖方向：依赖 integrations/yescaptcha 类型，被 engine/task-context 包装调用
 */
import type { Page, Frame } from 'patchright'
import Jimp from 'jimp'
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CaptchaService, GridResult } from '../integrations/yescaptcha'
import type { Logger } from '../infrastructure/logger'
import type { Humanizer } from './humanize'

// —— 站点/Google 元素常量（真机核实）——
/** 锚点（复选框）frame URL 片段 */
export const ANCHOR_FRAME_PART = 'recaptcha/enterprise/anchor'
/** 挑战（九宫格）frame URL 片段 */
export const CHALLENGE_FRAME_PART = 'recaptcha/enterprise/bframe'
/** 锚点复选框元素 */
export const ANCHOR_SELECTOR = '#recaptcha-anchor'
/** 提示文字（目标物体名） */
export const PROMPT_SELECTOR = '.rc-imageselect-desc-wrapper strong'
/** 网格格子（td 顺序即序号：3x3 为 0-8，4x4 为 0-15） */
export const TILE_SELECTOR = '#rc-imageselect-target table td'
/** 验证按钮 */
export const VERIFY_SELECTOR = '#recaptcha-verify-button'
/** 刷新换图按钮（官方入口：点一次换一批新图，换图后提示语可能变化） */
export const RELOAD_SELECTOR = '#recaptcha-reload-button'
/** 每轮最多刷新换图次数（超出后空数组放弃本轮 / 抛错直接失败） */
export const RELOAD_MAX = 2
/** 网格容器（分类网格图按容器元素截图获取） */
export const GRID_SELECTOR = '#rc-imageselect-target'
/** 最大求解轮数 */
export const MAX_ROUNDS = 5
/** 点 verify 前轮询等验证按钮可见次数（500ms 间隔，首查立即 ≈ 8s 窗口） */
export const VERIFY_VISIBLE_POLLS = 16
/** 补点后再次等验证按钮可见次数（500ms 间隔，首查立即 ≈ 5s 窗口） */
export const VERIFY_VISIBLE_RETRY_POLLS = 10
/** 等验证按钮可见轮询间隔（毫秒） */
const VERIFY_VISIBLE_POLL_INTERVAL_MS = 500
/** 点击后刷新监测窗口（毫秒）：真机诊断图片刷新在点击后 1-6 秒发生，窗口需完整覆盖 */
export const REFRESH_WATCH_MS = 10000
/** 刷新监测轮询间隔（毫秒） */
export const REFRESH_POLL_MS = 500
/** 刷新确认循环最多轮数（官方 DEMO：每轮对新图 1x1 分类决定是否再点；超出后 warn 继续，select-more 兜底） */
export const CONFIRM_MAX = 2
/** 点 verify 前全体动态确认检查轮询次数（500ms 间隔，首查立即 ≈ 5s 窗口） */
const PREVERIFY_DYNAMIC_POLLS = 10
/** 提示语渲染等待上限（毫秒；bframe 网格 DOM 可能晚于 frame 注入渲染） */
export const PROMPT_WAIT_TIMEOUT_MS = 10000
/** 提示语轮询间隔（毫秒） */
export const PROMPT_POLL_MS = 500
/** 错误提示轮询超时（毫秒；verify 后最多等这么久看 Google 错误提示） */
const ERROR_HINT_POLL_TIMEOUT_MS = 5000
/** 错误提示轮询间隔（毫秒） */
const ERROR_HINT_POLL_INTERVAL_MS = 500
/** 单轮最多补选次数（选择不完整时放宽阈值补选；仍不完整则交主循环下一轮） */
export const SUPPLEMENT_MAX = 2
/** grid-debug 诊断目录文件数上限：写盘前超过则清空目录（保留诊断能力、防磁盘累积） */
const GRID_DEBUG_MAX_FILES = 40

/** 提示语 → 问题 ID 映射（中英双语；官方中文表 + DEMO 英文表合并；未覆盖的提示语任务会失败，按日志扩充） */
export const QUESTION_ID_MAP: Record<string, string> = {
  '出租车': '/m/0pg52', '巴士': '/m/01bjv', '公交车': '/m/01bjv', '校车': '/m/02yvhj',
  '摩托车': '/m/04_sv', '拖拉机': '/m/013xlm', '烟囱': '/m/01jk_4', '人行横道': '/m/014xcs',
  '红绿灯': '/m/015qff', '自行车': '/m/0199g', '停车计价表': '/m/015qbp', '停车计时器': '/m/015qbp',
  '汽车': '/m/0k4j', '车辆': '/m/0k4j', '桥': '/m/015kr', '船': '/m/019jd', '棕榈树': '/m/0cdl1',
  '山': '/m/09d_r', '山丘': '/m/09d_r', '消防栓': '/m/01pns0', '楼梯': '/m/01lynh',
  '过街人行道': '/m/014xcs', '人行道': '/m/014xcs', '小轿车': '/m/0k4j', '轿车': '/m/0k4j', '大巴': '/m/01bjv',
  '摩托': '/m/04_sv', '火车': '/m/07jdr', '卡车': '/m/07r04', '飞机': '/m/0cmf2', '商店': '/m/02y_9m3',
  '店面': '/m/02y_9m3', '店面门脸': '/m/02y_9m3', '邮箱': '/m/04w5f', '交通信号灯': '/m/015qff',
  'taxis': '/m/0pg52', 'taxi': '/m/0pg52', 'bus': '/m/01bjv', 'buses': '/m/01bjv', 'school bus': '/m/02yvhj',
  'motorcycles': '/m/04_sv', 'motorcycle': '/m/04_sv', 'tractors': '/m/013xlm', 'tractor': '/m/013xlm',
  'chimneys': '/m/01jk_4', 'chimney': '/m/01jk_4', 'crosswalks': '/m/014xcs', 'crosswalk': '/m/014xcs',
  'pedestrian crossings': '/m/014xcs', 'traffic lights': '/m/015qff', 'traffic light': '/m/015qff',
  'bicycles': '/m/0199g', 'bicycle': '/m/0199g', 'parking meters': '/m/015qbp', 'parking meter': '/m/015qbp',
  'cars': '/m/0k4j', 'car': '/m/0k4j', 'vehicles': '/m/0k4j', 'vehicle': '/m/0k4j',
  'bridges': '/m/015kr', 'bridge': '/m/015kr', 'boats': '/m/019jd', 'boat': '/m/019jd',
  'palm trees': '/m/0cdl1', 'palm tree': '/m/0cdl1', 'mountains or hills': '/m/09d_r', 'mountains': '/m/09d_r',
  'hills': '/m/09d_r', 'fire hydrant': '/m/01pns0', 'fire hydrants': '/m/01pns0', 'stairs': '/m/01lynh',
  'trucks': '/m/07r04', 'trains': '/m/07jdr', 'airplanes': '/m/0cmf2', 'mailboxes': '/m/04w5f', 'storefronts': '/m/02y_9m3',
}

/** 提示文字 → 问题 ID（先精确匹配，再子串包含；未覆盖返回 null） */
export function mapQuestionId(promptText: string): string | null {
  const t = promptText.trim()
  if (!t) return null
  if (QUESTION_ID_MAP[t]) return QUESTION_ID_MAP[t]
  for (const [key, id] of Object.entries(QUESTION_ID_MAP)) {
    if (t.includes(key)) return id
  }
  return null
}

/** 从 frame URL 提取 reCAPTCHA sitekey（k 参数；无则返回 null） */
function extractSiteKey(url: string): string | null {
  const m = url.match(/[?&]k=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

/**
 * 找锚点 frame（兼容 enterprise/api2 两种 URL）
 * @param excludeSiteKey 跳过的常驻 sitekey（如页面常驻 v3 锚点：k 相同时排除，避免点到无效果的 v3 复选框）
 */
export function findAnchorFrame(page: Page, excludeSiteKey?: string): Frame | null {
  return page.frames().find((f) => {
    if (!f.url().includes('recaptcha/enterprise/anchor') && !f.url().includes('recaptcha/api2/anchor')) return false
    return !excludeSiteKey || extractSiteKey(f.url()) !== excludeSiteKey
  }) ?? null
}

/** 找挑战（九宫格）frame；excludeSiteKey 语义同 findAnchorFrame（v3 bframe 同 sitekey 时排除） */
export function findChallengeFrame(page: Page, excludeSiteKey?: string): Frame | null {
  return page.frames().find((f) => {
    if (!f.url().includes('recaptcha/enterprise/bframe') && !f.url().includes('recaptcha/api2/bframe')) return false
    return !excludeSiteKey || extractSiteKey(f.url()) !== excludeSiteKey
  }) ?? null
}

/** 错误提示类型：'select-more' 选择不完整（未刷题，可补选）；'incorrect' 选错（已刷题）；null 无提示 */
export type GridErrorHint = 'select-more' | 'incorrect' | null

/**
 * 读取挑战 frame 内的错误提示（各候选元素按优先级检测，读文本非空即命中）
 * 元素不存在时先 count 判空再读文本：locator.textContent 对不存在元素会按默认 30s 超时等待，
 * 不做判空会把 5s 轮询预算耗死在单个选择器上（真机提示元素通常不常驻 DOM）
 */
export async function readErrorHint(ch: Frame): Promise<GridErrorHint> {
  const probes: Array<[string, GridErrorHint]> = [
    ['.rc-imageselect-error-select-more', 'select-more'],
    ['.rc-imageselect-error-select-something', 'select-more'],
    ['.rc-imageselect-error-dynamic-more', 'select-more'],
    ['.rc-imageselect-error-dynamic-select-more', 'select-more'],
    ['.rc-imageselect-incorrect-response', 'incorrect'],
  ]
  for (const [sel, kind] of probes) {
    const first = ch.locator(sel).first()
    if ((await first.count().catch(() => 0)) === 0) continue
    const t = ((await first.textContent().catch(() => '')) ?? '').trim()
    if (t) return kind
  }
  return null
}

/** verify 后轮询错误提示：最多 timeoutMs、间隔 500ms（首查立即；frame 引用失效按无提示处理） */
async function pollErrorHint(deps: { page: Page }, ch: Frame, timeoutMs: number): Promise<GridErrorHint> {
  const maxChecks = Math.ceil(timeoutMs / ERROR_HINT_POLL_INTERVAL_MS)
  for (let i = 0; i < maxChecks; i++) {
    const hint = await readErrorHint(ch).catch(() => null)
    if (hint) return hint
    if (i < maxChecks - 1) await deps.page.waitForTimeout(ERROR_HINT_POLL_INTERVAL_MS)
  }
  return null
}

/** PNG buffer 中心裁剪为正方形后等比缩放（容器非正方形时直接 resize 会拉伸变形；返回缩放后的图像对象） */
async function toStandardImage(buf: Buffer, size: number): Promise<Jimp> {
  const img = await Jimp.read(buf)
  const w = img.getWidth()
  const h = img.getHeight()
  const side = Math.min(w, h)
  if (w !== side || h !== side) {
    img.crop(Math.floor((w - side) / 2), Math.floor((h - side) / 2), side, side)
  }
  if (side !== size) await img.resize(size, size)
  return img
}

/** PNG buffer 中心裁剪为正方形后等比缩放到标准尺寸并转 Base64（无 data: 前缀；杜绝容器非正方形时的拉伸变形） */
export async function toStandardBase64(buf: Buffer, size: number): Promise<string> {
  const img = await toStandardImage(buf, size)
  return (await img.getBufferAsync(Jimp.MIME_PNG)).toString('base64')
}

/** 取 frame 内元素中心在页面坐标系的位置（frame 内坐标 + frame 元素页面偏移） */
async function framePoint(deps: { page: Page; human: Humanizer }, ch: Frame, frameSelector: string, nth = 0): Promise<{ x: number; y: number } | null> {
  const inner = await ch.locator(frameSelector).nth(nth).evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }).catch(() => null)
  if (!inner) return null
  let frameHandle: { evaluate: (fn: (el: HTMLElement) => { x: number; y: number }) => Promise<{ x: number; y: number }> } | null = null
  try {
    frameHandle = await ch.frameElement()
  } catch {
    frameHandle = null
  }
  if (!frameHandle) return null
  const outer = await frameHandle.evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect()
    return { x: r.x, y: r.y }
  }).catch(() => null)
  if (!outer) return null
  return { x: outer.x + inner.x, y: outer.y + inner.y }
}

/** 拟人点击 frame 内元素（framePoint 拿页面坐标 → human.clickAt 轨迹点击；失败回退 locator 直点） */
async function humanClickInFrame(deps: { page: Page; human: Humanizer }, ch: Frame, frameSelector: string, nth = 0): Promise<boolean> {
  const p = await framePoint(deps, ch, frameSelector, nth)
  if (!p) return false
  try {
    await deps.human.clickAt(p.x, p.y)
    return true
  } catch {
    return false
  }
}

/** 点刷新换图并等新一批图渲染（拟人坐标点击优先，失败回退 locator 直点；点击失败静默：部分主题下按钮瞬时不可点时由后续重试/下一轮兜底） */
async function reloadImages(deps: { page: Page; human: Humanizer }, ch: Frame): Promise<void> {
  if (!(await humanClickInFrame(deps, ch, RELOAD_SELECTOR))) {
    await ch.locator(RELOAD_SELECTOR).first().click({ timeout: 5000 }).catch(() => {})
  }
  // 2000-3000ms 随机：等 Google 换出并渲染新一批图（固定间隔同会话连续刷新有风控）
  await deps.page.waitForTimeout(2000 + Math.floor(Math.random() * 1000))
}

/** 读格子 td class（读失败返回空串）：带 1s 短超时，防止 locator 对不存在的格子死等默认 30s 超时 */
async function readTileClass(ch: Frame, idx: number): Promise<string> {
  return (await ch.locator(TILE_SELECTOR).nth(idx).getAttribute('class', { timeout: 1000 }).catch(() => null)) ?? ''
}

/** 读该格 img 的 src（点击后图片自动刷新时 src 会变；读失败返回空串）：1s 短超时防死等默认 30s */
async function readTileImgSrc(ch: Frame, idx: number): Promise<string> {
  return (await ch.locator(TILE_SELECTOR).nth(idx).locator('img').first().getAttribute('src', { timeout: 1000 }).catch(() => null)) ?? ''
}

/** 读全部格子 img src 快照（空串表示该格无 img 或读取失败）：点击诊断用，单次 evaluate 轻量读取 */
async function snapshotTileSrcs(ch: Frame): Promise<string[]> {
  return ch.evaluate(() =>
    Array.from(document.querySelectorAll('#rc-imageselect-target table td')).map((td) => {
      const img = td.querySelector('img')
      return img ? img.getAttribute('src') ?? '' : ''
    }),
  )
}

/** 轮询等验证按钮可见（count>0 且 isVisible；用 count/isVisible 而非 waitFor visible 的 30s 默认超时）：最多 polls 次、500ms 间隔，不可见返回 false */
async function waitVerifyVisible(deps: { page: Page }, ch: Frame, polls: number): Promise<boolean> {
  for (let i = 0; i < polls; i++) {
    const btn = ch.locator(VERIFY_SELECTOR).first()
    if ((await btn.count().catch(() => 0)) > 0) {
      if (await btn.isVisible().catch(() => false)) return true
    }
    if (i < polls - 1) await deps.page.waitForTimeout(VERIFY_VISIBLE_POLL_INTERVAL_MS)
  }
  return false
}

/** grid-debug 诊断目录防膨胀：文件数超过上限则清空目录（fs 操作 try/catch 静默，清理失败不影响任务） */
function pruneDebugDir(debugDir: string, maxFiles: number): void {
  try {
    if (!existsSync(debugDir)) return
    if (readdirSync(debugDir).length <= maxFiles) return
    for (const f of readdirSync(debugDir)) unlinkSync(join(debugDir, f))
  } catch { /* 清理失败静默 */ }
}

/**
 * 单轮：读提示语 → 截图网格 → 分类（可重试块：空数组/抛错时点刷新换图，每轮最多 RELOAD_MAX 次，
 * 换图后提示语可能变化必须重读）→ 点格子（官方 DEMO：点击后刷新监测（img src 变化）→
 * 新图 1x1 分类（hasObject）决定是否再点确认）→ 等验证按钮可见后点验证（点前全体动态确认检查）→
 * 错误提示检测
 * （按钮 8s 不可见 → 补点本轮未选中格后再等 5s，仍不可见放弃本轮；
 * select-more 选择不完整：放宽阈值 confidence 0.3 补选未点格子后重验，最多 SUPPLEMENT_MAX 次；
 * incorrect 选错：Google 已刷题，返回主循环下一轮）
 * 刷新重试后仍空数组：记 warn 返回（不点 verify，主循环查 aria-checked 未通过则下一轮）
 * 刷新重试后仍抛错：抛错（任务失败）；opts.onLog 透传给 solveGrid 做成本记账（含补选分类与单格 1x1 分类）
 * 每轮结束输出 grid-round-state 状态快照日志（数据收集）
 */
async function solveOneRound(deps: { page: Page; captcha: CaptchaService; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer }, ch: Frame, opts: { onLog?: (kind: string, ok: boolean, costPoints: number) => void } = {}): Promise<void> {
  const passOpts = { onLog: opts.onLog ?? (() => {}) }
  // 网格截图 10s 超时，失败 1 秒后重试一次，仍失败抛错（真机窗口 93 曾 30s 超时——元素动画中不稳定）
  const shotGrid = async (): Promise<Buffer> => {
    // 截图前先等 800ms：等上一动作/动画稳定（真机网格渲染未完成时截图内容错乱）
    await deps.page.waitForTimeout(800)
    let shot = await ch.locator(GRID_SELECTOR).first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
    if (!shot) {
      deps.logger.warn('九宫格网格截图失败（元素可能动画中），1 秒后重试一次')
      await deps.page.waitForTimeout(1000)
      shot = await ch.locator(GRID_SELECTOR).first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
    }
    if (!shot) throw new Error('九宫格网格截图重试后仍失败')
    return shot
  }
  // 网格标准尺寸：4x4 用 450、3x3 用 300（reload 循环内按 tileCount 更新）
  let gridSize = 300
  /** 网格截图 → 标准尺寸 PNG → Base64（无 data: 前缀）；诊断 raw/std 落盘静默（补选分类复用同链路） */
  const captureGridB64 = async (): Promise<string> => {
    const shot = await shotGrid()
    const debugDir = join(process.cwd(), 'data', 'screenshots', 'grid-debug')
    try {
      mkdirSync(debugDir, { recursive: true })
      pruneDebugDir(debugDir, GRID_DEBUG_MAX_FILES)
      writeFileSync(join(debugDir, `grid-raw-${Date.now()}.png`), shot)
    } catch { /* 诊断写盘失败静默 */ }
    const std = await (await toStandardImage(shot, gridSize)).getBufferAsync(Jimp.MIME_PNG)
    try {
      writeFileSync(join(debugDir, `grid-std-${Date.now()}.png`), std)
    } catch { /* 诊断写盘失败静默 */ }
    return std.toString('base64')
  }
  /**
   * 单格点选流程（官方 DEMO verify_single_captcha 逻辑）：点前记录全网格 src 快照与该格 class →
   * 拟人点击 + 刷新监测（clickAndWatch）→ 刷新发生走确认循环（confirmTileRefresh）→ 点击诊断日志
   * 主点选与补选共用
   */
  const clickTile = async (idx: number): Promise<void> => {
    // 点击诊断：点前记录全网格 src 快照与该格 class，确认流程结束后再读一次对比出实际命中的格子
    const gridBefore = await snapshotTileSrcs(ch)
    const beforeClass = await readTileClass(ch, idx)
    const refreshed = await clickAndWatch(idx)
    if (refreshed) await confirmTileRefresh(idx)
    const gridAfter = await snapshotTileSrcs(ch)
    const afterClass = await readTileClass(ch, idx)
    const hitTiles: number[] = []
    for (let i = 0; i < Math.max(gridBefore.length, gridAfter.length); i++) {
      if ((gridBefore[i] ?? '') !== (gridAfter[i] ?? '')) hitTiles.push(i)
    }
    // 结构化诊断日志（每格一次）：hitTiles 空 = 未命中；含非 idx 格 = 坐标漂移到邻居；[idx] = 命中正确
    deps.logger.info({ step: 'grid-click-diag', idx, hitTiles, beforeClass, afterClass }, '九宫格点击诊断')
  }
  /**
   * 拟人点击该格 + 刷新监测（官方 DEMO：点击后该格图片可能自动刷新新图，src 在点击后 1-6 秒变化）：
   * 点前读 img src0，点击后轮询（首查立即、REFRESH_POLL_MS 间隔、最多 REFRESH_WATCH_MS 窗口）——
   * src 与 src0 不同 = 刷新发生（返回 true 交确认循环）；class 含 selected 且不含 dynamic-selected
   * （tileselected 稳定选中/其他 selected）= 直接完成（返回 false）；超时无变化无选中态 = 点击未注册，
   * warn 不重试（重试会取消已选中格，真机 2026-09-09 观察），返回 false
   */
  const clickAndWatch = async (idx: number): Promise<boolean> => {
    const src0 = await readTileImgSrc(ch, idx)
    // 拟人坐标点击优先（Google 忽略瞬移式程序化点击）；framePoint 拿不到坐标回退 locator 直点
    if (!(await humanClickInFrame(deps, ch, TILE_SELECTOR, idx))) {
      await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
    }
    const polls = Math.ceil(REFRESH_WATCH_MS / REFRESH_POLL_MS)
    for (let i = 0; i < polls; i++) {
      if (i > 0) await deps.page.waitForTimeout(REFRESH_POLL_MS)
      const cls = await readTileClass(ch, idx)
      if (cls.includes('selected') && !cls.includes('dynamic-selected')) return false
      const src = await readTileImgSrc(ch, idx)
      if (src && src !== src0) return true
    }
    deps.logger.warn({ idx }, '九宫格该格点击未注册（class 无 selected 字样），不重试点击（select-more 兜底）')
    return false
  }
  /**
   * 刷新确认循环（官方 DEMO）：等新图稳定 1.5-2.5s → 截图该格 img（10s 超时 catch null）→
   * 标准 100x100 Base64 做 1x1 分类（solveGrid + qid + onLog 透传记账）——hasObject=true（新图仍是目标）
   * → 拟人点击该格确认（可能又触发刷新）→ 重新刷新监测，又刷新则下一轮确认（最多 CONFIRM_MAX 轮）；
   * hasObject=false 或截图/分类失败 → 完成（select-more 兜底）；再点与否由 hasObject 决定，绝不盲目再点
   */
  const confirmTileRefresh = async (idx: number): Promise<void> => {
    for (let round = 1; round <= CONFIRM_MAX; round++) {
      // 等刷新后的新图稳定（马上分类会撞上新图渲染中，真机刷新在点击后 1-6 秒发生）
      await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
      const shot = await ch.locator(TILE_SELECTOR).nth(idx).locator('img').first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
      let hasObject: boolean | null = null
      if (!shot) {
        deps.logger.warn({ idx }, '九宫格该格新图截图失败，放弃确认（select-more 兜底）')
      } else {
        try {
          const singleB64 = await toStandardBase64(shot, 100)
          const r = await deps.captcha.solveGrid(singleB64, qid, passOpts)
          hasObject = r.type === 'single' && r.hasObject
        } catch (e) {
          deps.logger.warn({ idx, err: (e as Error).message }, '九宫格该格新图分类失败，放弃确认（select-more 兜底）')
        }
      }
      const reclicked = hasObject === true
      deps.logger.info({ step: 'grid-tile-confirm', idx, hasObject, reclicked }, '九宫格格子刷新确认')
      if (!reclicked) return
      // 新图仍是目标：再点该格确认（可能又触发刷新）→ 重新刷新监测；不再刷新（tileselected/选中态）即完成
      if (!(await clickAndWatch(idx))) return
    }
    deps.logger.warn({ idx }, '九宫格该格多次确认后仍处动态刷新，继续（select-more 兜底）')
  }
  let result: GridResult | null = null
  let qid = ''
  let prompt = ''
  /** 本轮 verify 后检测到的错误提示类型（readErrorHint 结果；未点 verify 的放弃路径为 null） */
  let lastHint: GridErrorHint = null
  /** 本轮换图重试次数（分类空数组/抛错时点刷新换图计数） */
  let reloadCount = 0
  /** 每轮结束状态快照（数据收集）：识别目标/点选格/错误提示/换图次数 */
  const logRoundState = (): void => {
    deps.logger.info({
      step: 'grid-round-state',
      prompt,
      qid,
      objects: result !== null && result.type === 'multi' ? result.objects : [],
      hint: lastHint,
      reloads: reloadCount,
    }, '九宫格轮次状态')
  }
  // tiles 每次分类重试都重建（换图后 DOM 全换），声明不放初值（循环内首行即赋值）
  let tiles: ReturnType<Frame['locator']>
  // 分类可重试块：空数组/抛错（如 ERROR_GARBAGE_SAMPLE 图片质量差）→ 点刷新换图重试
  for (let reload = 0; ; reload++) {
    // 提示语等待重读：bframe 注入后网格 DOM 可能未渲染完（首读空串），最多等 PROMPT_WAIT_TIMEOUT_MS；
    // 换图后 Google 可能换提示语，因此每次重试都重读（不沿用上一轮提示语）
    prompt = ''
    const promptDeadline = Date.now() + PROMPT_WAIT_TIMEOUT_MS
    while (Date.now() < promptDeadline && !prompt) {
      prompt = ((await ch.locator(PROMPT_SELECTOR).first().textContent().catch(() => '')) ?? '').trim()
      if (!prompt) await deps.page.waitForTimeout(PROMPT_POLL_MS)
    }
    if (!prompt) throw new Error('九宫格提示文字未找到')
    qid = mapQuestionId(prompt) ?? ''
    if (!qid) throw new Error(`未覆盖的九宫格提示语: ${prompt}`)
    deps.logger.info({ prompt, qid }, '九宫格识别目标')
    tiles = ch.locator(TILE_SELECTOR)
    const tileCount = await tiles.count()
    gridSize = tileCount === 16 ? 450 : 300
    // 网格图一律走容器元素截图（fetch 每格原图拼接方案已废弃：拿到的内容与视觉图不符，真机窗口 89）
    // 截图前等待 1.5-2.5s 随机：等网格渐入动画稳定（真机空数组/ERROR_GARBAGE_SAMPLE 与动画未稳定截图相关）
    await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    const b64 = await captureGridB64()
    try {
      result = await deps.captcha.solveGrid(b64, qid, passOpts)
    } catch (e) {
      if (reload >= RELOAD_MAX) throw e
      deps.logger.warn({ err: (e as Error).message, reload: reload + 1 }, '九宫格分类失败，点刷新换图重试')
      await reloadImages(deps, ch)
      continue
    }
    if (result.type !== 'multi') throw new Error('九宫格分类未返回 multi 结果')
    if (result.objects.length === 0) {
      if (reload >= RELOAD_MAX) {
        reloadCount = reload
        deps.logger.warn('九宫格分类刷新换图后仍为空数组，本轮放弃（不点验证，等主循环下一轮）')
        logRoundState()
        return
      }
      deps.logger.warn({ reload: reload + 1 }, '九宫格分类返回空数组，点刷新换图重试')
      await reloadImages(deps, ch)
      continue
    }
    reloadCount = reload
    break
  }
  if (!result) throw new Error('九宫格分类无结果')
  deps.logger.info({ objects: result.objects, round: 'multi' }, '九宫格识别完成，开始点选')
  for (const idx of result.objects) {
    await clickTile(idx)
  }
  /** 补选一次：重截图网格 → confidence 0.3 放宽阈值分类（onLog 照常记账）→ 对未点过的格子走同款点选；异常返回 false 放弃补选 */
  const supplementOnce = async (): Promise<boolean> => {
    let supp: GridResult
    try {
      const b64 = await captureGridB64()
      supp = await deps.captcha.solveGrid(b64, qid, { onLog: passOpts.onLog, confidence: 0.3 })
    } catch (e) {
      deps.logger.warn({ err: (e as Error).message }, '九宫格补选截图/分类失败，放弃补选')
      return false
    }
    if (supp.type !== 'multi' || supp.objects.length === 0) {
      deps.logger.warn('九宫格补选分类未返回格子，放弃补选')
      return false
    }
    deps.logger.info({ objects: supp.objects }, '九宫格补选识别完成，点选未选格子')
    for (const idx of supp.objects) {
      if (clicked.has(idx)) continue
      clicked.add(idx)
      try {
        await clickTile(idx)
      } catch {
        deps.logger.warn({ idx }, '九宫格补选点选失败，放弃补选')
        return false
      }
    }
    return true
  }
  const clicked = new Set<number>(result.objects)
  // 3-5s 随机：等全部格子动画收尾后再点验证（真机观察：图片还在变化时点 verify，Google 判选择未完成刷题）
  await deps.page.waitForTimeout(3000 + Math.floor(Math.random() * 2000))
  // 验证循环：点 verify 前轮询等按钮可见（约 8s/500ms；一直不可见 = 选择未完成（点击未注册）→
  // 补点本轮 class 不含 selected 的格子后再等约 5s，仍不可见则放弃本轮）；
  // 点 verify 后轮询错误提示：select-more（选择不完整，未刷题可补选）→ 放宽阈值补选后重验（最多 SUPPLEMENT_MAX 次）；
  // incorrect（选错已刷题）→ 返回主循环下一轮；无提示照常返回
  for (let supplement = 0; ; ) {
    if (!(await waitVerifyVisible(deps, ch, VERIFY_VISIBLE_POLLS))) {
      // 按钮 8s 不可见：本轮 objects 中 class 不含 selected 的格子重新执行点选（拟人点击 + 稳定等待 + 确认流程）
      deps.logger.warn('九宫格验证按钮未出现，补点本轮未选中格')
      for (const idx of clicked) {
        const cls = (await tiles.nth(idx).getAttribute('class').catch(() => '')) ?? ''
        if (cls.includes('selected')) continue
        deps.logger.warn({ idx }, '九宫格补点未选中格')
        await clickTile(idx)
      }
      // 补点后再次等按钮（最多约 5s），仍不可见则放弃本轮（返回由主循环下一轮处理）
      if (!(await waitVerifyVisible(deps, ch, VERIFY_VISIBLE_RETRY_POLLS))) {
        deps.logger.warn('九宫格补点后验证按钮仍不可见，放弃本轮')
        logRoundState()
        return
      }
    }
    // 点 verify 前全体确认检查：已点格子 class 仍含 dynamic-selected 再等最多 5s（500ms 轮询），
    // 仍存在则 warn 照常 verify（select-more 兜底）
    {
      let stillDynamic = false
      for (let i = 0; i < PREVERIFY_DYNAMIC_POLLS; i++) {
        stillDynamic = false
        for (const idx of clicked) {
          const cls = await readTileClass(ch, idx)
          if (cls.includes('dynamic-selected')) { stillDynamic = true; break }
        }
        if (!stillDynamic) break
        await deps.page.waitForTimeout(500)
      }
      if (stillDynamic) deps.logger.warn('九宫格点验证前仍有格子处于动态刷新，照常验证（select-more 兜底）')
    }
    if (!(await humanClickInFrame(deps, ch, VERIFY_SELECTOR))) {
      await ch.locator(VERIFY_SELECTOR).first().click({ timeout: 5000 }).catch(() => {})
    }
    await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1000))
    lastHint = await pollErrorHint(deps, ch, ERROR_HINT_POLL_TIMEOUT_MS)
    if (lastHint === 'select-more' && supplement < SUPPLEMENT_MAX) {
      supplement++
      deps.logger.warn({ hint: 'select-more' }, '九宫格选择不完整，放宽阈值补选')
      if (!(await supplementOnce())) {
        logRoundState()
        return
      }
      await deps.page.waitForTimeout(3000 + Math.floor(Math.random() * 2000))
      continue
    }
    if (lastHint === 'incorrect') {
      deps.logger.warn({ hint: 'incorrect' }, '九宫格选择错误（Google 已刷题），返回主循环下一轮')
    }
    logRoundState()
    return
  }
}

/**
 * 九宫格模拟点击求解主入口：
 * 点复选框 → 等挑战 → 循环（读提示语 → 分类 → 点选 → 验证 → 查 aria-checked）→ 变绿返回 solved
 * @param opts.maxRounds 最大轮数（缺省 MAX_ROUNDS）
 * @param opts.siteKeyExclude 跳过的常驻 sitekey（如页面常驻 v3 锚点/bframe：避免误选 v3 复选框点击无效果）
 * @param opts.onLog 分类成本记账回调，透传给 solveGrid（缺省空实现）
 * @returns 'none' 无锚点 frame；'solved' 通过；'failed' 轮数耗尽（提示语未覆盖等异常直接抛错）
 */
export async function solveRecaptchaGrid(
  deps: { page: Page; captcha: CaptchaService; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer },
  opts: { maxRounds?: number; siteKeyExclude?: string; onLog?: (kind: string, ok: boolean, costPoints: number) => void } = {},
): Promise<'solved' | 'none' | 'failed'> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS
  // iframe 元素已插入 DOM 但 CDP frame 可能未附着（真机窗口 97 实测）——轮询等附着
  let anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  for (let i = 0; i < 30 && !anchor; i++) {
    await deps.page.waitForTimeout(500)
    anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  }
  if (!anchor) return 'none'
  // 点击失败只告警不中断：真机偶发点击未注册时，后续轮次能自我纠正
  // 锚点也是跨源 frame：拟人坐标点击优先（Google 忽略瞬移式程序化点击），失败回退 locator 直点
  if (!(await humanClickInFrame(deps, anchor, ANCHOR_SELECTOR))) {
    await anchor.locator(ANCHOR_SELECTOR).first().click({ timeout: 10000 }).catch((e) => {
      deps.logger.warn({ err: (e as Error).message }, '锚点复选框点击失败（继续流程，后续轮次自纠）')
    })
  }
  // 等挑战 frame 出现；期间锚点直接变绿即一键通过
  let challenge: Frame | null = null
  for (let i = 0; i < 30 && !challenge; i++) {
    await deps.page.waitForTimeout(500)
    challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
    if (!challenge) {
      const checked = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
      if (checked === 'true') { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
    }
  }
  for (let round = 0; round < maxRounds; round++) {
    let ch = challenge ?? findChallengeFrame(deps.page, opts.siteKeyExclude)
    if (!ch) {
      // 挑战 frame 为 null 且 aria-checked≠true：锚点首次点击可能未注册（真机窗口 92 实证）——
      // 每轮重点 1 次锚点自纠再查（拟人坐标点击优先，locator 直点兜底），仍无挑战则进下一轮
      const checked = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
      if (checked === 'true') { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
      deps.logger.warn({ round: round + 1 }, '挑战 frame 未出现且未变绿，重点一次锚点自纠')
      if (!(await humanClickInFrame(deps, anchor, ANCHOR_SELECTOR))) {
        await anchor.locator(ANCHOR_SELECTOR).first().click({ timeout: 10000 }).catch((e) => {
          deps.logger.warn({ err: (e as Error).message }, '锚点重点失败（继续轮询挑战 frame）')
        })
      }
      // 重点后轮询等挑战 frame 出现；期间锚点直接变绿即一键通过
      for (let i = 0; i < 30 && !ch; i++) {
        await deps.page.waitForTimeout(500)
        ch = findChallengeFrame(deps.page, opts.siteKeyExclude)
        if (!ch) {
          const checkedAfter = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
          if (checkedAfter === 'true') { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
        }
      }
      if (!ch) continue
    }
    await solveOneRound(deps, ch, opts)
    const checked = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
    if (checked === 'true') return 'solved'
    deps.logger.warn({ round: round + 1 }, '九宫格本轮未通过，继续下一轮')
    challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
    // 轮间随机 2500-4000ms：Google 对同会话连续验证有风控，需要比固定 2s 更自然的间隔
    await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1500))
  }
  return 'failed'
}
