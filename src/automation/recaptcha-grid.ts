/**
 * reCAPTCHA 九宫格模拟点击求解（automation 层）：点复选框 → 下载每格原图拼接网格 → yescaptcha 分类 →
 * 按坐标点选（点击后按 img src 变化检测小图刷新 → 小图二次识别 → 命中再点确认）→
 * 验证 → 查 aria-checked → 未通过则下一轮，直到变绿
 * 真机核实（2026-09-09，faucet.circle.com）：挑战为 reCAPTCHA Enterprise
 * （anchor iframe: recaptcha/enterprise/anchor；网格 iframe: recaptcha/enterprise/bframe），
 * 兼容普通版（recaptcha/api2/anchor / api2/bframe）；官方 DEMO 流程
 * （yescaptcha 文档页 29786113）为协议来源；点击后 Google 刷新该格小图，
 * 真实人流程是看刷新后新图是否仍为目标 → 再点一次确认（2022 DEMO 的 class selected 语义已失效）
 * 网格图优先走每格原图下载拼接（官方 DEMO 正统方式，避免容器截图拉伸变形与动画截图失真），
 * 原图获取失败退回容器截图兜底
 * 依赖方向：依赖 integrations/yescaptcha 类型，被 engine/task-context 包装调用
 */
import type { Page, Frame } from 'patchright'
import Jimp from 'jimp'
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
/** 网格容器（原图获取失败时截图兜底用） */
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

/** PNG buffer 缩放至标准尺寸并转 Base64（无 data: 前缀） */
async function toStandardBase64(buf: Buffer, size: number): Promise<string> {
  const img = await Jimp.read(buf)
  await img.resize(size, size)
  return (await img.getBase64Async(Jimp.MIME_PNG)).replace(/^data:image\/\w+;base64,/, '')
}

/** 单格原图标准边长（recaptcha 单格原图即 100x100；读出尺寸不同统一 resize 对齐） */
const TILE_ORIGINAL_SIZE = 100

/**
 * 下载挑战 frame 内每格原图并 jimp 拼接为标准分类图（官方 DEMO 正统方式）：
 * 3x3 拼 300x300；4x4 拼 400x400 后整体放大到 450x450（等比例放大 12.5%，分类服务要求）
 * evaluate 内对每格 img fetch 其 src 得原始字节（避免元素截图拉伸变形/拍在动画中）
 * @returns ok=false 表示获取失败（全空或数量不足），调用方应退回容器截图兜底
 */
export async function captureGridImage(ch: Frame, tileCount: number): Promise<{ b64: string; ok: boolean }> {
  let parts: number[][]
  try {
    parts = await ch.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('#rc-imageselect-target table td img'))
      const out: number[][] = []
      for (const img of imgs) {
        try {
          const r = await fetch(img.src)
          const buf = await r.arrayBuffer()
          out.push(Array.from(new Uint8Array(buf)))
        } catch {
          out.push([])
        }
      }
      return out
    })
  } catch {
    return { b64: '', ok: false }
  }
  if (parts.filter((p) => p.length > 0).length < tileCount) return { b64: '', ok: false }
  const cols = tileCount === 16 ? 4 : 3
  const canvasSize = tileCount === 16 ? 450 : 300
  const base = new Jimp(cols * TILE_ORIGINAL_SIZE, cols * TILE_ORIGINAL_SIZE, 0xffffffff)
  for (let i = 0; i < tileCount; i++) {
    const tile = await Jimp.read(Buffer.from(parts[i]))
    if (tile.getWidth() !== TILE_ORIGINAL_SIZE || tile.getHeight() !== TILE_ORIGINAL_SIZE) {
      await tile.resize(TILE_ORIGINAL_SIZE, TILE_ORIGINAL_SIZE)
    }
    base.composite(tile, (i % cols) * TILE_ORIGINAL_SIZE, Math.floor(i / cols) * TILE_ORIGINAL_SIZE)
  }
  if (canvasSize !== cols * TILE_ORIGINAL_SIZE) await base.resize(canvasSize, canvasSize)
  const b64 = (await base.getBase64Async(Jimp.MIME_PNG)).replace(/^data:image\/\w+;base64,/, '')
  return { b64, ok: true }
}

/** 下载单格小图原图（evaluate 内 fetch img src）；失败返回 null（调用方退回元素截图） */
async function fetchTileOriginal(ch: Frame, idx: number): Promise<Buffer | null> {
  try {
    const parts = await ch.evaluate(async (i: number) => {
      const img = document.querySelectorAll<HTMLImageElement>('#rc-imageselect-target table td img')[i]
      if (!img) return [[]]
      try {
        const r = await fetch(img.src)
        const buf = await r.arrayBuffer()
        return [Array.from(new Uint8Array(buf))]
      } catch {
        return [[]]
      }
    }, idx)
    const part = parts?.[0] ?? []
    return part.length > 0 ? Buffer.from(part) : null
  } catch {
    return null
  }
}

/** 点刷新换图并等新一批图渲染（点击失败静默：部分主题下按钮瞬时不可点时由后续重试/下一轮兜底） */
async function reloadImages(deps: { page: Page }, ch: Frame): Promise<void> {
  await ch.locator(RELOAD_SELECTOR).first().click({ timeout: 5000 }).catch(() => {})
  // 2000-3000ms 随机：等 Google 换出并渲染新一批图（固定间隔同会话连续刷新有风控）
  await deps.page.waitForTimeout(2000 + Math.floor(Math.random() * 1000))
}

