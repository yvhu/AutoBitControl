/**
 * automation 能力库总出口：engine 层只从这里导入，不深入各子目录。
 * 汇总四块能力——dom（探针/竞速/恢复/坐标点击）、wallet（钱包适配与登录编排）、
 * captcha（Turnstile 方框点击）、diag（步骤记录与失败诊断包）。
 * 依赖方向：汇总 dom/wallet/captcha/diag
 */
export * from './dom'
export * from './wallet'
export * from './captcha'
export { StepRecorder, collectDiagnostics, writeDiagBundle } from './diag'
export type { StepRecord, DiagBundle, CollectDiagOpts } from './diag'
