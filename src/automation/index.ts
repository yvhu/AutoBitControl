/**
 * automation 能力库总出口：engine 层只从这里导入
 * 依赖方向：汇总 dom/wallet/diag
 */
export * from './dom'
export * from './wallet'
export * from './captcha'
export { StepRecorder, collectDiagnostics, writeDiagBundle } from './diag'
export type { StepRecord, DiagBundle, CollectDiagOpts } from './diag'
