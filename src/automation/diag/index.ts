/**
 * diag 能力出口（automation/diag 层）：步骤记录（后续诊断包在此目录扩展）
 * 依赖方向：汇总本目录实现
 */
export { StepRecorder, type StepRecord } from './recorder'
export { collectDiagnostics, writeDiagBundle } from './bundle'
export type { DiagBundle, CollectDiagOpts } from './bundle'
