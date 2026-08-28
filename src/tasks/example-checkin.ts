import { SiteTask, TaskContext, type TaskMeta } from './base'

export class ExampleCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'example-checkin',
    name: '示例签到',
    url: '',
    schedule: { stagger: ['09:00', '11:00'] },
    wallet: 'metamask',
    captcha: { auto: true },
  }

  async run(ctx: TaskContext): Promise<void> {
    await ctx.goto()
    await ctx.loginByWallet()
    await ctx.clickCheckin('#checkin-btn', { assert: '#checked-badge' })
  }
}
