/**
 * 打码平台抽象接口（integrations 层）：平台无关契约，automation 层只依赖此文件
 * 依赖方向：不依赖任何项目模块，被 integrations/captcha 各平台实现与 automation/captcha 依赖
 * 设计思路：各打码平台 API 差异（任务类型名/认证/返回结构）由平台子目录自行消化，
 * 对外统一实现 CaptchaProvider；未来接入 capsolver/2captcha 等 = 新增平台子目录 + config 切换
 */
/** token 类验证码类型（solveToken 支持；image 类型官方为 body 参数且同步/异步双形态，本次不迁移，见计划核对总表） */
export type TokenCaptchaKind = 'turnstile' | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha'
/** 全部验证码类型（含九宫格图片分类，仅用于记账/日志） */
export type CaptchaKind = TokenCaptchaKind | 'recaptcha_v2_grid'

/** 页面验证码检测结果 */
export interface CaptchaDetected {
  kind: TokenCaptchaKind
  sitekey: string | null
}

/** 打码业务失败（余额不足/解题超时/无 sitekey 等）；window-runner 以此区分 captcha_failed 终态 */
export class CaptchaFailure extends Error {}

/** 九宫格分类结果：multi = 需要点击的格子序号（3x3 为 0-8，4x4 为 0-15）；single = 单图是否含目标 */
export type GridResult = { type: 'multi'; objects: number[] } | { type: 'single'; hasObject: boolean }

/** 各类型单次解题估算点数（1 点 = ¥0.001；点数按 yescaptcha 官方价格表，见计划核对总表） */
export const ESTIMATED_COST_POINTS: Record<CaptchaKind, number> = {
  turnstile: 25,
  recaptcha_v2: 15,
  recaptcha_v3: 20,
  hcaptcha: 30,
  recaptcha_v2_grid: 6,
}

/** 打码成本记账回调（platform 用于多平台记账区分） */
export type CaptchaLogFn = (platform: string, kind: string, ok: boolean, costPoints: number) => void

/** 打码平台统一接口 */
export interface CaptchaProvider {
  /** 平台标识（如 'yescaptcha'），记账与日志区分用 */
  readonly platform: string
  /**
   * token 类解题：创建任务 → 轮询结果 → 返回 token
   * @param kind 验证码类型（决定平台任务类型与 solution 取值字段）
   * @param sitekey 站点 sitekey（缺失由实现抛 CaptchaFailure）
   * @param pageUrl 触发验证码的页面地址
   * @param extra 透传给平台任务体的附加参数（官方可选参数原样透传：recaptcha_v2 的 isInvisible、
   *   recaptcha_v3 的 pageAction、hcaptcha 的 userAgent/isInvisible/rqdata）
   */
  solveToken(kind: TokenCaptchaKind, sitekey: string | null, pageUrl: string, extra?: Record<string, unknown>): Promise<string>
  /**
   * 九宫格图片分类：提交网格/单格图（已缩放到官方标准尺寸的 Base64，无 data: 前缀）与问题 ID
   * @param image 图片 Base64（无 data: 前缀；官方要求标准大小 100x100/300x300/450x450）
   * @param questionId 问题 ID（官方要求以 /m/ 开头）
   * @param confidence 置信度阈值（官方 int 非必填；3x3 指定后返回所有大于分值的结果；4x4/1x1 指定无意义）
   */
  classifyGrid(image: string, questionId: string, confidence?: number): Promise<GridResult>
  /** 查询账户余额（点） */
  getBalance(): Promise<number>
}
