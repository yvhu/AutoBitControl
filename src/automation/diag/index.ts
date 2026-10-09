/**
 * diag 能力出口（automation/diag 层）：把步骤记录与失败诊断包汇总成统一入口。
 * 对外提供 StepRecorder/StepRecord（步骤时间线）、collectDiagnostics（采集页面上下文）、
 * writeDiagBundle（写盘）以及诊断包相关类型。
 * 依赖方向：汇总本目录实现
 */
export { StepRecorder, type StepRecord } from './recorder'
export { collectDiagnostics, writeDiagBundle } from './bundle'
export type { DiagBundle, CollectDiagOpts } from './bundle'
