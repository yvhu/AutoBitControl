/**
 * SerialQueue 单测：FIFO 串行、操作间冷却、异常不阻塞后续
 */
import { describe, expect, it } from 'vitest'
import { SerialQueue } from '../src/engine/serial-queue'

describe('SerialQueue', () => {
  it('同一时刻只执行一个任务，且按 FIFO', async () => {
    const q = new SerialQueue(0)
    const order: string[] = []
    let running = 0
    let maxRunning = 0
    await Promise.all([
      q.run(async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push('a')
        running--
      }),
      q.run(async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        order.push('b')
        running--
      }),
    ])
    expect(order).toEqual(['a', 'b'])
    expect(maxRunning).toBe(1)
  })

  it('冷却从上一次操作结束后开始计算', async () => {
    const q = new SerialQueue(40)
    let firstFinishedAt = 0
    let secondStartedAt = 0
    await q.run(async () => {
      firstFinishedAt = Date.now()
    })
    await q.run(async () => {
      secondStartedAt = Date.now()
    })
    expect(secondStartedAt - firstFinishedAt).toBeGreaterThanOrEqual(30)
  })

  it('关闭操作不等待开窗冷却', async () => {
    const q = new SerialQueue(500)
    let openFinishedAt = 0
    let closeStartedAt = 0
    await q.run(async () => {
      openFinishedAt = Date.now()
    })
    await q.run(async () => {
      closeStartedAt = Date.now()
    }, { cooldown: false })
    expect(closeStartedAt - openFinishedAt).toBeLessThan(100)
  })

  it('关闭操作不刷新开窗冷却起点', async () => {
    const q = new SerialQueue(150)
    let firstOpenFinishedAt = 0
    let secondOpenStartedAt = 0
    await q.run(async () => {
      firstOpenFinishedAt = Date.now()
    })
    await q.run(async () => {}, { cooldown: false })
    await q.run(async () => {
      secondOpenStartedAt = Date.now()
    })
    expect(secondOpenStartedAt - firstOpenFinishedAt).toBeGreaterThanOrEqual(140)
    // 若关闭也刷新冷却，第二次开窗会被多等一轮（≈300ms）
    expect(secondOpenStartedAt - firstOpenFinishedAt).toBeLessThan(280)
  })

  it('关闭操作抛错同样释放队列，后续操作不等待冷却', async () => {
    const q = new SerialQueue(500)
    await expect(q.run(async () => {
      throw new Error('close boom')
    }, { cooldown: false })).rejects.toThrow('close boom')
    const start = Date.now()
    await expect(q.run(async () => 'ok', { cooldown: false })).resolves.toBe('ok')
    expect(Date.now() - start).toBeLessThan(100)
  })
})
