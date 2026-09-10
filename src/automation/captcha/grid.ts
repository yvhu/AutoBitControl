/**
 * reCAPTCHA 九宫格模拟点击求解（automation/captcha 层）：严格对齐 yescaptcha 官方 Python DEMO
 * （RecaptchaResolver 的 verify_entire_captcha / verify_single_captcha 流程）
 * 与 rev2 实现的三处关键差异（对应真机 0 通过的三个根因）：
 *   1. 网格图取 div.rc-image-tile-wrapper > img 的原生整图（naturalWidth 300/450 定尺寸），
 *      不再容器元素截图（CSS 缩放裁剪污染导致分类乱跳/空数组，窗口 93/100）
 *   2. 格子点击用原生元素点击（selenium click 等价，trusted 且自动居中），
 *      不再页面坐标拟人点击为主（坐标漂移导致点击从未注册，窗口 92）；未注册才坐标兜底重试一次
 *   3. 同窗口验证轮数上限 maxRounds（默认 3）：连续多轮不过 = 同会话已风控（用户真机经验：
 *      死磕即使选对也过不去），返回 failed 交由任务重试换新窗口
 * 保留的真机验证资产：提示语中英映射（question-map）、siteKeyExclude、grid-debug 诊断截图、
 * grid-round-state/grid-click-diag 结构化日志、frame 失效防护（每轮重取 frame）
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
/** 同窗口验证轮数上限（默认 3） */
export const MAX_ROUNDS_DEFAULT = 3
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

