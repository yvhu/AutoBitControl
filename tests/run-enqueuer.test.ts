import { describe, it, expect, vi } from 'vitest'
import { createRunEnqueuer } from '../src/app'
import { WindowPoolScheduler } from '../src/engine/window-pool'

/** 只构造装配用到的配置字段，其余用 never 兜底（不启动调度器） */
function makeCfg(): never {
  return {
    execution: {
      windowPool: {
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
        probeEnabled: true,
        backoffSec: [30, 60, 120, 300, 600],
      },
    },
  } as never
}

function makeDeps() {
  const runner = { runWindowTasks: vi.fn(), closePoolWindow: vi.fn() }
  const createPoolRunner = vi.fn(() => runner as never)
  const deps = {
    cfg: makeCfg(),
    db: {} as never,
    logger: {} as never,
    taskKeys: new Set(['t1']),
    bitbrowser: {} as never,
    createPoolRunner,
  }
  return { deps, runner, createPoolRunner }
}

describe('createRunEnqueuer', () => {
  it('始终使用 WindowPoolScheduler 与独立 pool 执行器', () => {
    const { deps, runner, createPoolRunner } = makeDeps()
    const enqueuer = createRunEnqueuer(deps)
    expect(enqueuer).toBeInstanceOf(WindowPoolScheduler)
    expect(createPoolRunner).toHaveBeenCalledTimes(1)
    expect(enqueuer.getStatus().maxOpenWindows).toBe(4)
    expect(runner.runWindowTasks).not.toHaveBeenCalled()
  })
})
