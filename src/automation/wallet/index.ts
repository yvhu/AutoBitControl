/**
 * wallet 能力出口（automation/wallet 层）
 * 依赖方向：汇总本目录实现，供 engine 层统一导入
 */
export { WalletRegistry } from './types'
export type { WalletAdapter, PopupPage, PopupLocator } from './types'
export { WalletActions } from './actions'
export type { WalletActionsDeps, PopupLoginOpts, WalletIntent } from './actions'
export { ensureLoggedIn } from './login-flow'
export type { LoginSpec, LoginProbe } from './login-flow'
export { waitForPopup } from './popup'
export { WalletSession } from './session'
export { openAppKitWallet } from './appkit'
export type { AppKitEntry, AppKitLoginOptions, AppKitNormalizeOpts } from './appkit'
export { MetaMaskAdapter } from './metamask'
export { PetraAdapter } from './petra'