/** 容器元素截图回退（整图 img 缺失时）：中心裁剪正方形 + 等比缩放；Google 改版兜底，warn 可见不静默 */
async function fallbackCaptureGrid(deps: GridDeps, ch: Frame, size: number): Promise<string> {
  // 截图前动画稳定等待
  await deps.page.waitForTimeout(1000)
  const shot = await ch.locator('#rc-imageselect-target').first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
  if (!shot) throw new Error('九宫格网格截图失败（整图 img 缺失且容器截图失败）')
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

/** 原生点击（官方 selenium click 等价：trusted、自动滚动居中） */
async function nativeClick(ch: Frame, selector: string, nth = 0): Promise<boolean> {
  try {
    await ch.locator(selector).nth(nth).click({ timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/** 错误提示读取（诊断用）：select-more = 选择不完整；incorrect = 选错已刷题 */
async function readErrorHint(ch: Frame): Promise<'select-more' | 'incorrect' | null> {
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
  return null
}

export interface GridDeps {
  page: Page
  provider: CaptchaProvider
  logger: Pick<Logger, 'info' | 'warn'>
  human: Humanizer
}

export interface GridOpts {
  maxRounds?: number
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
  if (!(await nativeClick(rc.ch, TILE_SELECTOR, idx))) {
    deps.logger.warn({ idx }, '九宫格格子原生点击失败，尝试坐标拟人兜底')
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
    await nativeClick(rc.ch, TILE_SELECTOR, idx)
  }
  deps.logger.info({ step: 'grid-click-diag', ...diag, afterClass: await readTileClass(rc.ch, idx) }, '九宫格点击诊断')
}

/** 单轮：读提示语 → 官方整图分类 → 逐格点选 → 等动画收尾 → 点验证 → 返回是否通过 */
async function solveOneRound(deps: GridDeps, rc: RoundCtx): Promise<boolean> {
  // 真机教训：bframe DOM 可能晚于 frame 附着渲染，提示语短轮询读取（frame 失效由 catch 兜底继续轮询）
  const promptDeadline = Date.now() + PROMPT_POLL_TIMEOUT_MS
  let prompt = ''
  while (Date.now() < promptDeadline) {
    prompt = ((await rc.ch.locator(PROMPT_SELECTOR).first().textContent().catch(() => '')) ?? '').trim()
    if (prompt) break
    await deps.page.waitForTimeout(PROMPT_POLL_MS)
  }
  if (!prompt) throw new Error('九宫格提示文字未找到')
  const qid = mapQuestionId(prompt)
  if (!qid) throw new Error(`未覆盖的九宫格提示语: ${prompt}`)
  deps.logger.info({ prompt, qid }, '九宫格识别目标')
  rc.prompt = prompt
  rc.qid = qid
  const grid = await readGridImage(deps, rc.ch)
  if (!grid) throw new Error('九宫格网格图获取失败')
  let result: GridResult
  try {
    result = await rc.classify(grid.b64, qid, GRID_COST_POINTS)
  } catch (e) {
    if (e instanceof CaptchaFailure && /ERROR_GARBAGE_SAMPLE|ERROR_ILLEGAL_IMAGE|ERROR_PARSE_IMAGE_FAIL/.test(e.message)) {
      deps.logger.warn({ err: e.message }, '九宫格分类图片质量被平台拒收，跳过本轮（下一轮重新截图）')
      return false
    }
    throw e
  }
  if (result.type !== 'multi') throw new Error('九宫格分类未返回 multi 结果')
  if (result.objects.length === 0) {
    deps.logger.warn('九宫格分类返回空数组，跳过本轮（不点验证，等下一轮）')
    return false
  }
  deps.logger.info({ objects: result.objects }, '九宫格识别完成，开始点选')
  for (const idx of result.objects) await clickTile(deps, rc, idx)
  // 官方点 verify 前 sleep 3：等全部格子动画收尾（图片还在变化时点 verify 会被 Google 判选择未完成）
  await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1000))
  if (!(await nativeClick(rc.ch, VERIFY_SELECTOR))) {
    deps.logger.warn('九宫格验证按钮点击失败')
    return false
  }
  await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
  const hint = await readErrorHint(rc.ch)
  deps.logger.info({ step: 'grid-round-state', prompt, qid, objects: result.objects, hint }, '九宫格轮次状态')
  return true
}

/**
 * 九宫格模拟点击求解主入口：
 * 找锚点 → 点复选框 → 等挑战 frame → 循环（每轮重取 frame → 官方流程一轮 → 查 aria-checked）
 * @param opts.maxRounds 同窗口验证轮数上限（默认 3）：耗尽返回 'failed' 交任务重试换新窗口（同会话风控保护）
 * @param opts.siteKeyExclude 跳过的常驻 sitekey（页面常驻 v3 锚点，避免误点无效果的复选框）
 * @param opts.maxCostPerTask 余额下限（undefined 不校验）
 * @param opts.onLog 分类成本记账（platform 取自 provider.platform）
 * @returns 'none' 无锚点 frame；'solved' 通过；'failed' 轮数耗尽
 */
export async function solveRecaptchaGrid(deps: GridDeps, opts: GridOpts = {}): Promise<'solved' | 'none' | 'failed'> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS_DEFAULT
  const onLog = opts.onLog ?? (() => {})
  /** 分类封装：余额校验 + 官方价格分档记账（主网格 6 点 / 1x1 单格 2 点）；不传 confidence（官方默认前三） */
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
  if (!(await nativeClick(anchor, ANCHOR_SELECTOR))) {
    deps.logger.warn('锚点复选框点击失败（继续流程，后续轮次自纠）')
  }
  // 等挑战 frame 出现；期间锚点直接变绿 = 一键通过（v3 直过等价）
  let challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
  for (let i = 0; i < 30 && !challenge; i++) {
    await deps.page.waitForTimeout(500)
    challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
    if (!challenge && await anchorChecked()) { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
  }
  for (let round = 0; round < maxRounds; round++) {
    // 每轮重取 frame：Google 换图后旧 Frame 引用可能失效（真机窗口 92 教训）；
    // DOM 里能找到就用新的，找不到回退上一轮引用
    const ch = findChallengeFrame(deps.page, opts.siteKeyExclude) ?? challenge
    if (!ch) {
      if (await anchorChecked()) { deps.logger.info('九宫格一键通过（未出图）'); return 'solved' }
      deps.logger.warn({ round: round + 1 }, '挑战 frame 未出现且未变绿，跳过本轮')
      challenge = null
      continue
    }
    challenge = ch
    const rc: RoundCtx = { ch, qid: '', prompt: '', classify }
    // 提示语未覆盖/整图缺失等结构性错误：重试大概率同错，直接抛出由任务层决定
    await solveOneRound(deps, rc)
    if (await anchorChecked()) return 'solved'
    deps.logger.warn({ round: round + 1 }, '九宫格本轮未通过，继续下一轮')
    challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
    // 轮间随机等待：Google 对同会话连续验证有风控
    await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1500))
  }
  return 'failed'
}
