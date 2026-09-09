/**
 * reCAPTCHA 九宫格模拟点击求解（automation 层）：点复选框 → 截图网格 → yescaptcha 分类 →
 * 按坐标点选 → 验证 → 查 aria-checked → 未通过则下一轮，直到变绿
 * 真机核实（2026-09-09，faucet.circle.com）：挑战为 reCAPTCHA Enterprise
 * （anchor iframe: recaptcha/enterprise/anchor；网格 iframe: recaptcha/enterprise/bframe），
 * 兼容普通版（recaptcha/api2/anchor / api2/bframe）；官方 DEMO 流程
 * （yescaptcha 文档页 29786113）为协议来源
 * 依赖方向：依赖 integrations/yescaptcha 类型，被 engine/task-context 包装调用
 */
import type { Page, Frame } from 'patchright'
import Jimp from 'jimp'
import type { CaptchaService } from '../integrations/yescaptcha'
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
/** 网格容器（截图用） */
export const GRID_SELECTOR = '#rc-imageselect-target'
/** 最大求解轮数 */
export const MAX_ROUNDS = 5
/** 单格小图二次识别最大次数 */
export const SINGLE_RECHECK_MAX = 2
/** 提示语渲染等待上限（毫秒；bframe 网格 DOM 可能晚于 frame 注入渲染） */
export const PROMPT_WAIT_TIMEOUT_MS = 10000
/** 提示语轮询间隔（毫秒） */
export const PROMPT_POLL_MS = 500

