/**
 * 示例铸币任务（mint-example）：铸币（mint）参考实现（新范式）
 * 站点：占位示例铸币站；url 为空、开关默认关闭，仅作调试与复制起点
 * 执行流程：打开任务页（url 为空则跳过）→ 声明式登录（Petra）→ action 填名称/符号
 *          → 下一步 → 填描述/数量 → 提交 → 等钱包确认交易 → 断言链上成功提示 → 截图
 * 设计：钱包登录声明 login；多步骤表单以「等下一步元素出现」代替固定 sleep
 * 时间预算：timeoutSec 300s（单任务整体超时）、retry.max 1 次 / 退避 600s、concurrency 4
 */
import { faker } from '@faker-js/faker'
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

export class MintExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'mint-example',
    name: '示例铸币',
    group: { key: 'example', name: '示例' },
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭；多步骤表单站点常见"下一步"按钮无 loading 提示',
    category: 'mint', // 任务类别：铸币
    lastUpdated: '2026-10-09',
    enabled: false,
    wallet: 'petra', // 示例使用 Petra 钱包
    timeoutSec: 300, // 单任务整体超时秒数（铸币含钱包确认，预留较久）
    retry: { max: 1, backoffSec: 600 }, // 失败最多再试 1 次，退避 600s
    concurrency: 4,
  }

  // 登录声明：默认 run 会先跑 ensureLoggedIn（竞速判登录态 → 点连接 → 签名/确认 → 等登录完成）
  login: LoginSpec = {
    loggedIn: { text: '连接钱包' }, // 占位：换成站点已登录标志
    loggedOut: '连接钱包', // 占位：换成站点未登录标志
    connect: 'button:has-text("连接钱包")', // 占位：换成站点连接入口
    entry: { kind: 'direct' }, // 直连：点连接即唤起钱包扩展
  }

  /**
   * 站点动作：分两步填写并铸币，提交后等待钱包确认与链上结果。
   * @param ctx 任务上下文，提供 page、wallet（confirmTx）、safeScreenshot 等
   */
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
    // 等钱包确认交易；reclick 用于提交后按钮被重置时补点（afterMs 后再点一次）
    await ctx.wallet.confirmTx({ reclick: { selector: '#mint-submit', afterMs: 8000 } })
    // 断言链上结果提示（宁严勿松）
    await page.locator('.tx-success').waitFor({ state: 'visible', timeout: 30000 })
    await ctx.safeScreenshot('mint-success')
  }
}
