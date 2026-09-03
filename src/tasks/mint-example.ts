import { faker } from '@faker-js/faker'
import { SiteTask, TaskContext, type TaskMeta } from './base'

// 铸币参考实现（多步骤表单 + 钱包确认弹窗）：
// 钱包登录 → 第一步填代币信息 → 第二步填数量/描述 → 提交 → 钱包弹窗确认 → 断言链上结果提示
export class MintExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'mint-example',
    name: '示例铸币',
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭，调试时打开面板开关或用 task:run；多步骤表单站点常见"下一步"按钮无 loading 提示',
    category: 'mint',
    lastUpdated: '2026-08-28',
    // 默认停用：示例任务不参与日常执行，需调试时在面板打开开关或直接用 task:run 脚本
    enabled: false,
    wallet: 'petra', // 该站点用 Petra 钱包
    timeoutSec: 300,
    retry: { max: 1, backoffSec: 600 },
    captcha: { auto: true, maxCost: 3000 },
    concurrency: 4,
  }

  async run(ctx: TaskContext): Promise<void> {
    await ctx.goto()
    await ctx.loginByWallet()
    // faker 生成代币信息：word 组合做名称、去元音做符号
    const tokenName = faker.word.words(2)
    const tokenSymbol = tokenName.replace(/[aeiou]/gi, '').slice(0, 4).toUpperCase()
    // 第一步：代币名称与符号
    await ctx.typeInto('input[name="name"]', tokenName)
    await ctx.typeInto('input[name="symbol"]', tokenSymbol)
    // 多步骤表单：点击"下一步"后等待第二步元素出现（用 assertVisible 等待而非固定 sleep）
    await ctx.clickCheckin('#step-next', { assert: '#step-2' })
    // 第二步：描述与数量
    await ctx.typeInto('textarea[name="description"]', faker.lorem.sentence())
    await ctx.typeInto('input[name="amount"]', String(faker.number.int({ min: 1, max: 100 })))
    // 提交：站点会唤起钱包弹窗；框架自动等待弹窗并点确认（密码已按钱包类型配置）
    await ctx.clickCheckin('#mint-submit')
    // 断言链上结果提示：等待"交易已提交/成功"文案，超时则任务失败进入重试
    await ctx.assertVisible('.tx-success', 30000)
    await ctx.screenshot('mint-success')
  }
}