/**
 * 单轮：读提示语 → 截图网格 → 分类（可重试块：空数组/抛错时点刷新换图，每轮最多 RELOAD_MAX 次，
 * 换图后提示语可能变化必须重读）→ 点格子（img src 变化检测小图刷新二次识别确认）→ 点验证
 * 刷新重试后仍空数组：记 warn 返回（不点 verify，主循环查 aria-checked 未通过则下一轮）
 * 刷新重试后仍抛错：抛错（任务失败）；opts 透传给 solveGrid 做成本记账
 */
async function solveOneRound(deps: { page: Page; captcha: CaptchaService; logger: Pick<Logger, 'info' | 'warn'>; human: Humanizer }, ch: Frame, opts: { profileId?: number | null; taskKey?: string | null; onLog?: (kind: string, ok: boolean, costPoints: number) => void } = {}): Promise<void> {
  const passOpts = { profileId: opts.profileId ?? null, taskKey: opts.taskKey ?? null, onLog: opts.onLog ?? (() => {}) }
  // 网格截图 10s 超时，失败 1 秒后重试一次，仍失败抛错（真机窗口 93 曾 30s 超时——元素动画中不稳定）
  const shotGrid = async (): Promise<Buffer> => {
    let shot = await ch.locator(GRID_SELECTOR).first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
    if (!shot) {
      deps.logger.warn('九宫格网格截图失败（元素可能动画中），1 秒后重试一次')
      await deps.page.waitForTimeout(1000)
      shot = await ch.locator(GRID_SELECTOR).first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
    }
    if (!shot) throw new Error('九宫格网格截图重试后仍失败')
    return shot
  }
  let result: GridResult | null = null
  let qid = ''
  let tiles = ch.locator(TILE_SELECTOR)
  // 分类可重试块：空数组/抛错（如 ERROR_GARBAGE_SAMPLE 图片质量差）→ 点刷新换图重试
  for (let reload = 0; ; reload++) {
    // 提示语等待重读：bframe 注入后网格 DOM 可能未渲染完（首读空串），最多等 PROMPT_WAIT_TIMEOUT_MS；
    // 换图后 Google 可能换提示语，因此每次重试都重读（不沿用上一轮提示语）
    let prompt = ''
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
    // 网格图优先每格原图下载拼接（官方 DEMO 方式）；获取失败退回容器截图兜底，截图兜底仍失败抛错
    const grid = await captureGridImage(ch, tileCount)
    let b64: string
    if (grid.ok) {
      b64 = grid.b64
    } else {
      deps.logger.warn('九宫格每格原图下载失败，退回容器截图拼接')
      b64 = await toStandardBase64(await shotGrid(), tileCount === 16 ? 450 : 300)
    }
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
        deps.logger.warn('九宫格分类刷新换图后仍为空数组，本轮放弃（不点验证，等主循环下一轮）')
        return
      }
      deps.logger.warn({ reload: reload + 1 }, '九宫格分类返回空数组，点刷新换图重试')
      await reloadImages(deps, ch)
      continue
    }
    break
  }
  if (!result) throw new Error('九宫格分类无结果')
  deps.logger.info({ objects: result.objects, round: 'multi' }, '九宫格识别完成，开始点选')
  for (const idx of result.objects) {
    let before = (await tiles.nth(idx).locator('img').first().getAttribute('src').catch(() => null)) ?? ''
    await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
    await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    // 点击后 Google 刷新该格小图（2022 DEMO 的 class selected 语义已变）：
    // src 变化 → 小图二次识别，命中再点确认；src 未变且无 selected → 点击可能未注册，重试点击
    for (let k = 0; k < SINGLE_RECHECK_MAX; k++) {
      const after = (await tiles.nth(idx).locator('img').first().getAttribute('src').catch(() => null)) ?? ''
      if (before !== after) {
        // 小图二次识别优先下载该格原图（不再元素截图）；原图获取失败退回元素截图，两者都失败则跳过识别
        const singleOriginal = await fetchTileOriginal(ch, idx)
        let singleB64: string | null = null
        if (singleOriginal) {
          singleB64 = await toStandardBase64(singleOriginal, 100)
        } else {
          const singleShot = await tiles.nth(idx).locator('img').first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
          if (singleShot) singleB64 = await toStandardBase64(singleShot, 100)
        }
        if (!singleB64) break
        const single = await deps.captcha.solveGrid(singleB64, qid, passOpts)
        if (single.type === 'single' && single.hasObject) {
          deps.logger.warn({ idx, recheck: k + 1 }, '九宫格小图刷新后仍含目标，再次点击确认')
          await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
          await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
          before = after
          continue
        }
        break
      }
      const cls = (await tiles.nth(idx).getAttribute('class').catch(() => '')) ?? ''
      if (cls.includes('selected')) break
      deps.logger.warn({ idx }, '九宫格点击可能未注册（src 未变且无 selected），重试点击')
      await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
      await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    }
  }
  await ch.locator(VERIFY_SELECTOR).first().click({ timeout: 5000 }).catch(() => {})
  await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1000))
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
  // iframe 元素已插入 DOM 但 CDP frame 可能未附着（真机窗口 97 实测）——轮询等附着
  let anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  for (let i = 0; i < 30 && !anchor; i++) {
    await deps.page.waitForTimeout(500)
    anchor = findAnchorFrame(deps.page, opts.siteKeyExclude)
  }
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
    // 轮间随机 2500-4000ms：Google 对同会话连续验证有风控，需要比固定 2s 更自然的间隔
    await deps.page.waitForTimeout(2500 + Math.floor(Math.random() * 1500))
  }
  return 'failed'
}
