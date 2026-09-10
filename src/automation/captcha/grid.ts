/**
 * reCAPTCHA 九宫格模拟点击求解（automation/captcha 层）：严格对齐 yescaptcha 官方 Python DEMO
 * （RecaptchaResolver 的 verify_entire_captcha / verify_single_captcha 流程），rev3.1 起无限递归到成功
 * 与 rev2 实现的关键差异（真机 0 通过三根因的修复）：
 *   1. 网格图取 div.rc-image-tile-wrapper > img 原生整图（naturalWidth 300/450 定尺寸），
 *      缺失回退容器元素截图（优先表格元素，按格子数定尺寸，截图前动画稳定等待与滚动复位）
 *   2. 格子点击用原生元素点击为主（点击前 iframe 内滚动到可视区），坐标拟人点击只做未注册兜底
 *   3. 失败不分轮次上限：无限递归到成功（用户确认 rev3.1）
 * rev3.2 按钮分流（真机按钮形态观察，2026-09-10）：
 *   - 3x3：验证按钮从开始就常驻；无跳过按钮，换图用刷新（同题换图）；官方支持 confidence 0.5
 *     （返回所有大于分值的格子，默认只返前三会漏选）；点验证前完整确认：重截重分类、
 *     平台还返回未选格就补点（最多 3 轮）
 *   - 4x4：没勾选时按钮是「跳过」（换题）、勾选后变「下一个」（翻页），翻到最后一页才出现验证按钮；
 *     分类不传 confidence（指定无意义）
 *   - 换图/换题统一 changeImages：3x3 刷新 / 4x4 跳过；select-more 先补点未注册格再验证，
 *     incorrect/try-again/无提示 换图重试；空数组/图片质量拒收/非 multi → 换图不硬点；
 *     未覆盖提示语 → 换图换题重试
 * rev3.3 全场景加固（真机窗口 18/19/20 任务超时复盘，2026-09-10）：
 *   - 回退截图重试 3 次（1s/2s 递增间隔，三次错误摘要用 | 拼接进异常信息）
 *   - 跳过/下一个按钮未命中、未覆盖提示语、截图终败 → bframe DOM 落盘 grid-debug（选择器学习/排障）
 *   - 未覆盖提示语连续 5 次、下一个按钮连续 5 次失败 → 抛错交任务重试换窗口（防空转到任务超时）
 *   - verify 点击瞬时失败等 1s 重试一次（不浪费一轮选择）；每窗口每次求解入口 dump 一次 bframe DOM
 * 工程护栏：余额不足抛 CaptchaFailure；任务超时由 window-runner 兜底；
 *   挑战收回且重点锚点 RECHECK_ANCHOR_MAX 次无法恢复 → 抛错交任务重试换窗口
 * 保留的真机验证资产：提示语中英映射、siteKeyExclude、grid-debug 诊断截图、
 *   grid-round-state/grid-click-diag 结构化日志、frame 失效防护（每轮重取 frame）
 * 依赖方向：依赖 integrations/captcha/provider 接口与 infrastructure/logger，被 engine/task-context 委托
 */
import type { Page, Frame } from 'patchright'
import Jimp from 'jimp'
import { writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CaptchaFailure, type CaptchaProvider, type CaptchaLogFn, type GridResult } from '../../integrations/captcha/provider'
import type { Logger } from '../../infrastructure/logger'
import type { Humanizer } from '../humanize'
import { mapQuestionId } from './question-map'

/** 锚点复选框元素（anchor frame 内） */
export const ANCHOR_SELECTOR = '#recaptcha-anchor'
/** 提示文字（目标物体名，bframe 内） */
export const PROMPT_SELECTOR = '.rc-imageselect-desc-wrapper strong'
/** 网格格子（td 顺序即序号：3x3 为 0-8，4x4 为 0-15） */
export const TILE_SELECTOR = '#rc-imageselect-target table td'
/** 验证按钮（bframe 内） */
export const VERIFY_SELECTOR = '#recaptcha-verify-button'
/** 整图 img（官方 DEMO：每格 wrapper 内是同一张整图，naturalWidth 300/450 判 3x3/4x4） */
export const GRID_IMG_SELECTOR = 'div.rc-image-tile-wrapper > img'
/** 官方换图按钮（同题换一批新图） */
export const RELOAD_SELECTOR = '#recaptcha-reload-button'
/** 跳过按钮（4x4 换题；Google 结构变化兜底：属性包含匹配 + 文本匹配中英多路） */
export const SKIP_SELECTORS = ['[aria-label*="跳过"]', '[title*="跳过"]', '[aria-label*="Skip"]', '[title*="Skip"]', 'button:has-text("跳过")']
/** 4x4「下一个」翻页按钮（勾选后出现；属性包含匹配 + 文本匹配中英多路） */
export const NEXT_SELECTORS = ['[aria-label*="下一个"]', '[title*="下一个"]', '[aria-label*="Next"]', '[title*="Next"]', 'button:has-text("下一个")']
/** 挑战收回后重点锚点恢复上限（超出视为无法恢复，抛错交任务重试换窗口） */
export const RECHECK_ANCHOR_MAX = 3
/** 单格确认循环上限（官方递归上界） */
const CONFIRM_MAX = 3
/** 点格后查 class 的等待（官方 time.sleep(3)） */
const CONFIRM_WAIT_MS = 3000
/** 主网格分类点数（官方价格表：300x300/450x450 6 POINTS） */
const GRID_COST_POINTS = 6
/** 单格 1x1 分类点数（官方价格表：100x100 2 点数） */
const TILE_COST_POINTS = 2
/** 提示语轮询预算与间隔（真机教训：bframe DOM 可能晚于 frame 附着渲染，单次读取会误判未找到） */
const PROMPT_POLL_TIMEOUT_MS = 10000
const PROMPT_POLL_MS = 500
/** grid-debug 诊断目录文件数上限 */
const GRID_DEBUG_MAX_FILES = 40

