/**
 * dom 能力出口（automation/dom 层）：把本目录的 DOM 交互原语汇总成统一入口。
 * 对外提供：探针类型与定位/可见性/文案查找（probe）、多探针竞速（race）、
 * 刷新恢复等待（recover）、坐标点击（click）。engine 层只从这里导入，不深入具体文件。
 * 依赖方向：汇总本目录实现，供 engine 层统一导入
 */
export { type Probe, probeLocator, probeVisible, probePresent, firstTextPresent, probeDesc } from './probe'
export { raceProbes } from './race'
export { recoverProbe, type RecoverOpts } from './recover'
export { clickPoint } from './click'
