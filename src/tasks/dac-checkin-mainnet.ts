/**
 * DAC 主网签到任务（dac-checkin-mainnet）：正式环境（主网）签到
 * 站点：https://interstellar.dachain.io/（主网）
 * 与 inception-dachain（原测试网量子箱开箱）区分：本任务为正式环境签到流程
 * 登录：点「Connect wallet」直开 MetaMask 扩展弹窗（无站内钱包列表）；已登录判据=页面出现 0x 地址；登录可能需多次尝试
 * 执行流程（登录已实现，签到待补）：打开任务页 → 自适应钱包登录 → （TODO）签到动作与成功断言
 * 依赖方向：依赖 ./base（任务基类）与 ../api（能力函数）
 * 状态：登录已完成，签到动作待真机核实后补全
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, connectWallet } from '../api'

/** 站点入口（主网） */
const SITE_URL = 'https://interstellar.dachain.io/'

/** 站内连接按钮文案（真机核实：纯按钮，无钱包选择列表，点击直开 MetaMask 扩展弹窗） */
const CONNECT_TEXT = 'Connect wallet'

/** 已登录判据：页面出现 0x 地址样式文本（同其它任务） */
const ADDRESS_TEXT = '0x'

export class DacCheckinMainnetTask extends SiteTask {
  meta: TaskMeta = {
    key: 'dac-checkin-mainnet', // 全局唯一任务键（面板/API/数据库均以此索引）
    name: 'DAC 签到（主网）', // 与测试网任务 inception-dachain 区分
    group: { key: 'dac-mainnet', name: 'DAC 主网' },
    url: SITE_URL,
    sourceUrl: '', // TODO: 填入来源说明链接
    note: '主网签到：点「Connect wallet」直开 MetaMask 扩展弹窗（无站内钱包列表）；已登录判据=页面出现 0x 地址；登录可能需多次尝试；签到动作与成功判定待补',
    category: 'checkin',
    lastUpdated: '2026-10-15',
    enabled: false, // 待签到动作补全并真机验证后再开启
    wallet: 'metamask',
    timeoutSec: 600,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  /**
   * 执行流程：打开任务页 → 自适应钱包登录（0x 判已登录；点 Connect wallet 直开钱包弹窗；多轮重试）。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })

    // 自适应钱包登录：已登录（出现 0x 地址）直接跳过；否则点 Connect wallet → MetaMask 扩展弹窗自动确认。
    // 无站内钱包选择列表，故不传 walletOption；登录可能需多次尝试，提高整体重试轮数。
    await connectWallet(ctx, {
      wallet: 'metamask',
      connected: { text: ADDRESS_TEXT },
      disconnected: CONNECT_TEXT,
      connect: `button:has-text("${CONNECT_TEXT}")`,
      attempts: 3,
      // 0 撸项目无真实链上交易：站点把授权/确认混入登录弹窗（被判为 tx），直接自动确认，避免登录卡死
      autoConfirmTransaction: true,
    })

    // TODO: 补全主网签到动作与成功断言（参考 konnex-checkin / auralaunch-checkin）
  }
}
