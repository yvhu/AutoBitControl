/**
 * dom 能力出口（automation/dom 层）：探针/竞速/恢复/坐标点击
 * 依赖方向：汇总本目录实现，供 engine 层统一导入
 */
export { type Probe, probeLocator, probeVisible, firstTextPresent, probeDesc } from './probe'
export { raceProbes } from './race'
