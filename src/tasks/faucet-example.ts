/**
 * 示例领水任务（faucet-example）：测试网水龙头领水参考实现（新范式）
 * 站点：占位示例水龙头；url 为占位地址、开关默认关闭，仅作调试与复制起点
 * 执行流程：打开任务页（占位 url）→ action 判已领（幂等）→ 判维护中（转失败）
 *          → 取邮箱（数据源优先、faker 兜底）→ 填邮箱 → 点领取 → 断言成功文案 → 截图
 * 设计：不连钱包，故无 login 声明；成功必须显式断言成功 toast
 * 时间预算：timeoutSec 240s（单任务整体超时）、retry.max 1 次 / 退避 300s、concurrency 4
 */
import { faker } from '@faker-js/faker'
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, click, fill, hasText, waitFor, takeScreenshot } from '../api'

export class FaucetExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-example',
    name: '示例领水',
    group: { key: 'example', name: '示例' },
    url: 'https://example.com/',
    sourceUrl: '',
    note: '示例任务：url 为占位地址且开关默认关闭，调试时打开面板开关或用 task:run；水龙头一般每 24h 限领一次；邮箱优先取数据源「邮箱」列（config/accounts.xlsx，无则 faker 随机）',
    category: 'faucet', // 任务类别：领水
    lastUpdated: '2026-10-09',
    enabled: false,
    wallet: 'metamask',
    timeoutSec: 240, // 单任务整体超时秒数
    retry: { max: 1, backoffSec: 300 }, // 失败最多再试 1 次，退避 300s
    concurrency: 4,
  }

  /**
   * 站点动作：领水（不连钱包，无登录步骤）。
   * @param ctx 任务上下文（page/log/accountRow 等运行时数据）
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    // 已领过 → 直接成功（幂等：24h 限领，重跑不算失败）
    if (await hasText(ctx, '已领取')) return
    // 维护中 → 抛错进失败流程（面板可看截图/日志）
    if (await hasText(ctx, '维护中')) throw new Error('水龙头维护中')
    // 邮箱：数据源「邮箱」列优先、无则 faker 随机兜底
    const email = ctx.accountRow?.['邮箱'] || faker.internet.email()
    await fill(ctx, 'input[name="email"]', email)
    // 领取 + 断言成功文案（等不到即抛错，走失败流程）
    await click(ctx, '#claim-btn')
    await waitFor(ctx, { selector: '.success-toast' }, { assert: true, budgetMs: 10000 })
    await takeScreenshot(ctx, 'faucet-success')
  }
}