/** 提示语 → 问题 ID 映射（中英双语；官方中文表 + DEMO 英文表合并；未覆盖的提示语任务会失败，按日志扩充） */
export const QUESTION_ID_MAP: Record<string, string> = {
  '出租车': '/m/0pg52', '巴士': '/m/01bjv', '公交车': '/m/01bjv', '校车': '/m/02yvhj',
  '摩托车': '/m/04_sv', '拖拉机': '/m/013xlm', '烟囱': '/m/01jk_4', '人行横道': '/m/014xcs',
  '红绿灯': '/m/015qff', '自行车': '/m/0199g', '停车计价表': '/m/015qbp', '停车计时器': '/m/015qbp',
  '汽车': '/m/0k4j', '车辆': '/m/0k4j', '桥': '/m/015kr', '船': '/m/019jd', '棕榈树': '/m/0cdl1',
  '山': '/m/09d_r', '山丘': '/m/09d_r', '消防栓': '/m/01pns0', '楼梯': '/m/01lynh',
  'taxis': '/m/0pg52', 'taxi': '/m/0pg52', 'bus': '/m/01bjv', 'buses': '/m/01bjv', 'school bus': '/m/02yvhj',
  'motorcycles': '/m/04_sv', 'motorcycle': '/m/04_sv', 'tractors': '/m/013xlm', 'tractor': '/m/013xlm',
  'chimneys': '/m/01jk_4', 'chimney': '/m/01jk_4', 'crosswalks': '/m/014xcs', 'crosswalk': '/m/014xcs',
  'pedestrian crossings': '/m/014xcs', 'traffic lights': '/m/015qff', 'traffic light': '/m/015qff',
  'bicycles': '/m/0199g', 'bicycle': '/m/0199g', 'parking meters': '/m/015qbp', 'parking meter': '/m/015qbp',
  'cars': '/m/0k4j', 'car': '/m/0k4j', 'vehicles': '/m/0k4j', 'vehicle': '/m/0k4j',
  'bridges': '/m/015kr', 'bridge': '/m/015kr', 'boats': '/m/019jd', 'boat': '/m/019jd',
  'palm trees': '/m/0cdl1', 'palm tree': '/m/0cdl1', 'mountains or hills': '/m/09d_r', 'mountains': '/m/09d_r',
  'hills': '/m/09d_r', 'fire hydrant': '/m/01pns0', 'fire hydrants': '/m/01pns0', 'stairs': '/m/01lynh',
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

/** PNG buffer 缩放至标准尺寸并转 Base64（无 data: 前缀） */
async function toStandardBase64(buf: Buffer, size: number): Promise<string> {
  const img = await Jimp.read(buf)
  await img.resize(size, size)
  return (await img.getBase64Async(Jimp.MIME_PNG)).replace(/^data:image\/\w+;base64,/, '')
}

/** 单轮：读提示语 → 截图网格 → 分类 → 点格子（含小图刷新二次识别）→ 点验证；opts 透传给 solveGrid 做成本记账 */
async function solveOneRound(deps: { page: Page; captcha: CaptchaService; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer }, ch: Frame, opts: { profileId?: number | null; taskKey?: string | null; onLog?: (kind: string, ok: boolean, costPoints: number) => void } = {}): Promise<void> {
  // 提示语等待重读：bframe 注入后网格 DOM 可能未渲染完（首读空串），最多等 PROMPT_WAIT_TIMEOUT_MS
  let prompt = ''
  const promptDeadline = Date.now() + PROMPT_WAIT_TIMEOUT_MS
  while (Date.now() < promptDeadline && !prompt) {
    prompt = ((await ch.locator(PROMPT_SELECTOR).first().textContent().catch(() => '')) ?? '').trim()
    if (!prompt) await deps.page.waitForTimeout(PROMPT_POLL_MS)
  }
  if (!prompt) throw new Error('九宫格提示文字未找到')
  const qid = mapQuestionId(prompt)
  if (!qid) throw new Error(`未覆盖的九宫格提示语: ${prompt}`)
  deps.logger.info({ prompt, qid }, '九宫格识别目标')
  const tiles = ch.locator(TILE_SELECTOR)
  const tileCount = await tiles.count()
  const size = tileCount === 16 ? 450 : 300
  const shot = await ch.locator(GRID_SELECTOR).first().screenshot({ type: 'png' })
  const b64 = await toStandardBase64(shot, size)
  const result = await deps.captcha.solveGrid(b64, qid, { confidence: 0.5, profileId: opts.profileId ?? null, taskKey: opts.taskKey ?? null, onLog: opts.onLog ?? (() => {}) })
  if (result.type !== 'multi') throw new Error('九宫格分类未返回 multi 结果')
  deps.logger.info({ count: result.objects.length, round: 'multi' }, '九宫格识别完成，开始点选')
  for (const idx of result.objects) {
    await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
    await deps.page.waitForTimeout(2000)
    // 点击后格子可能刷新新小图（class 无 selected 即刷新）：小图二次识别决定是否再点
    for (let k = 0; k < SINGLE_RECHECK_MAX; k++) {
      const cls = (await tiles.nth(idx).getAttribute('class').catch(() => '')) ?? ''
      if (cls.includes('selected')) break
      const singleShot = await tiles.nth(idx).locator('img').first().screenshot({ type: 'png' }).catch(() => null)
      if (!singleShot) break
      const singleB64 = await toStandardBase64(singleShot, 100)
      const single = await deps.captcha.solveGrid(singleB64, qid, { profileId: opts.profileId ?? null, taskKey: opts.taskKey ?? null, onLog: opts.onLog ?? (() => {}) })
      if (single.type === 'single' && single.hasObject) {
        await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
        await deps.page.waitForTimeout(2000)
        continue
      }
      break
    }
  }
  await ch.locator(VERIFY_SELECTOR).first().click({ timeout: 5000 }).catch(() => {})
  await deps.page.waitForTimeout(3000)
}

/**
 * 九宫格模拟点击求解主入口：
 * 点复选框 → 等挑战 → 循环（读提示语 → 分类 → 点选 → 验证 → 查 aria-checked）→ 变绿返回 solved
 * @param opts.maxRounds 最大轮数（缺省 MAX_ROUNDS）
 * @param opts.siteKeyExclude 跳过的常驻 sitekey（如页面常驻 v3 锚点/bframe：避免误选 v3 复选框点击无效果）
 * @param opts.profileId/taskKey/onLog 透传给 solveGrid 做成本记账（缺省 null/空实现，向后兼容）
 * @returns 'none' 无锚点 frame；'solved' 通过；'failed' 轮数耗尽（提示语未覆盖等异常直接抛错）
 */
export async function solveRecaptchaGrid(
  deps: { page: Page; captcha: CaptchaService; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer },
  opts: { maxRounds?: number; siteKeyExclude?: string; profileId?: number | null; taskKey?: string | null; onLog?: (kind: string, ok: boolean, costPoints: number) => void } = {},
): Promise<'solved' | 'none' | 'failed'> {
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS
  const anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  if (!anchor) return 'none'
  // 点击失败只告警不中断：真机偶发点击未注册时，后续轮次能自我纠正
  await anchor.locator(ANCHOR_SELECTOR).first().click({ timeout: 10000 }).catch((e) => {
    deps.logger.warn({ err: (e as Error).message }, '锚点复选框点击失败（继续流程，后续轮次自纠）')
  })
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
    const ch = challenge ?? findChallengeFrame(deps.page, opts.siteKeyExclude)
    if (!ch) {
      const checked = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
      return checked === 'true' ? 'solved' : 'failed'
    }
    await solveOneRound(deps, ch, opts)
    const checked = await anchor.locator(ANCHOR_SELECTOR).first().getAttribute('aria-checked').catch(() => null)
    if (checked === 'true') return 'solved'
    deps.logger.warn({ round: round + 1 }, '九宫格本轮未通过，继续下一轮')
    challenge = findChallengeFrame(deps.page, opts.siteKeyExclude)
    await deps.page.waitForTimeout(2000)
  }
  return 'failed'
}
