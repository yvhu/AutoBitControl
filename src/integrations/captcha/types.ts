/**
 * 打码平台公共接口（integrations 层）：插件式解题路线的平台最小契约
 * 依赖方向：不依赖任何项目模块，被各平台实现与 server 层依赖
 * 设计思路：浏览器插件负责自动解题（平台无关），平台层当前只需余额查询；
 *   未来接协议解题路线时在此接口扩展方法，各平台按文件独立实现（如 capsolver.ts）
 */
export interface CaptchaPlatform {
  /** 平台标识（如 'yescaptcha'），面板展示与日志区分用 */
  readonly platform: string
  /** 查询账户余额（点） */
  getBalance(): Promise<number>
}
