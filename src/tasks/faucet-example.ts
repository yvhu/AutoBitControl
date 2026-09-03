import { faker } from '@faker-js/faker'
import { SiteTask, TaskContext, type TaskMeta } from './base'

// 测试网水龙头领水参考实现：
// 打开页面 → 状态判断（已领过/可领/维护中）→ 数据源邮箱（faker 兜底）→ 验证码 → 领取 → 断言成功
export class FaucetExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-example',
    name: '示例领水',
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭，调试时打开面板开关或用 task:run；水龙头一般每 24h 限领一次；邮箱优先取数据源「邮箱」列（config/accounts.xlsx，无则 faker 随机）',
    category: 'faucet',
    lastUpdated: '2026-08-28',
    // 默认停用：示例任务不参与日常执行，需调试时在面板打开开关或直接用 task:run 脚本
    enabled: false,
    wallet: 'metamask',
    timeoutSec: 240,
    retry: { max: 1, backoffSec: 300 },
    captcha: { auto: true, maxCost: 1500 },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    await ctx.goto()
    // 状态判断：先看是否已领过（出现"已领取"文案直接成功返回）
    if (await ctx.textPresent('已领取')) return
    // 维护中直接失败并带上原因，跑失败后去面板看截图/日志
    if (await ctx.textPresent('维护中')) throw new Error('水龙头维护中')
    // 邮箱：数据源优先（每个窗口在 Excel 里预先领到自己的账号），数据源未配该窗口/该列时 faker 兜底
    const email = ctx.accountRow?.['邮箱'] || faker.internet.email()
    // 拟人输入（逐键延迟 + 少量错键回删），选择器换成站点真实输入框
    await ctx.typeInto('input[name="email"]', email)
    // 显式处理验证码：solveCaptcha 在调用的位置检测并打码，
    // 适用于"点击领取时才出现验证码"的站点
    await ctx.solveCaptcha()
    // 点击领取并断言成功文案（出现余额变化或成功提示）
    await ctx.clickCheckin('#claim-btn', { assert: '.success-toast' })
    // 成功截图留档（自动存档到 data/screenshots/<日期>/<窗口>/<任务>/）
    await ctx.screenshot('faucet-success')
  }
}
