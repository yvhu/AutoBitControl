/**
 * 钱包适配器类型层（automation 层）：钱包插件的统一接口与注册表
 * 依赖方向：纯类型 + Map 实现，无运行时依赖；被 engine/window-runner、task-context 依赖
 * 设计思路：各钱包只实现 unlock + 三确认动作（connect/sign/confirmTx），
 * 任务侧只按 key 取适配器，不感知插件 UI 差异（新增钱包只需新写一个适配器文件并注册）
 */

/**
 * 缩小化的定位器接口：只暴露钱包适配真正用到的少量 API，好处是测试时能轻松 mock，
 * 也避免适配器代码被 patchright 全量 API 绑死。
 * 典型用法链：按 testid/role/selector 拿到 PopupLocator → .first() 取首个匹配 → click/fill/count/waitFor。
 */
export interface PopupLocator {
  /** 点击该元素；opts.timeout 为最长等待可点击时间（毫秒），缺省由实现决定 */
  click(opts?: { timeout?: number }): Promise<void>
  /** 向输入框填入文本（覆盖式填写，非逐键输入） */
  fill(text: string): Promise<void>
  /** 可选：向该元素按下某个键（如 Enter 回车提交）；mock 可不实现 */
  press?(key: string): Promise<void>
  /** 取首个匹配元素，返回同样是 PopupLocator，用于把「多个候选」收敛成「单个目标」 */
  first(): PopupLocator
  /** 元素是否存在（0/1/多；真实 Locator.count 实现，mock 可不提供） */
  count?(): Promise<number>
  /** 等待元素状态变化（如解锁页 detached；真实 Locator.waitFor 实现，mock 可不提供） */
  waitFor?(opts: { state?: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number }): Promise<void>
}

/**
 * 缩小化的弹窗页面接口：钱包适配器操作的是「钱包插件弹出的小窗口」，
 * 这里只保留适配所需的定位与事件能力，不直接依赖 playwright Page 全量 API。
 */
export interface PopupPage {
  /** 当前弹窗页 URL（用于识别是解锁页、签名页还是已关闭等） */
  url(): string
  /** 按无障碍角色 + 名称正则定位；role 如 'button'，opts.name 为正则（适配器用它匹配多语言按钮文案） */
  getByRole(role: string, opts: { name: RegExp }): PopupLocator
  /** 按 data-testid 定位（MetaMask 稳定、与 UI 语言无关的首选方式） */
  getByTestId(id: string): PopupLocator
  /** 按 CSS 选择器定位（无 testid 时使用，如 Petra 的 has-text 选择器） */
  locator(selector: string): PopupLocator
  /** 等待页面事件（如 'close' 表示弹窗关闭）；opts.timeout 为最长等待毫秒数 */
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<void>
  /** 弹窗页是否已关闭（真实 Page.isClosed；mock 可不提供） */
  isClosed?(): boolean
}

/**
 * 钱包适配器契约：每种钱包插件实现同一个接口，任务侧只按 key 取用，不感知各插件 UI 的差异。
 * 抽象出四种交互：解锁、连接、签名、交易确认——前三者是可选的「一次弹窗一次意图」动作。
 */
export interface WalletAdapter {
  /** 钱包类型标识，全局唯一，与 TaskMeta.wallet 对应（如 'metamask'/'petra'） */
  key: string
  /** 用于判断某个弹窗页 URL 是否属于该钱包的 URL 模式列表（正则字符串，见 waitForPopup） */
  extensionUrlPatterns: string[]
  /** 扩展 ID：CDP 探测扩展页用（MetaMask = nkbihfbeogaeaoehlefnkodbefgpgknn，真机弹窗 URL 实证） */
  extensionId: string
  /** 扩展页探测路径（MetaMask home.html / Petra index.html） */
  probePath: string
  /** 页面 provider 标识字段：区分其它钱包注入的 window.ethereum（isMetaMask / isPetra） */
  providerFlag: string
  /** 该钱包是否注入页面 provider：false 时跳过 provider 轮询，仅 CDP 扩展页探测判定就绪（Petra 实测不注入 window.petra） */
  expectsProvider?: boolean
  /**
   * 解锁插件（可选）：只有配置了密码且该插件需要解锁时才会被调用。
   * 流程通常是「等密码框出现 → 填入密码 → 提交 → 等解锁完成」，直到弹窗关闭。
   * @param popup 钱包弹窗页
   * @param password 该钱包的解锁密码（来自 walletPasswords）
   */
  unlock?(popup: PopupPage, password: string): Promise<void>
  /** 登录/连接授权（站点请求连接钱包）：在已解锁的弹窗上点确认，直到弹窗关闭 */
  connect(popup: PopupPage): Promise<void>
  /** 消息签名（站点请求 signMessage，如 Petra Sign In）：点签名确认，直到弹窗关闭 */
  sign(popup: PopupPage): Promise<void>
  /** 交易确认（站点请求发送/授权交易，如 Approve、register_blobs）：点确认，直到弹窗关闭 */
  confirmTx(popup: PopupPage): Promise<void>
}

/**
 * 钱包适配器注册表：以 key 为索引存放各钱包适配器，供运行时按任务配置的 wallet 取用。
 * 内部就是一个 Map；app 启动时把所有适配器注册进来，任务运行时只做查找。
 */
export class WalletRegistry {
  private map = new Map<string, WalletAdapter>()

  /** 注册适配器：以 adapter.key 为键写入；同 key 重复注册会覆盖旧值 */
  register(adapter: WalletAdapter): void {
    this.map.set(adapter.key, adapter)
  }

  /**
   * 按 key 取适配器。
   * @param key 钱包类型标识
   * @returns 对应适配器
   * @throws 未注册时抛错——任务配置了不存在的钱包 key 应当立刻暴露，而不是静默降级
   */
  get(key: string): WalletAdapter {
    const a = this.map.get(key)
    if (!a) throw new Error(`未注册的钱包适配器: ${key}`)
    return a
  }

  /** 是否已注册该 key（用于探测而不抛错，如配置校验时先问一声） */
  has(key: string): boolean {
    return this.map.has(key)
  }
}
