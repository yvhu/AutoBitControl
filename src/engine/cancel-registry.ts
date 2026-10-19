/**
 * 取消标记注册表（engine 层）：按 (窗口, 任务) 或整窗口会话记录「已请求停止」，供 runner / 重试回调消费
 * 依赖方向：无依赖，被 window-runner / task-stopper / app 装配使用
 * 设计思路：进程内内存态（重启即清空）；request 置位，消费方 isCancelled 判定、clear 清理；
 *           会话级标记用于停止整个窗口时，避免其余任务的 Target closed 被误判为环境失败
 */
export class CancelRegistry {
  private readonly keys = new Set<string>()
  private readonly sessions = new Set<number>()

  private static key(profileId: number, taskKey: string): string {
    return `${profileId}:${taskKey}`
  }

  /** 请求停止某窗口某任务（置位） */
  request(profileId: number, taskKey: string): void {
    this.keys.add(CancelRegistry.key(profileId, taskKey))
  }

  /** 该窗口该任务是否已请求停止 */
  isCancelled(profileId: number, taskKey: string): boolean {
    return this.keys.has(CancelRegistry.key(profileId, taskKey))
  }

  /** 消费 / 清理标记（会话跳过、任务中止结算、重试跳过时调用） */
  clear(profileId: number, taskKey: string): void {
    this.keys.delete(CancelRegistry.key(profileId, taskKey))
  }

  /** 请求停止某窗口的整个会话（停止任务会关窗，同会话其余任务应视为手动停止） */
  requestSession(profileId: number): void {
    this.sessions.add(profileId)
  }

  /** 该窗口的会话是否已请求停止 */
  isSessionCancelled(profileId: number): boolean {
    return this.sessions.has(profileId)
  }

  /** 清理会话级标记（会话结束 / 启动前消费时调用，避免泄漏到下一次会话） */
  clearSession(profileId: number): void {
    this.sessions.delete(profileId)
  }
}
