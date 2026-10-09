import { faker } from '@faker-js/faker'
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

// 铸币参考实现（新范式）：钱包登录声明 → 多步骤表单 → 提交后等钱包确认 → 断言链上结果。
export class MintExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'mint-example',
    name: '示例铸币',
    group: { key: 'example', name: '示例' },
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭；多步骤表单站点常见"下一步"按钮无 loading 提示',
    category: 'mint',
    lastUpdated: '2026-10-09',
    enabled: false,
    wallet: 'petra',
    timeoutSec: 300,
    retry: { max: 1, backoffSec: 600 },
    concurrency: 4,
  }

  login: LoginSpec = {
    loggedIn: { text: '连接钱包' },
    loggedOut: '连接钱包',
    connect: 'button:has-text("连接钱包")',
    entry: { kind: 'direct' },
  }

  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page
    const tokenName = faker.word.words(2)
    const tokenSymbol = tokenName.replace(/[aeiou]/gi, '').slice(0, 4).toUpperCase()
    // 第一步：代币名称与符号
    await page.locator('input[name="name"]').fill(tokenName)
    await page.locator('input[name="symbol"]').fill(tokenSymbol)
    // 多步骤：点"下一步"后等第二步元素出现（用等待代替固定 sleep）
    await page.locator('#step-next').click()
    await page.locator('#step-2').waitFor({ state: 'visible', timeout: 10000 })
    // 第二步：描述与数量
    await page.locator('textarea[name="description"]').fill(faker.lorem.sentence())
    await page.locator('input[name="amount"]').fill(String(faker.number.int({ min: 1, max: 100 })))
    // 提交（站点随后唤起钱包交易确认弹窗）
    await page.locator('#mint-submit').click()
    await ctx.wallet.confirmTx({ reclick: { selector: '#mint-submit', afterMs: 8000 } })
    // 断言链上结果提示
    await page.locator('.tx-success').waitFor({ state: 'visible', timeout: 30000 })
    await ctx.safeScreenshot('mint-success')
  }
}
