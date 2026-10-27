import { describe, it, expect } from 'vitest'
import { GlobalHealthGate } from '../src/engine/global-health'

const base = { backoffSec: [30, 60], probeEnabled: true }

describe('GlobalHealthGate', () => {
  it('比特 API 全局失败立即暂停；冷却后进入 probing，探测成功恢复', () => {
    const g = new GlobalHealthGate({ ...base })
    expect(g.canOpen(0)).toBe(true)
    expect(g.recordGlobalFailure(1000)).toBe('paused')
    expect(g.canOpen(10_000)).toBe(false)
    expect(g.canOpen(31_000)).toBe(true) // 进入 probing，允许一次探测
    expect(g.state).toBe('probing')
    g.recordProbeSuccess()
    expect(g.state).toBe('normal')
    expect(g.canOpen(40_000)).toBe(true)
  })

  it('重复全局失败按退避级别递增并封顶', () => {
    const g = new GlobalHealthGate({ ...base })
    g.recordGlobalFailure(1000)
    expect(g.nextProbeMs).toBe(31_000)
    g.recordGlobalFailure(2000)
    expect(g.nextProbeMs).toBe(62_000)
    g.recordGlobalFailure(3000)
    expect(g.nextProbeMs).toBe(63_000) // 封顶在 60s 档
  })

  it('关闭探测后持续暂停，不再自动放行', () => {
    const g = new GlobalHealthGate({ backoffSec: [30], probeEnabled: false })
    g.recordGlobalFailure(0)
    expect(g.state).toBe('paused')
    expect(g.canOpen(10_000_000)).toBe(false)
    expect(g.state).toBe('paused')
  })

  it('进入 probing 后清空 nextProbeMs；探测结果回报前不再放行', () => {
    const g = new GlobalHealthGate({ ...base })
    g.recordGlobalFailure(0)
    expect(g.canOpen(30_000)).toBe(true)
    expect(g.state).toBe('probing')
    expect(g.nextProbeMs).toBeNull()
    expect(g.canOpen(30_000)).toBe(false)
    expect(g.canOpen(40_000)).toBe(false)
    g.recordProbeSuccess()
    expect(g.state).toBe('normal')
  })

  it('非有限时间戳回退到当前时间，不会永久暂停', () => {
    const g = new GlobalHealthGate({ backoffSec: [30], probeEnabled: true })
    g.recordGlobalFailure(Number.NaN)
    expect(g.state).toBe('paused')
    expect(g.nextProbeMs).not.toBeNull()
    expect(Number.isFinite(g.nextProbeMs as number)).toBe(true)
    expect(g.nextProbeMs).toBeGreaterThan(Date.now())
    expect(g.canOpen(Number.NaN)).toBe(false)
  })

  it('backoffSec 为空时使用 30 秒默认值', () => {
    const g = new GlobalHealthGate({ backoffSec: [], probeEnabled: true })
    g.recordGlobalFailure(0)
    expect(g.nextProbeMs).toBe(30_000)
    expect(g.canOpen(30_000)).toBe(true)
    g.recordProbeSuccess()
    g.recordGlobalFailure(30_000)
    expect(g.nextProbeMs).toBe(60_000)
  })

  it('构造后修改传入的 backoffSec 不影响退避', () => {
    const backoffSec = [30, 60]
    const g = new GlobalHealthGate({ backoffSec, probeEnabled: true })
    backoffSec[0] = 9999
    backoffSec[1] = 9999
    backoffSec.push(9999)
    g.recordGlobalFailure(0)
    expect(g.nextProbeMs).toBe(30_000)
    expect(g.canOpen(30_000)).toBe(true)
    g.recordGlobalFailure(30_000)
    expect(g.nextProbeMs).toBe(90_000)
  })

  it('不再提供单窗口环境失败聚合入口（代理失败只走窗口级熔断）', () => {
    const g = new GlobalHealthGate({ ...base })
    expect((g as unknown as Record<string, unknown>).recordEnvironmentFailure).toBeUndefined()
  })
})
