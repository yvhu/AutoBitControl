/**
 * 串行队列（engine 层）：同一时刻只执行一个异步操作，可选操作间冷却；用于比特开/关窗 API
 * 依赖方向：无外部依赖，被 app 装配注入 WindowRunner
 *
 * 冷却只约束开窗：默认 cooldown=true；关窗等其它操作传 { cooldown: false }，
 * 不等待开窗冷却、也不刷新冷却起点（两次开窗最小间隔仍按上一次开窗结束时间计算）。
 * 所有操作无论是否冷却都保持同一 FIFO 串行链。
 */
export interface SerialQueueRunOptions {
  /** 是否参与开窗冷却（等待上次开窗结束后的剩余冷却，并在结束后刷新冷却起点）；默认 true */
  cooldown?: boolean
}

export class SerialQueue {
  private chain: Promise<void> = Promise.resolve()
  private lastFinishedAt = 0

  constructor(private readonly cooldownMs = 0) {}

  async run<T>(fn: () => Promise<T>, opts: SerialQueueRunOptions = {}): Promise<T> {
    const cooldown = opts.cooldown ?? true
    const previous = this.chain
    let release!: () => void
    this.chain = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      if (cooldown) {
        const wait = this.lastFinishedAt + this.cooldownMs - Date.now()
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      }
      return await fn()
    } finally {
      if (cooldown) this.lastFinishedAt = Date.now()
      release()
    }
  }
}
