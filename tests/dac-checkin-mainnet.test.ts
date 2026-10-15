/**
 * DacCheckinMainnetTask 占位骨架单测：断言 meta 基础信息与「未实现」占位行为
 * 实现真机逻辑后补充签到/登录态/幂等用例
 */
import { describe, it, expect } from 'vitest'
import { DacCheckinMainnetTask } from '../src/tasks/dac-checkin-mainnet'
import { TaskContext } from '../src/tasks/base'

function makeCtx(): TaskContext {
  return new TaskContext({
    page: {} as never,
    task: new DacCheckinMainnetTask(),
    profile: { id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
    cfg: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    artifactsDir: '',
    walletPasswords: {},
  })
}

describe('DacCheckinMainnetTask 占位骨架', () => {
  it('meta：key/分类/钱包正确且默认关闭（占位）', () => {
    const t = new DacCheckinMainnetTask()
    expect(t.meta.key).toBe('dac-checkin-mainnet')
    expect(t.meta.category).toBe('checkin')
    expect(t.meta.wallet).toBe('metamask')
    expect(t.meta.enabled).toBe(false)
  })

  it('run：未实现前抛出占位错误', async () => {
    await expect(new DacCheckinMainnetTask().run(makeCtx())).rejects.toThrow('尚未实现')
  })
})