/** 从 frame URL 提取 reCAPTCHA sitekey（k 参数；无则 null） */
function extractSiteKey(url: string): string | null {
  const m = url.match(/[?&]k=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

/** 找锚点 frame（兼容 enterprise/api2 两种 URL；excludeSiteKey 跳过常驻 sitekey 如页面常驻 v3） */
export function findAnchorFrame(page: Page, excludeSiteKey?: string): Frame | null {
  return page.frames().find((f) => {
    const u = f.url()
    if (!u.includes('recaptcha/enterprise/anchor') && !u.includes('recaptcha/api2/anchor')) return false
    return !excludeSiteKey || extractSiteKey(u) !== excludeSiteKey
  }) ?? null
}

/** 找挑战（九宫格）frame；excludeSiteKey 语义同 findAnchorFrame */
export function findChallengeFrame(page: Page, excludeSiteKey?: string): Frame | null {
  return page.frames().find((f) => {
    const u = f.url()
    if (!u.includes('recaptcha/enterprise/bframe') && !u.includes('recaptcha/api2/bframe')) return false
    return !excludeSiteKey || extractSiteKey(u) !== excludeSiteKey
  }) ?? null
}

/** PNG buffer 等比缩放（官方 resize 语义：保持纵横比，定宽缩到 size） */
async function toStandardImage(buf: Buffer, size: number): Promise<Jimp> {
  const img = await Jimp.read(buf)
  if ((img.getWidth() !== size || img.getHeight() !== size) && img.getWidth() > 0) {
    await img.resize(size, size)
  }
  return img
}

/** 网格表格元素（截图优先对象：精确 n×n 正方形，含全部白色分割线；容器略高于表格，截容器会切掉底部边线） */
const GRID_TABLE_SELECTOR = '#rc-imageselect-target table'

/** 容器元素截图回退（整图 img 缺失时）：中心裁剪正方形 + 等比缩放；Google 改版兜底，warn 可见不静默 */
async function fallbackCaptureGrid(deps: GridDeps, ch: Frame, size: number): Promise<string> {
  // 截图前动画稳定等待
  await deps.page.waitForTimeout(1000)
  // 截图前滚动复位：点格子时的 scrollIntoView 会把网格滚出可视区（越界部分截图成空白，真机准确率下降），先滚回顶部
  await ch.locator('#rc-imageselect-target').first().evaluate((el) => (el as HTMLElement).scrollIntoView({ block: 'start' })).catch(() => {})
  await deps.page.waitForTimeout(500)
  // 优先截表格元素（真机 3x3：截容器中心裁剪会切掉底部白色分割线）；表格不存在回退容器
  const targetSel = (await ch.locator(GRID_TABLE_SELECTOR).first().count().catch(() => 0)) > 0 ? GRID_TABLE_SELECTOR : '#rc-imageselect-target'
  let firstErr = ''
  let shot = await ch.locator(targetSel).first().screenshot({ type: 'png', timeout: 10000 }).catch((e) => { firstErr = (e as Error).message; return null })
  if (!shot) {
    // 真机 2026-09-10 教训：元素动画中截图易失败，重试即恢复（rev2 窗口 11/19 一次失败即抛错）
    deps.logger.warn({ err: firstErr }, '九宫格网格截图失败（元素可能动画中），1 秒后重试一次')
    await deps.page.waitForTimeout(1000)
    shot = await ch.locator(targetSel).first().screenshot({ type: 'png', timeout: 10000 }).catch((e) => { firstErr = `${firstErr} | 第2次: ${(e as Error).message}`; return null })
  }
  if (!shot) {
    deps.logger.warn({ err: firstErr }, '九宫格网格截图第二次失败（元素可能动画中），2 秒后再试一次')
    await deps.page.waitForTimeout(2000)
    shot = await ch.locator(targetSel).first().screenshot({ type: 'png', timeout: 10000 }).catch((e) => { firstErr = `${firstErr} | 第3次: ${(e as Error).message}`; return null })
  }
  if (!shot) {
    // 三次均失败：dump bframe DOM 供真机排查（Google 结构变化/元素状态异常）后抛错（主循环接住换图）
    dumpBframeDom(ch, 'shot-fail')
    throw new Error(`九宫格网格截图失败（整图 img 缺失且容器截图失败）: ${firstErr.slice(0, 300)}`)
  }
  saveDebugImage('grid-raw-fallback', shot)
  const img = await Jimp.read(shot)
  const w = img.getWidth()
  const h = img.getHeight()
  const side = Math.min(w, h)
  if (w !== side || h !== side) img.crop(Math.floor((w - side) / 2), Math.floor((h - side) / 2), side, side)
  if (side !== size) await img.resize(size, size)
  const std = await img.getBufferAsync(Jimp.MIME_PNG)
  saveDebugImage('grid-std-fallback', std)
  return std.toString('base64')
}

/** grid-debug 诊断目录防膨胀：文件数超过上限则清空目录（清理失败静默） */
function pruneDebugDir(debugDir: string, maxFiles: number): void {
  try {
    if (!existsSync(debugDir)) return
    if (readdirSync(debugDir).length <= maxFiles) return
    for (const f of readdirSync(debugDir)) unlinkSync(join(debugDir, f))
  } catch { /* 清理失败静默 */ }
}

/** 诊断截图落盘（raw + std 双图，失败静默） */
function saveDebugImage(name: string, buf: Buffer): void {
  try {
    const debugDir = join(process.cwd(), 'data', 'screenshots', 'grid-debug')
    mkdirSync(debugDir, { recursive: true })
    pruneDebugDir(debugDir, GRID_DEBUG_MAX_FILES)
    writeFileSync(join(debugDir, `${name}-${Date.now()}.png`), buf)
  } catch { /* 诊断写盘失败静默 */ }
}

/** bframe DOM 落盘诊断（按钮选择器学习/排障用）：失败静默，目录受 pruneDebugDir 上限约束 */
function dumpBframeDom(ch: Frame, tag: string): void {
  void (async () => {
    try {
      const html = (await ch.locator('body').first().evaluate((el) => (el as HTMLElement).outerHTML).catch(() => '')) ?? ''
      if (!html) return
      const dir = join(process.cwd(), 'data', 'screenshots', 'grid-debug')
      mkdirSync(dir, { recursive: true })
      pruneDebugDir(dir, GRID_DEBUG_MAX_FILES)
      writeFileSync(join(dir, `bframe-${tag}-${Date.now()}.html`), html)
    } catch { /* 诊断 dump 失败静默 */ }
  })()
}

/**
 * 官方整图获取：读 div.rc-image-tile-wrapper > img 的 src + naturalWidth
 * src 为 data: 直接解码；blob: 在 frame 内 fetch；http(s) 用 Node fetch
 * 缩放目标 = naturalWidth（450=4x4，否则 300）；img 缺失回退容器截图（warn）
 */
async function readGridImage(deps: GridDeps, ch: Frame): Promise<{ b64: string } | null> {
  // 等网格渐入动画稳定后再取图（真机 2026-09-10：动画未稳定截图被平台拒 ERROR_GARBAGE_SAMPLE）
  await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
  /** 回退截图目标尺寸：4x4（16 格）官方 450，否则 300（真机：固定 300 导致 4x4 分类置信度弱） */
  const fallbackSize = async (): Promise<number> => {
    const tileCount = await ch.locator(TILE_SELECTOR).count().catch(() => 0)
    return tileCount === 16 ? 450 : 300
  }
  const info = await ch.locator(GRID_IMG_SELECTOR).first().evaluate((el) => {
    const img = el as HTMLImageElement
    return { src: img.src, naturalWidth: img.naturalWidth }
  }).catch(() => null)
  if (!info || !info.src) {
    deps.logger.warn('九宫格整图 img 未找到，回退容器元素截图（Google 结构可能已变化）')
    return { b64: await fallbackCaptureGrid(deps, ch, await fallbackSize()) }
  }
  let buf: Buffer
  try {
    if (info.src.startsWith('data:')) {
      buf = Buffer.from(info.src.split(',')[1] ?? '', 'base64')
    } else if (info.src.startsWith('blob:')) {
      const bytes = await ch.locator(GRID_IMG_SELECTOR).first().evaluate(async (el) => {
        const r = await fetch((el as HTMLImageElement).src)
        const ab = await r.arrayBuffer()
        return Array.from(new Uint8Array(ab))
      }).catch(() => null)
      if (!bytes) return { b64: await fallbackCaptureGrid(deps, ch, await fallbackSize()) }
      buf = Buffer.from(bytes as number[])
    } else {
      const res = await fetch(info.src)
      if (!res.ok) return { b64: await fallbackCaptureGrid(deps, ch, await fallbackSize()) }
      buf = Buffer.from(await res.arrayBuffer())
    }
  } catch {
    return { b64: await fallbackCaptureGrid(deps, ch, await fallbackSize()) }
  }
  const size = info.naturalWidth >= 400 ? 450 : 300
  saveDebugImage('grid-raw', buf)
  const std = await (await toStandardImage(buf, size)).getBufferAsync(Jimp.MIME_PNG)
  saveDebugImage('grid-std', std)
  return { b64: std.toString('base64') }
}

/** 读该格 img 的 src（1s 短超时防死等默认 30s） */
async function readTileImgSrc(ch: Frame, idx: number): Promise<string> {
  return (await ch.locator(TILE_SELECTOR).nth(idx).locator('img').first().getAttribute('src', { timeout: 1000 }).catch(() => null)) ?? ''
}

/** 读格子 td class（1s 短超时） */
async function readTileClass(ch: Frame, idx: number): Promise<string> {
  return (await ch.locator(TILE_SELECTOR).nth(idx).getAttribute('class', { timeout: 1000 }).catch(() => null)) ?? ''
}

/** frame 内元素中心在页面坐标系的位置（frame 内坐标 + frame 元素页面偏移）；拿不到返回 null */
async function framePoint(page: Page, ch: Frame, selector: string, nth = 0): Promise<{ x: number; y: number } | null> {
  const inner = await ch.locator(selector).nth(nth).evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }).catch(() => null)
  if (!inner) return null
  const frameHandle = await ch.frameElement().catch(() => null)
  if (!frameHandle) return null
  const outer = await frameHandle.evaluate((el) => {
    const r = (el as HTMLElement).getBoundingClientRect()
    return { x: r.x, y: r.y }
  }).catch(() => null)
  if (!outer) return null
  return { x: outer.x + inner.x, y: outer.y + inner.y }
}

