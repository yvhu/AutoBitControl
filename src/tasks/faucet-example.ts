import { faker } from '@faker-js/faker'
import { SiteTask, type TaskContext, type TaskMeta } from './base'

// 测试网水龙头领水参考实现（新范式）：状态判断 → 数据源邮箱（faker 兜底）→ 领取 → 断言成功。
// 不连钱包：无 login 声明。
export class FaucetExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-example',
    name: '示例领水',
    group: { key: 'example', name: '示例' },
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭，调试时打开面板开关或用 task:run；水龙头一般每 24h 限领一次；邮箱优先取数据源「邮箱」列（config/accounts.xlsx，无则 faker 随机）',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: false,
    wallet: 'metamask',
    timeoutSec: 240,
    retry: { max: 1, backoffSec: 300 },
    concurrency: 4,
  }

  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page
    // 已领过 → 直接成功
    if (await page.getByText('已领取').count() > 0) return
    // 维护中 → 抛错进失败流程（面板可看截图/日志）
    if (await page.getByText('维护中').count() > 0) throw new Error('水龙头维护中')
    // 邮箱：数据源优先、faker 兜底
    const email = ctx.accountRow?.['邮箱'] || faker.internet.email()
    await page.locator('input[name="email"]').fill(email)
    // 领取 + 断言成功文案
    await page.locator('#claim-btn').click()
    await page.locator('.success-toast').waitFor({ state: 'visible', timeout: 10000 })
    await ctx.safeScreenshot('faucet-success')
  }
}
