import { describe, it, expect } from 'vitest'
import { GlobalHealthGate } from '../src/engine/global-health'

describe('GlobalHealthGate', () => {
  it('不同窗口环境失败达到阈值后暂停；冷却后进入 probing，成功恢复', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 3, backoffSec: [30, 60], probeEnabled: true })
    expect(g.canOpen(0)).toBe(true)
    g.recordEnvironmentFailure('w1', 1000)
    g.recordEnvironmentFailure('w2', 2000)
    expect(g.canOpen(3000)).toBe(true)
    expect(g.recordEnvironmentFailure('w3', 3000)).toBe('paused')
    expect(g.canOpen(10_000)).toBe(false)
    expect(g.canOpen(33_001)).toBe(true) // 进入 probing，允许一次探测
    expect(g.state).toBe('probing')
    g.recordProbeSuccess()
    expect(g.state).toBe('normal')
    expect(g.canOpen(40_000)).toBe(true)
  })

  it('同一窗口重复失败不重复计数；探测失败按退避下一次', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 2, backoffSec: [30, 60], probeEnabled: true })
    g.recordEnvironmentFailure('w1', 0)
    g.recordEnvironmentFailure('w1', 1000)
    expect(g.canOpen(2000)).toBe(true)
    g.recordEnvironmentFailure('w2', 2000)
    expect(g.state).toBe('paused')
    expect(g.canOpen(32_001)).toBe(true)
    g.recordProbeFailure(32_001)
    expect(g.state).toBe('paused')
    expect(g.canOpen(32_001 + 60_000)).toBe(true)
  })

  it('超出时间窗的旧失败不计入阈值', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 2, backoffSec: [30], probeEnabled: true })
    g.recordEnvironmentFailure('w1', 0)
    expect(g.recordEnvironmentFailure('w2', 400_000)).toBe('normal')
    expect(g.canOpen(400_001)).toBe(true)
  })

  it('退避级别封顶在最后一档', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 1, backoffSec: [30, 60], probeEnabled: true })
    g.recordEnvironmentFailure('w1', 0)
    expect(g.nextProbeMs).toBe(30_000)
    expect(g.canOpen(30_001)).toBe(true)
    g.recordProbeFailure(30_001)
    expect(g.nextProbeMs).toBe(90_001)
    expect(g.canOpen(90_001)).toBe(true)
    g.recordProbeFailure(90_001)
    expect(g.nextProbeMs).toBe(150_001)
  })

  it('关闭探测后持续暂停，不再自动放行', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 1, backoffSec: [30], probeEnabled: false })
    g.recordEnvironmentFailure('w1', 0)
    expect(g.state).toBe('paused')
    expect(g.canOpen(10_000_000)).toBe(false)
    expect(g.state).toBe('paused')
  })

  it('进入 probing 后清空 nextProbeMs；探测结果回报前不再放行', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 1, backoffSec: [30, 60], probeEnabled: true })
    g.recordEnvironmentFailure('w1', 0)
    expect(g.canOpen(30_000)).toBe(true)
    expect(g.state).toBe('probing')
    expect(g.nextProbeMs).toBeNull()
    expect(g.canOpen(30_000)).toBe(false)
    expect(g.canOpen(40_000)).toBe(false)
    g.recordProbeFailure(40_000)
    expect(g.state).toBe('paused')
    expect(g.nextProbeMs).toBe(100_000)
  })

  it('非有限时间戳回退到当前时间，不会永久暂停', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 1, backoffSec: [30], probeEnabled: true })
    g.recordEnvironmentFailure('w1', Number.NaN)
    expect(g.state).toBe('paused')
    expect(g.nextProbeMs).not.toBeNull()
    expect(Number.isFinite(g.nextProbeMs as number)).toBe(true)
    expect(g.nextProbeMs).toBeGreaterThan(Date.now())
    expect(g.canOpen(Number.NaN)).toBe(false)
    g.recordProbeFailure(Number.POSITIVE_INFINITY)
    expect(Number.isFinite(g.nextProbeMs as number)).toBe(true)
    expect(g.canOpen(Date.now() + 31_000)).toBe(true)
  })

  it('backoffSec 为空时使用 30 秒默认值', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 1, backoffSec: [], probeEnabled: true })
    g.recordEnvironmentFailure('w1', 0)
    expect(g.nextProbeMs).toBe(30_000)
    expect(g.canOpen(30_000)).toBe(true)
    g.recordProbeFailure(30_000)
    expect(g.nextProbeMs).toBe(60_000)
    expect(g.canOpen(60_000)).toBe(true)
    g.recordProbeFailure(60_000)
    expect(g.nextProbeMs).toBe(90_000)
  })

  it('构造后修改传入的 backoffSec 不影响退避', () => {
    const backoffSec = [30, 60]
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 1, backoffSec, probeEnabled: true })
    backoffSec[0] = 9999
    backoffSec[1] = 9999
    backoffSec.push(9999)
    g.recordEnvironmentFailure('w1', 0)
    expect(g.nextProbeMs).toBe(30_000)
    expect(g.canOpen(30_000)).toBe(true)
    g.recordProbeFailure(30_000)
    expect(g.nextProbeMs).toBe(90_000)
  })

  it('recordGlobalFailure 立即暂停：首次用首档退避，重复失败升级', () => {
    const g = new GlobalHealthGate({ windowSec: 300, threshold: 3, backoffSec: [30, 60], probeEnabled: true })
    expect(g.recordGlobalFailure(1000)).toBe('paused')
    expect(g.nextProbeMs).toBe(31_000)
    expect(g.canOpen(31_000)).toBe(true)
    g.recordProbeFailure(31_000)
    g.recordGlobalFailure(32_000)
    expect(g.nextProbeMs).toBe(92_000)
  })
})
