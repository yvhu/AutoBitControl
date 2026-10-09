import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

// 标准每日签到参考实现（新范式）：登录声明 login → 站点动作 action，页面操作直调 patchright。
// 新增任务从这里复制改起：先跑通流程，再逐步替换选择器。
export class ExampleCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'example-checkin',
    name: '示例签到',
    group: { key: 'example', name: '示例' },
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭；调试时在面板任务页打开开关，或用 task:run 脚本直接跑（不受开关限制）',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: false,
    wallet: 'metamask',
    timeoutSec: 180,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  // 登录声明：默认 run 会先跑 ensureLoggedIn（竞速判登录态 → 点连接 → 签名/确认 → 等登录完成）
  login: LoginSpec = {
    loggedIn: { text: '已连接' },     // 占位：换成站点已登录标志（文案或 { selector }）
    loggedOut: '连接钱包',            // 占位：换成站点未登录标志
    connect: 'button:has-text("连接钱包")', // 占位：换成站点连接入口
    entry: { kind: 'direct' },
  }

  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page // ← patchright；点击/填写/等待都用原生 API
    // 已签到直接成功返回
    if (await page.getByText('已签到').count() > 0) return
    // 点签到按钮并断言成功标志（宁严勿松）
    await page.locator('#checkin-btn').click()
    await page.locator('#checked-badge').waitFor({ state: 'visible', timeout: 10000 })
  }
}
