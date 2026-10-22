import { describe, it, expect, vi } from 'vitest'
import { createRunEnqueuer } from '../src/app'
import { CoalescingEnqueuer } from '../src/engine/queue'
import { WindowPoolScheduler } from '../src/engine/window-pool'

/** 只构造开关判断用到的配置字段，其余用 never 兜底（不启动调度器） */
function makeCfg(enabled: boolean): never {
  return {
    execution: {
      maxConcurrentWindows: 4,
      windowPool: {
        enabled,
        maxOpenWindows: 4,
        memoryReserveMb: 100,
        perWindowMb: 1024,
        criticalFreeMb: 1024,
        resumeFreeMb: 2048,
        checkIntervalMs: 5000,
        openCooldownMs: 10000,
        idleCloseSec: 180,
        windowMaxTasks: 3,
        windowMaxLifetimeSec: 600,
        cohortMaxSec: 1800,
      },
      health: {
        bitbrowserProbeMs: 30000,
        globalEnvFailureWindowSec: 300,
        globalEnvFailureThreshold: 3,
        probeEnabled: true,
        backoffSec: [30, 60, 120, 300, 600],
      },
    },
  } as never
}

function makeDeps(enabled: boolean) {
  const runner = { runWindowTasks: vi.fn(), closePoolWindow: vi.fn() }
  const createPoolRunner = vi.fn(() => runner as never)
  const deps = {
    cfg: makeCfg(enabled),
    db: {} as never,
    logger: {} as never,
    limits: new Map([['t1', 1]]),
    bitbrowser: {} as never,
    runner: runner as never,
    createPoolRunner,
  }
  return { deps, runner, createPoolRunner }
}

describe('createRunEnqueuer 特性开关', () => {
  it('windowPool.enabled=false 时使用旧 CoalescingEnqueuer，且不创建 pool 执行器', () => {
    const { deps, createPoolRunner } = makeDeps(false)
    const enqueuer = createRunEnqueuer(deps)
    expect(enqueuer).toBeInstanceOf(CoalescingEnqueuer)
    expect(createPoolRunner).not.toHaveBeenCalled()
  })

  it('windowPool.enabled=true 时使用 WindowPoolScheduler 与独立 pool 执行器', () => {
    const { deps, runner, createPoolRunner } = makeDeps(true)
    const enqueuer = createRunEnqueuer(deps)
    expect(enqueuer).toBeInstanceOf(WindowPoolScheduler)
    expect(createPoolRunner).toHaveBeenCalledTimes(1)
    expect((enqueuer as WindowPoolScheduler).getStatus().maxOpenWindows).toBe(4)
    expect(runner.runWindowTasks).not.toHaveBeenCalled()
  })
})
