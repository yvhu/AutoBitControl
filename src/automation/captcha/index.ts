/**
 * captcha 能力出口（automation/captcha 层）：仅 Turnstile 交互式方框点击
 * 依赖方向：汇总本目录实现，供 engine 层统一导入
 */
export { clickTurnstileBox, turnstileVisible, autoClickTurnstile, TURNSTILE_FRAME_SEL } from './turnstile'
export type { TurnstileDeps, TurnstileBox } from './turnstile'
