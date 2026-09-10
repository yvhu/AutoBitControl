/**
 * yescaptcha 平台任务类型映射（平台私有实现细节，不进用户配置）
 * 类型名按 yescaptcha 官方文档精确拼写，出处见计划核对总表（wiki 页面 164286 价格表 + 各类型页）：
 *   turnstile → TurnstileTaskProxyless（61734913）；recaptcha_v2 → NoCaptchaTaskProxyless（229796）
 *   recaptcha_v3 → RecaptchaV3TaskProxyless（655381）；hcaptcha → HCaptchaTaskProxyless（7929858）
 *   recaptcha_v2_grid → ReCaptchaV2Classification（18055169）
 * 注意：官方 image 类型（ImageToTextTask，164300）参数为 body 且分同步/异步双形态，本次不迁移
 */
import type { TokenCaptchaKind, CaptchaKind } from '../provider'

/** token 类验证码 → yescaptcha 任务类型 */
export const YESCAPTCHA_TOKEN_TASK_TYPES: Record<TokenCaptchaKind, string> = {
  turnstile: 'TurnstileTaskProxyless',
  recaptcha_v2: 'NoCaptchaTaskProxyless',
  recaptcha_v3: 'RecaptchaV3TaskProxyless',
  hcaptcha: 'HCaptchaTaskProxyless',
}

/** 九宫格图片分类任务类型（官方：返回图片坐标需要模拟点击，不返回 RESPONSE） */
export const YESCAPTCHA_GRID_TASK_TYPE = 'ReCaptchaV2Classification'

/** 记账/日志全类型（含九宫格） */
export const ALL_CAPTCHA_KINDS: CaptchaKind[] = [
  'turnstile', 'recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'recaptcha_v2_grid',
]
