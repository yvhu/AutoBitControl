/**
 * reCAPTCHA 九宫格模拟点击求解（automation 层）：点复选框 → 容器元素截图网格 → yescaptcha 分类 →
 * 按坐标点选（点击后按 img src 变化检测小图刷新 → 小图二次识别 → 命中再点确认）→
 * 验证 → 查 aria-checked → 未通过则下一轮，直到变绿
 * 真机核实（2026-09-09，faucet.circle.com）：挑战为 reCAPTCHA Enterprise
 * （anchor iframe: recaptcha/enterprise/anchor；网格 iframe: recaptcha/enterprise/bframe），
 * 兼容普通版（recaptcha/api2/anchor / api2/bframe）；官方 DEMO 流程
 * （yescaptcha 文档页 29786113）为协议来源；点击后 Google 刷新该格小图，
 * 真实人流程是看刷新后新图是否仍为目标 → 再点一次确认（2022 DEMO 的 class selected 语义已失效）
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
import { writeFileSync, mkdirSync } from 'node:fs'
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
    // 网格图一律走容器元素截图（fetch 每格原图拼接方案已废弃：拿到的内容与视觉图不符，真机窗口 89）
    // 截图前等待 1.5-2.5s 随机：等网格渐入动画稳定（真机空数组/ERROR_GARBAGE_SAMPLE 与动画未稳定截图相关）
    await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    const shot = await shotGrid()
    // 诊断落盘：raw 为截图原样、std 为发给分类服务的图（对比看变形；写盘失败静默不影响任务）
    const debugDir = join(process.cwd(), 'data', 'screenshots', 'grid-debug')
    try {
      mkdirSync(debugDir, { recursive: true })
      writeFileSync(join(debugDir, `grid-raw-${Date.now()}.png`), shot)
    } catch { /* 诊断写盘失败静默 */ }
    const std = await (await toStandardImage(shot, tileCount === 16 ? 450 : 300)).getBufferAsync(Jimp.MIME_PNG)
    try {
      writeFileSync(join(debugDir, `grid-std-${Date.now()}.png`), std)
    } catch { /* 诊断写盘失败静默 */ }
    const b64 = std.toString('base64')
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
    // 拟人坐标点击优先（Google 忽略瞬移式程序化点击）；framePoint 拿不到坐标回退 locator 直点
    if (!(await humanClickInFrame(deps, ch, TILE_SELECTOR, idx))) {
      await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
    }
    await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    // 点击后 Google 刷新该格小图（2022 DEMO 的 class selected 语义已变）：
    // src 变化 → 小图二次识别，命中再点确认；src 未变且无 selected → 点击可能未注册，重试点击
    for (let k = 0; k < SINGLE_RECHECK_MAX; k++) {
      const after = (await tiles.nth(idx).locator('img').first().getAttribute('src').catch(() => null)) ?? ''
      if (before !== after) {
        // 小图二次识别用该格 img 元素截图（fetch 原图方案已废弃：拿到的内容与视觉图不符）
        const singleShot = await tiles.nth(idx).locator('img').first().screenshot({ type: 'png', timeout: 10000 }).catch(() => null)
        let singleB64: string | null = null
        if (singleShot) singleB64 = await toStandardBase64(singleShot, 100)
        if (!singleB64) break
        const single = await deps.captcha.solveGrid(singleB64, qid, passOpts)
        if (single.type === 'single' && single.hasObject) {
          deps.logger.warn({ idx, recheck: k + 1 }, '九宫格小图刷新后仍含目标，再次点击确认')
          if (!(await humanClickInFrame(deps, ch, TILE_SELECTOR, idx))) {
            await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
          }
          await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
          before = after
          continue
        }
        break
      }
      const cls = (await tiles.nth(idx).getAttribute('class').catch(() => '')) ?? ''
      if (cls.includes('selected')) break
      deps.logger.warn({ idx }, '九宫格点击可能未注册（src 未变且无 selected），重试点击')
      if (!(await humanClickInFrame(deps, ch, TILE_SELECTOR, idx))) {
        await tiles.nth(idx).click({ timeout: 5000 }).catch(() => {})
      }
      await deps.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000))
    }
  }
  if (!(await humanClickInFrame(deps, ch, VERIFY_SELECTOR))) {
    await ch.locator(VERIFY_SELECTOR).first().click({ timeout: 5000 }).catch(() => {})
  }
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
