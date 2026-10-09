/**
 * automation 能力库总出口：engine 层只从这里导入
 * 依赖方向：汇总 dom/wallet/captcha/diag
 */
export * from './dom'
export * from './wallet'
export { StepRecorder } from './diag'
export type { StepRecord } from './diag'
