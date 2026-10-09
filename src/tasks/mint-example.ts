/**
 * 示例铸币任务（mint-example）：铸币（mint）参考实现（新范式）
 * 站点：占位示例铸币站；url 为空、开关默认关闭，仅作调试与复制起点
 * 执行流程：打开任务页（url 为空则跳过）→ 声明式登录（Petra）→ action 填名称/符号
 *          → 下一步 → 填描述/数量 → 提交 → 等钱包确认交易 → 断言链上成功提示 → 截图
 * 设计：run 内直接用 ../api 能力函数（openPage/loginWallet/click/fill/waitFor/confirmTransaction）
 * 时间预算：timeoutSec 300s（单任务整体超时）、retry.max 1 次 / 退避 600s、concurrency 4
 */
import { faker } from '@faker-js/faker'
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, loginWallet, click, fill, waitFor, confirmTransaction, takeScreenshot } from '../api'

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

  /**
   * 执行流程：打开任务页（url 为空则跳过）→ 声明式钱包登录 → 铸币动作。
   * @param ctx 任务上下文
   */
  async run(ctx: TaskContext): Promise<void> {
    if (this.meta.url) await openPage(ctx, this.meta.url, { closeOtherTabs: true })
    await loginWallet(ctx, {
      wallet: 'petra',
      scenario: 'direct',
      loggedIn: { text: '连接钱包' },
      loggedOut: '连接钱包',
      connect: 'button:has-text("连接钱包")',
    })
    await this.action(ctx)
  }

  /**
   * 站点动作：分两步填写并铸币，提交后等待钱包确认与链上结果。
   * @param ctx 任务上下文，提供 page/wallets/walletPasswords/walletSession/log 等
   */
  async action(ctx: TaskContext): Promise<void> {
    const tokenName = faker.word.words(2)
    const tokenSymbol = tokenName.replace(/[aeiou]/gi, '').slice(0, 4).toUpperCase()
    // 第一步：代币名称与符号
    await fill(ctx, 'input[name="name"]', tokenName)
    await fill(ctx, 'input[name="symbol"]', tokenSymbol)
    // 多步骤：点"下一步"后等第二步元素出现（用等待代替固定 sleep）
    await click(ctx, '#step-next')
    await waitFor(ctx, { selector: '#step-2' }, { budgetMs: 10000, assert: true })
    // 第二步：描述与数量
    await fill(ctx, 'textarea[name="description"]', faker.lorem.sentence())
    await fill(ctx, 'input[name="amount"]', String(faker.number.int({ min: 1, max: 100 })))
    // 提交（站点随后唤起钱包交易确认弹窗）
    await click(ctx, '#mint-submit')
    // 等钱包确认交易；reclick 用于提交后按钮被重置时补点（afterMs 后再点一次）
    await confirmTransaction(ctx, { reclick: { selector: '#mint-submit', afterMs: 8000 } })
    // 断言链上结果提示（宁严勿松）
    await waitFor(ctx, { selector: '.tx-success' }, { budgetMs: 30000, assert: true })
    await takeScreenshot(ctx, 'mint-success')
  }
}
