/**
 * captcha 能力出口（automation/captcha 层）：仅封装 Turnstile 交互式方框的检测与点击。
 * 对外提供 clickTurnstileBox（一次等框并点击）、turnstileVisible（可见性检查）、
 * autoClickTurnstile（预算内自动等框点击）、以及默认选择器常量与依赖/盒类型。
 * 依赖方向：汇总本目录实现，供 engine 层统一导入
 */
export { clickTurnstileBox, turnstileVisible, autoClickTurnstile, TURNSTILE_FRAME_SEL } from './turnstile'
export type { TurnstileDeps, TurnstileBox } from './turnstile'
