/**
 * 钱包适配器类型层（automation 层）：钱包插件的统一接口与注册表
 * 依赖方向：纯类型 + Map 实现，无运行时依赖；被 engine/window-runner、task-context 依赖
 * 设计思路：各钱包只实现 unlock/ensureConnected 两个动作，
 * 任务侧只按 key 取适配器，不感知插件 UI 差异（新增钱包只需新写一个适配器文件并注册）
 */

/** 缩小化的定位器接口：仅暴露钱包适配所需的少量 API，便于测试 mock */
export interface PopupLocator {
  click(opts?: { timeout?: number }): Promise<void>
  fill(text: string): Promise<void>
  press?(key: string): Promise<void>
  first(): PopupLocator
  /** 元素是否存在（0/1/多；真实 Locator.count 实现，mock 可不提供） */
  count?(): Promise<number>
  /** 等待元素状态变化（如解锁页 detached；真实 Locator.waitFor 实现，mock 可不提供） */
  waitFor?(opts: { state?: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number }): Promise<void>
}

/** 缩小化的弹窗页面接口：钱包适配器不直接依赖 playwright Page 全量 API */
export interface PopupPage {
  url(): string
  getByRole(role: string, opts: { name: RegExp }): PopupLocator
  getByTestId(id: string): PopupLocator
  locator(selector: string): PopupLocator
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<void>
}

/**
 * 钱包适配器契约：
 * key 全局唯一标识（与 TaskMeta.wallet 对应）；extensionUrlPatterns 用于识别钱包弹窗 URL；
 * unlock 可选——窗口未配置密码或插件无需解锁时跳过
 */
export interface WalletAdapter {
  key: string
  extensionUrlPatterns: string[]
  unlock?(popup: PopupPage, password: string): Promise<void>
  ensureConnected(popup: PopupPage): Promise<void>
}

/** 钱包适配器注册表：按 key 存储与查找（app 启动时注册所有适配器） */
export class WalletRegistry {
  private map = new Map<string, WalletAdapter>()

  /** 注册适配器（按 key 覆盖） */
  register(adapter: WalletAdapter): void {
    this.map.set(adapter.key, adapter)
  }

  /** 按 key 取适配器；未注册时抛错（任务配置了不存在的钱包 key 应立即暴露） */
  get(key: string): WalletAdapter {
    const a = this.map.get(key)
    if (!a) throw new Error(`未注册的钱包适配器: ${key}`)
    return a
  }

  /** 是否已注册该 key */
  has(key: string): boolean {
    return this.map.has(key)
  }
}
