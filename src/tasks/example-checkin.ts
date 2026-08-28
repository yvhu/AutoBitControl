import { SiteTask, TaskContext, type TaskMeta } from './base'

// 标准每日签到参考实现：登录(钱包) → 点击签到 → 断言成功
// 新增任务从这里复制改起：先跑通流程，再逐步替换选择器
export class ExampleCheckinTask extends SiteTask {
  meta: TaskMeta = {
    // key 全局唯一，API 与数据库都用它标识任务
    key: 'example-checkin',
    // 面板任务页显示名
    name: '示例签到',
    // 站点入口页 URL（任务从这里开始）
    url: '',
    // 信息来源页：选择器是从哪个页面确认的，站点改版时回这里重查
    sourceUrl: '',
    // 备注：记录站点的坑与特殊逻辑，面板任务页直接可见
    note: '示例任务，未配置真实 url，仅手动触发演示',
    // 分类：checkin/faucet/mint/other，面板显示对应颜色徽章
    category: 'checkin',
    // 最后更新日期，提醒自己多久没核对过这个站点
    lastUpdated: '2026-08-28',
    // 每日错峰执行：9 点到 11 点之间随机取一个时间点
    schedule: { stagger: ['09:00', '11:00'] },
    // 本任务用 MetaMask 钱包登录，loginByWallet 会按此查找适配器
    wallet: 'metamask',
    // 单次运行超时（秒）
    timeoutSec: 180,
    // 失败重试 2 次，每次间隔 600 秒
    retry: { max: 2, backoffSec: 600 },
    // 验证码自动处理，单任务打码费用上限 1500 点（¥1.5）
    captcha: { auto: true, maxCost: 1500 },
  }

  async run(ctx: TaskContext): Promise<void> {
    // goto：打开 url，失败自动重试 3 次（2s-5s 退避）
    await ctx.goto()
    // loginByWallet：等站点唤起钱包弹窗 → 自动解锁（密码按窗口配置）→ 点连接
    await ctx.loginByWallet()
    // clickCheckin：拟人点击签到按钮，并断言成功后出现的元素
    // 选择器查找：DevTools 右键按钮 → Copy → Copy selector
    // 断言元素选成功后才出现的标志（徽章/文案），宁严勿松
    await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })
    // 更多状态判断示例见 faucet-example.ts 与 API 手册第 8 章
  }
}