/** 拟人坐标点击 frame 内元素（原生点击未注册时的兜底；失败返回 false） */
async function humanClickInFrame(page: Page, human: Humanizer, ch: Frame, selector: string, nth = 0): Promise<boolean> {
  const p = await framePoint(page, ch, selector, nth)
  if (!p) return false
  try {
    await human.clickAt(p.x, p.y)
    return true
  } catch {
    return false
  }
}

/** 原生点击（官方 selenium click 等价：trusted、自动滚动居中）；返回 null=成功，否则错误信息 */
async function nativeClick(ch: Frame, selector: string, nth = 0): Promise<string | null> {
  try {
    await ch.locator(selector).nth(nth).click({ timeout: 5000 })
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** 错误提示类型：'select-more' 选择不完整；'incorrect' 选错已刷题；'try-again' Google 要求重试（风控重置） */
export type GridErrorHint = 'select-more' | 'incorrect' | 'try-again' | null

/** 错误提示读取（诊断用）：选择器探针 + 请重试文案全帧匹配（verify 失败后调用，开销可接受） */
async function readErrorHint(ch: Frame): Promise<GridErrorHint> {
  const probes: Array<[string, 'select-more' | 'incorrect']> = [
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
  const body = ((await ch.locator('body').first().textContent().catch(() => '')) ?? '')
  if (/请重试|请稍后重试|Please try again|try again later/i.test(body)) return 'try-again'
  return null
}

export interface GridDeps {
  page: Page
  provider: CaptchaProvider
  logger: Pick<Logger, 'info' | 'warn'>
  human: Humanizer
}

export interface GridOpts {
  siteKeyExclude?: string
  maxCostPerTask?: number
  onLog?: CaptchaLogFn
}

/** 单轮求解上下文（每轮重取 frame，防 Google 换图后 frame 失效） */
interface RoundCtx {
  ch: Frame
  qid: string
  prompt: string
  /** 分类封装：costPoints 按官方价格分档（主网格 6 点 / 1x1 单格 2 点），记账与余额校验内聚在此 */
  classify: (image: string, questionId: string, costPoints: number, confidence?: number) => Promise<GridResult>
}

/** 主网格 multi 分类结果（classifyRound 已过滤非 multi/空数组） */
type MultiGridResult = Extract<GridResult, { type: 'multi' }>

/** 打码前余额校验（不烧点数原则：余额低于上限直接 CaptchaFailure） */
async function ensureBalance(deps: GridDeps, maxCostPerTask?: number): Promise<void> {
  if (maxCostPerTask === undefined) return
  const balance = await deps.provider.getBalance()
  if (balance < maxCostPerTask) throw new CaptchaFailure(`打码余额不足: ${balance} 点 < ${maxCostPerTask} 点`)
}

/**
 * 单格点选流程（官方 verify_single_captcha）：原生点击 → 等 3s → 查 class：
 * - class 含 selected → 完成
 * - class 无 selected 且 src 未变 → 点击未注册 → 坐标拟人点击兜底重试一次，再查
 * - src 变化（图片刷新新图）→ 等新图稳定 → 截图该格 → 100x100 → 1x1 分类：
 *   hasObject=true 再点该格（可能又刷新，循环最多 CONFIRM_MAX 轮）；false 完成
 */
async function clickTile(deps: GridDeps, rc: RoundCtx, idx: number): Promise<void> {
  const src0 = await readTileImgSrc(rc.ch, idx)
  const diag = { idx, beforeClass: await readTileClass(rc.ch, idx), hit: false }
  // 先滚动到可视区（跨源 iframe Playwright 无法自动滚动；真机窗口 16：底部两行格子可视区外导致点击抛错/未注册）
  await rc.ch.locator(TILE_SELECTOR).nth(idx).evaluate((el) => (el as HTMLElement).scrollIntoView({ block: 'center' })).catch(() => {})
  const err = await nativeClick(rc.ch, TILE_SELECTOR, idx)
  if (err) {
    deps.logger.warn({ idx, err }, '九宫格格子原生点击失败，尝试坐标拟人兜底')
    await humanClickInFrame(deps.page, deps.human, rc.ch, TILE_SELECTOR, idx)
  }
  let rounds = 0
  while (rounds < CONFIRM_MAX) {
    rounds++
    await deps.page.waitForTimeout(CONFIRM_WAIT_MS)
    const cls = await readTileClass(rc.ch, idx)
    if (cls.includes('selected')) { diag.hit = true; break }
    const src = await readTileImgSrc(rc.ch, idx)
    if (src && src === src0) {
      if (rounds === 1) {
        deps.logger.warn({ idx }, '九宫格该格点击未注册，坐标拟人点击兜底重试一次')
        await humanClickInFrame(deps.page, deps.human, rc.ch, TILE_SELECTOR, idx)
        continue
      }
      deps.logger.warn({ idx }, '九宫格该格点击仍未注册（放弃该格，交由下一轮兜底）')
      break
    }
    // 图片已刷新：等新图稳定（1.5-2.5s 随机）后截图该格做 1x1 分类（官方：100x100，2 点）
    await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    const shot = await rc.ch.locator(TILE_SELECTOR).nth(idx).locator('img').first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
    if (!shot) { deps.logger.warn({ idx }, '九宫格该格新图截图失败，放弃确认'); break }
    let hasObject = false
    try {
      const singleB64 = (await (await toStandardImage(shot, 100)).getBufferAsync(Jimp.MIME_PNG)).toString('base64')
      const r = await rc.classify(singleB64, rc.qid, TILE_COST_POINTS)
      hasObject = r.type === 'single' && r.hasObject
    } catch (e) {
      deps.logger.warn({ idx, err: (e as Error).message }, '九宫格该格新图分类失败，放弃确认')
      break
    }
    deps.logger.info({ step: 'grid-tile-confirm', idx, hasObject }, '九宫格格子刷新确认')
    if (!hasObject) break
    const reErr = await nativeClick(rc.ch, TILE_SELECTOR, idx)
    if (reErr) deps.logger.warn({ idx, err: reErr }, '九宫格该格确认再点失败')
  }
  deps.logger.info({ step: 'grid-click-diag', ...diag, afterClass: await readTileClass(rc.ch, idx) }, '九宫格点击诊断')
}

/** 点官方换图按钮（同题换一批图）；返回图是否已变化 */
async function reloadImages(deps: GridDeps, ch: Frame): Promise<boolean> {
  const before = await readTileImgSrc(ch, 0)
  const err = await nativeClick(ch, RELOAD_SELECTOR)
  if (err) deps.logger.warn({ err }, '九宫格换图按钮点击失败')
  await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
  const after = await readTileImgSrc(ch, 0)
  return after !== '' && after !== before
}

/** 点跳过按钮（换一批新题）；任一选择器命中即成功 */
async function skipImages(deps: GridDeps, ch: Frame): Promise<boolean> {
  for (const sel of SKIP_SELECTORS) {
    const err = await nativeClick(ch, sel)
    if (!err) {
      await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
      return true
    }
  }
  dumpBframeDom(ch, 'skip-miss')
  deps.logger.warn('九宫格跳过按钮点击失败（选择器未命中，Google 结构可能变化）')
  return false
}

/** 点 4x4「下一个」按钮翻页（勾选后出现）；任一选择器命中即成功 */
async function clickNext(deps: GridDeps, ch: Frame): Promise<boolean> {
  for (const sel of NEXT_SELECTORS) {
    const err = await nativeClick(ch, sel)
    if (!err) {
      await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
      return true
    }
  }
  dumpBframeDom(ch, 'next-miss')
  deps.logger.warn('九宫格下一个按钮点击失败（选择器未命中，Google 结构可能变化）')
  return false
}

/** 换图/换题：3x3 点「刷新」（同题换图）；4x4 点「跳过」（换题；没勾选时按钮正好是跳过） */
async function changeImages(deps: GridDeps, ch: Frame, is3x3: boolean): Promise<void> {
  if (is3x3) await reloadImages(deps, ch)
  else await skipImages(deps, ch)
}

/** select-more 补点：本轮目标格中 class 不含 selected 的重新点选（点击过快未注册自愈）；返回是否补了点 */
async function supplementUnselected(deps: GridDeps, rc: RoundCtx, targetIdx: number[]): Promise<boolean> {
  let any = false
  for (const idx of targetIdx) {
    const cls = await readTileClass(rc.ch, idx)
    if (cls.includes('selected')) continue
    any = true
    deps.logger.warn({ idx }, '九宫格补点未选中格')
    await clickTile(deps, rc, idx)
  }
  return any
}

/**
 * 九宫格模拟点击求解主入口（rev3.2：无限递归到成功 + 3x3/4x4 按钮分流）：
 * 找锚点 → 点复选框 → 等挑战 frame → 无限循环（每轮重取 frame）：
 *   格子数先读定 3x3/4x4 分流 → 提示语（轮询）→ 未覆盖换图/换题；
 *   取图分类（3x3 confidence 0.5）→ 空数组/非 multi/图片质量拒收 换图；
 *   点选 → 3x3 验证前确认循环（重截重分类补点）→ 4x4 验证按钮不在先点「下一个」翻页 → verify；
 *   aria-checked=true 返回 solved；否则按错误提示分流：
 *   select-more 先补点未注册格再 verify，仍未过换图；incorrect/try-again/无提示 换图（3x3 刷新 / 4x4 跳过）
 * 工程护栏：挑战收回且重点锚点 RECHECK_ANCHOR_MAX 次无果 → 抛错（任务重试换窗口）；
 *   余额不足抛 CaptchaFailure（终态不重试）
 * @param opts.siteKeyExclude 跳过的常驻 sitekey（页面常驻 v3 锚点，避免误点无效果的复选框）
 * @param opts.maxCostPerTask 余额下限（undefined 不校验）
 * @param opts.onLog 分类成本记账（platform 取自 provider.platform）
 * @returns 'none' 无锚点 frame；'solved' 通过；'failed' 仅「挑战无法恢复」路径
 */
export async function solveRecaptchaGrid(deps: GridDeps, opts: GridOpts = {}): Promise<'solved' | 'none' | 'failed'> {
  const onLog = opts.onLog ?? (() => {})
  /** 分类封装：余额校验 + 官方价格分档记账（主网格 6 点 / 1x1 单格 2 点）；confidence 由调用方定（3x3 传 0.5） */
  const classify = async (image: string, questionId: string, costPoints: number, confidence?: number) => {
    await ensureBalance(deps, opts.maxCostPerTask)
    try {
      const r = await deps.provider.classifyGrid(image, questionId, confidence)
      onLog(deps.provider.platform, 'recaptcha_v2_grid', true, costPoints)
      return r
    } catch (e) {
      onLog(deps.provider.platform, 'recaptcha_v2_grid', false, costPoints)
      throw e
    }
  }
  // iframe 元素已插入 DOM 但 CDP frame 可能未附着：轮询等附着
  let anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  for (let i = 0; i < 30 && !anchor; i++) {
    await deps.page.waitForTimeout(500)
    anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  }
  if (!anchor) return 'none'
  const anchorChecked = async (): Promise<boolean> =>
    (await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)) === 'true'
  // 点复选框触发挑战；点击失败不中断（后续轮次自纠）
  if (await nativeClick(anchor, ANCHOR_SELECTOR)) {
    deps.logger.warn('锚点复选框点击失败（继续流程，后续轮次自纠）')
  }
  // 等挑战 frame 出现；期间锚点直接变绿 = 一键通过（v3 直过等价）
  let challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
  for (let i = 0; i < 30 && !challenge; i++) {
    await deps.page.waitForTimeout(500)
    challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
    if (!challenge && await anchorChecked()) { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
  }
  // 首轮 entry dump：每窗口每次求解入口落盘一次 bframe DOM（按钮选择器学习/排障用）
  if (challenge) dumpBframeDom(challenge, 'entry')
  let recheckCount = 0
  // 防空转计数：连续未覆盖提示语/下一个按钮连续失败达上限 → 抛错交任务重试换窗口（不再干等到任务超时）
  let unknownPromptCount = 0
  let nextFailCount = 0
  // 无限递归到成功：唯一正常出口 aria-checked=true
  while (true) {
    if (await anchorChecked()) { deps.logger.info('九宫格通过（aria-checked=true）'); return 'solved' }
    // 每轮重取 frame：Google 换图后旧 Frame 引用可能失效；找不到回退上一轮引用
    const ch = findChallengeFrame(deps.page, opts.siteKeyExclude) ?? challenge
    if (!ch) {
      // 挑战收回且未变绿（「请重试」无文案形态）：重点锚点恢复挑战
      if (recheckCount >= RECHECK_ANCHOR_MAX) throw new Error('九宫格挑战无法恢复（重点锚点多次无果，交任务重试换新窗口）')
      recheckCount++
      deps.logger.warn({ recheckCount }, '挑战 frame 消失且未变绿，重点锚点恢复挑战')
      await nativeClick(anchor, ANCHOR_SELECTOR)
      await deps.page.waitForTimeout(2000 + Math.floor(Math.random() * 1500))
      continue
    }
    challenge = ch
    recheckCount = 0
    const rc: RoundCtx = { ch, qid: '', prompt: '', classify }
    // 格子数先读一次：决定 3x3/4x4 分流（网格可能未渲染完，读 0 时重试一次）
    let tileCount = await ch.locator(TILE_SELECTOR).count().catch(() => 0)
    if (tileCount === 0) {
      await deps.page.waitForTimeout(1000)
      tileCount = await ch.locator(TILE_SELECTOR).count().catch(() => 0)
    }
    const is3x3 = tileCount === 9
    // 提示语轮询（bframe DOM 可能晚于 frame 附着渲染）
    const promptDeadline = Date.now() + PROMPT_POLL_TIMEOUT_MS
    let prompt = ''
    while (Date.now() < promptDeadline) {
      prompt = ((await rc.ch.locator(PROMPT_SELECTOR).first().textContent().catch(() => '')) ?? '').trim()
      if (prompt) break
      await deps.page.waitForTimeout(PROMPT_POLL_MS)
    }
    if (!prompt) {
      deps.logger.warn('九宫格提示文字未读到，换图后重试')
      await changeImages(deps, rc.ch, is3x3)
      continue
    }
    const qid = mapQuestionId(prompt)
    if (!qid) {
      // 题不认识（本地映射表未覆盖）：拿不到平台要求的题目编号，换图/换题重来
      unknownPromptCount++
      dumpBframeDom(rc.ch, 'unknown-prompt')
      if (unknownPromptCount >= 5) throw new Error('九宫格提示语连续未覆盖（多次换图仍是未知题），交任务重试换新窗口')
      deps.logger.warn({ prompt }, '未覆盖的九宫格提示语，换图换题后重试')
      await changeImages(deps, rc.ch, is3x3)
      continue
    }
    deps.logger.info({ prompt, qid, is3x3 }, '九宫格识别目标')
    rc.prompt = prompt
    rc.qid = qid
    unknownPromptCount = 0
    tileCount = await ch.locator(TILE_SELECTOR).count().catch(() => 0)
    // 3x3 官方支持 confidence 0.5：返回所有大于分值的格子（默认只返前三，会漏选）；4x4 指定无意义不传
    const classifyConfidence = tileCount === 9 ? 0.5 : undefined
    // 取图 + 分类（readGridImage 内部兜底截图可能抛错——真机 44：截图两次失败不得穿透主循环，换图重试）
    let grid: { b64: string } | null = null
    try {
      grid = await readGridImage(deps, rc.ch)
    } catch (e) {
      deps.logger.warn({ err: (e as Error).message }, '九宫格网格图获取失败，换图后重试')
      await changeImages(deps, rc.ch, tileCount === 9)
      continue
    }
    if (!grid) {
      deps.logger.warn('九宫格网格图获取失败，换图后重试')
      await changeImages(deps, rc.ch, tileCount === 9)
      continue
    }
    const classifyRound = async (): Promise<MultiGridResult | null> => {
      let result: GridResult
      try {
        result = await rc.classify(grid!.b64, qid, GRID_COST_POINTS, classifyConfidence)
      } catch (e) {
        if (e instanceof CaptchaFailure && /ERROR_GARBAGE_SAMPLE|ERROR_ILLEGAL_IMAGE|ERROR_PARSE_IMAGE_FAIL/.test(e.message)) {
          deps.logger.warn({ err: e.message }, '九宫格分类图片质量被平台拒收，换图后重试')
          await changeImages(deps, rc.ch, tileCount === 9)
          return null
        }
        throw e
      }
      if (result.type !== 'multi') {
        deps.logger.warn('九宫格分类未返回 multi 结果，换图后重试')
        await changeImages(deps, rc.ch, tileCount === 9)
        return null
      }
      if (result.objects.length === 0) {
        deps.logger.warn('九宫格分类返回空数组，换图后重试')
        await changeImages(deps, rc.ch, tileCount === 9)
        return null
      }
      return result
    }
    const result = await classifyRound()
    if (!result) continue
    deps.logger.info({ objects: result.objects }, '九宫格识别完成，开始点选')
    const clicked = new Set<number>()
    for (const idx of result.objects) { await clickTile(deps, rc, idx); clicked.add(idx) }
    // —— 3x3：验证按钮常驻，点验证前完整确认：重截重分类，平台还返回未选格就补点，最多 3 轮 ——
    if (tileCount === 9) {
      for (let confirm = 0; confirm < 3; confirm++) {
        let confirmGrid: { b64: string } | null = null
        try {
          confirmGrid = await readGridImage(deps, rc.ch)
        } catch {
          break
        }
        if (!confirmGrid) break
        let confirmResult: GridResult
        try {
          confirmResult = await rc.classify(confirmGrid.b64, qid, GRID_COST_POINTS, classifyConfidence)
        } catch {
          break
        }
        if (confirmResult.type !== 'multi' || confirmResult.objects.length === 0) break
        const fresh = confirmResult.objects.filter((i) => !clicked.has(i))
        if (fresh.length === 0) break
        deps.logger.info({ fresh }, '九宫格验证前确认：补点新识别格')
        for (const idx of fresh) { await clickTile(deps, rc, idx); clicked.add(idx) }
      }
    }
    // 等全部格子动画收尾再点验证（图片还在变化时点 verify 会被 Google 判选择未完成）
    await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1000))
    // —— 4x4 按钮分流：验证按钮在 → 验证；下一个在 → 翻页继续；都不在 → 重读一轮 ——
    if (tileCount !== 9) {
      const verifyVisible = async (): Promise<boolean> => {
        const btn = rc.ch.locator(VERIFY_SELECTOR).first()
        return (await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))
      }
      if (!(await verifyVisible())) {
        deps.logger.info('4x4 验证按钮未出现，点下一个翻页继续')
        if (await clickNext(deps, rc.ch)) nextFailCount = 0
        else {
          nextFailCount++
          if (nextFailCount >= 5) throw new Error('九宫格下一个按钮连续点击失败，交任务重试换新窗口')
        }
        continue
      }
    }
    // verify 点击瞬时失败先等 1s 重试一次（真机：瞬时失败即换图浪费一轮选择；两连败才换图）
    let verifyErr = await nativeClick(rc.ch, VERIFY_SELECTOR)
    if (verifyErr) {
      await deps.page.waitForTimeout(1000)
      verifyErr = await nativeClick(rc.ch, VERIFY_SELECTOR)
    }
    if (verifyErr) {
      deps.logger.warn({ err: verifyErr }, '九宫格验证按钮点击失败，换图后重试')
      await changeImages(deps, rc.ch, tileCount === 9)
      continue
    }
    await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    if (await anchorChecked()) { deps.logger.info('九宫格验证通过'); return 'solved' }
    // —— 验证失败后的错误处理 ——
    const hint = await readErrorHint(rc.ch)
    deps.logger.info({ step: 'grid-round-state', prompt, qid, objects: result.objects, hint }, '九宫格轮次状态')
    if (hint === 'select-more') {
      // 先判点击过快：本轮目标格中仍有未选中的 → 补点 → 再验证（不换图不浪费）
      const supplemented = await supplementUnselected(deps, rc, result.objects)
      if (supplemented) {
        await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1000))
        await nativeClick(rc.ch, VERIFY_SELECTOR)
        await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
        if (await anchorChecked()) { deps.logger.info('九宫格补点后验证通过'); return 'solved' }
        const hint2 = await readErrorHint(rc.ch)
        deps.logger.warn({ hint: hint2 ?? 'none' }, '九宫格补点后仍未通过，换图重试')
      } else {
        deps.logger.warn('九宫格已点格子全部选中仍提示未选全（平台分类没找全），换图重试')
      }
      await changeImages(deps, rc.ch, tileCount === 9)
      continue
    }
    if (hint === 'try-again') deps.logger.warn('Google 提示请重试（同会话已风控重置），换图重试')
    else if (hint === 'incorrect') deps.logger.warn('九宫格选择错误（Google 已刷题），换图重试')
    else deps.logger.warn('九宫格验证后无提示且未通过，换图重试')
    await changeImages(deps, rc.ch, tileCount === 9)
  }
}
