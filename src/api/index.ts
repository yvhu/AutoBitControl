/** api 唯一出口：任务只从这里 import 能力函数 */
export { openPage, click, fill, pressKey, runJs } from './page'
export { elementState, countElements, getText, hasText } from './find'
export { waitFor, race, waitResponse } from './wait'
export type { Probe, WaitProbe, WaitOptions } from './wait'
export { loginWallet } from './wallet'
export type { WalletType, WalletScenario, WalletIntent, LoginSpec } from './wallet'
