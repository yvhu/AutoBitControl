/**
 * 示例签到任务（example-checkin）：标准每日签到参考实现（新范式）
 * 站点：占位示例站点；url 为空、开关默认关闭，仅作调试与复制起点，无真实站点
 * 执行流程：打开任务页（url 为空则跳过）→ 声明式登录（竞速判登录态 → 点连接 → 签名/确认 → 等登录完成）
 *          → 判已签到（幂等）→ 点签到按钮 → 断言成功标志
 * 设计：run 内直接用 ../api 能力函数（openPage/loginWallet/click/hasText/waitFor）
 * 时间预算：timeoutSec 180s（单任务整体超时）、retry.max 2 次 / 退避 600s、concurrency 4
 * 新增任务从这里复制改起：先跑通流程，再逐步替换选择器
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, loginWallet, click, hasText, waitFor } from '../api'

export class ExampleCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'example-checkin', // 全局唯一任务键（面板/API/数据库均以此索引）
    name: '示例签到',
    group: { key: 'example', name: '示例' }, // 任务分组（面板按组展示）
    url: '', // 落地页；为空表示无导航步骤，默认 run 跳过 goto
    sourceUrl: '', // 任务来源说明链接（面板展示用）
    note: '示例任务：url 为空且开关默认关闭；调试时在面板任务页打开开关，或用 task:run 脚本直接跑（不受开关限制）',
    category: 'checkin', // 任务类别：签到
    lastUpdated: '2026-10-09',
    enabled: false, // 默认关闭：示例任务不参与定时/批量触发
    wallet: 'metamask', // 使用的钱包类型（决定登录/签名走哪个适配器）
    timeoutSec: 180, // 单任务整体超时秒数
    retry: { max: 2, backoffSec: 600 }, // 失败最多再试 2 次，每次退避 600s（不占窗）
    concurrency: 4, // 任务级并发上限（与全局 maxConcurrentWindows 取更严者）
  }

  /**
   * 执行流程：打开任务页 → 声明式钱包登录 → 判已签到（幂等）→ 点签到 → 断言成功标志。
   * url 为空表示无导航步骤（仅示例占位）。
   * @param ctx 任务上下文（page/log/task 等运行时数据）
   */
  async run(ctx: TaskContext): Promise<void> {
    if (this.meta.url) await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    // 登录：竞速判登录态 → 点连接 → 签名/确认 → 等登录完成（占位选择器，复制后替换）
    await loginWallet(ctx, {
      wallet: 'metamask',
      scenario: 'direct',
      loggedIn: { text: '已连接' },
      loggedOut: '连接钱包',
      connect: 'button:has-text("连接钱包")',
    })
    // 已签到直接成功返回（幂等：重复触发不报错）
    if (await hasText(ctx, '已签到')) return
    // 点签到按钮并断言成功标志（宁严勿松：必须显式等到成功元素才判成功）
    await click(ctx, '#checkin-btn')
    await waitFor(ctx, { selector: '#checked-badge' }, { assert: true, budgetMs: 10000 })
  }
}
