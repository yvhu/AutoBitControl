import { describe, it, expect, vi } from 'vitest'
import { CoalescingEnqueuer } from '../src/engine/queue'
import type { ProfileRow } from '../src/infrastructure/db'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function makeProfile(id: number): ProfileRow {
  return { id, bitbrowserId: `b${id}`, name: `${id}`, enabled: 1, circuitBreakerCount: 0 }
}

/** 可控 runner：runWindowTasks 挂起直到手动 resolve，模拟窗口会话运行中 */
function makeRunner() {
  let release!: () => void
  const started = vi.fn()
  const gate = new Promise<void>((r) => (release = r))
  const runner = {
    runWindowTasks: vi.fn(() => {
      started()
      return gate
    }),
  }
  return { runner, started, release: () => release() }
}

describe('CoalescingEnqueuer.anyRunning', () => {
  it('无会话时 false', () => {
    const { runner } = makeRunner()
    const q = new CoalescingEnqueuer(runner, logger as never, () => 1, 0)
    expect(q.anyRunning()).toBe(false)
  })

  it('会话运行中 true，结束后 false', async () => {
    const { runner, started, release } = makeRunner()
    const q = new CoalescingEnqueuer(runner, logger as never, () => 1, 0)
    q.enqueue(makeProfile(1), 'demo', { immediate: true })
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    expect(q.anyRunning()).toBe(true)
    release()
    await vi.waitFor(() => expect(q.anyRunning()).toBe(false))
  })
})
