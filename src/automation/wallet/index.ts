/**
 * wallet 能力出口（automation/wallet 层）：把钱包适配器、注册表、弹窗等待、会话检测与登录编排汇总成统一入口。
 * 对外主要提供：WalletRegistry/WalletAdapter/PopupPage 类型与注册表、WalletActions 动作门面、
 * ensureConnected 自适应连接编排、findConnectButton 连接按钮启发式、waitForPopup 弹窗等待、WalletSession 扩展就绪检测、
 * openAppKitWallet 归一化、以及 MetaMask/Petra 两个具体适配器。
 * 依赖方向：汇总本目录实现，供 engine 层统一导入
 */
export { WalletRegistry } from './types'
export type { WalletAdapter, PopupPage, PopupLocator, PopupKind } from './types'
export { createConfigWalletAdapter } from './config-adapter'
export type { WalletAdapterConfig } from './config-adapter'
export { WalletActions } from './actions'
export type { WalletActionsDeps, PopupLoginOpts, WalletIntent } from './actions'
export { ensureConnected } from './login-flow'
export type { LoginFlowOptions, LoginProbe } from './login-flow'
export { findConnectButton, HEURISTIC_CONNECTED, HEURISTIC_DISCONNECTED } from './heuristics'
export { waitForPopup } from './popup'
export { WalletSession } from './session'
export { openAppKitWallet } from './appkit'
export type { AppKitEntry, AppKitLoginOptions, AppKitNormalizeOpts } from './appkit'
export { MetaMaskAdapter } from './metamask'
export { PetraAdapter } from './petra'
