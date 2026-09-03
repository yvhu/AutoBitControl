# 任务级并发实现计划（去掉全局 concurrency）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉全局 `execution.concurrency`，改为任务级并发（`meta.concurrency`，缺省 4，portal-rhuna=2 其余 4），批量触发时滚动分批跑完所有启用窗口。

**Architecture:** `CoalescingEnqueuer` 从「p-queue 全局并发」改为「每任务额度（gates：concurrency/active/waiting FIFO）+ 同窗口合并保留」。额度满的窗口进 waiting，会话结束 `release` 滚动续跑；同窗口合并、followUp、stagger 错峰机制全部保留。

**Tech Stack:** TypeScript 严格模式、vitest、antd。spec：`docs/superpowers/specs/2026-09-03-task-level-concurrency-design.md`

## Global Constraints

- 中文注释/文档/commit message；无分号、单引号、2 空格缩进；camelCase 命名，文件 kebab-case
- `DEFAULT_TASK_CONCURRENCY = 4`（src/engine/task.ts 导出，app.ts 装配与 GET /tasks 兜底都引用它，单点维护）
- 任务级并发缺省 4；`portal-rhuna` = 2；`example-checkin`/`faucet-example`/`mint-example`/`inception-dachain` = 4
- 单窗口触发（看板行级/task:run）同样受额度限制：满了排队等释放
- `hasTaskInFlight` 判在途来源：pending + running + followUp + waiting 全部算
- 每任务改完必须 `npm run typecheck` 与 `npm test` 全绿（Task 5 起加 `npm run test:web`）
- 全局 `execution.concurrency` 彻底删除（config.ts/config.json/settings 接口与面板/p-queue 依赖），不留兜底上限

---

### Task 1: TaskMeta 加 concurrency 字段与缺省常量，5 个任务写值

**Files:**
- Modify: `src/engine/task.ts`
- Modify: `src/tasks/example-checkin.ts`
- Modify: `src/tasks/faucet-example.ts`
- Modify: `src/tasks/mint-example.ts`
- Modify: `src/tasks/inception-dachain.ts`
- Modify: `src/tasks/portal-rhuna.ts`

**Interfaces:**
- Consumes: 无
- Produces: `TaskMeta.concurrency?: number`；`DEFAULT_TASK_CONCURRENCY = 4`（Task 2/4 依赖）

- [ ] **Step 1: src/engine/task.ts 加字段与常量**

`src/engine/task.ts` 的 `TaskMeta` 接口 `captcha` 行后加：

```ts
  /** 任务级并发：同一时间最多几个窗口并行跑该任务；缺省 DEFAULT_TASK_CONCURRENCY（4）；批量触发时滚动分批跑完 */
  concurrency?: number
```

文件末尾（`TaskRef` 接口之后）加：

```ts
/** 任务级并发缺省值：meta.concurrency 未写时生效 */
export const DEFAULT_TASK_CONCURRENCY = 4
```

- [ ] **Step 2: 5 个任务文件写 concurrency**

每个任务 meta 的 `captcha` 行后加一行：
- `src/tasks/example-checkin.ts`、`src/tasks/faucet-example.ts`、`src/tasks/mint-example.ts`、`src/tasks/inception-dachain.ts` 加 `    concurrency: 4,`
- `src/tasks/portal-rhuna.ts` 加 `    concurrency: 2,`

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/engine/task.ts src/tasks/example-checkin.ts src/tasks/faucet-example.ts src/tasks/mint-example.ts src/tasks/inception-dachain.ts src/tasks/portal-rhuna.ts
git commit -m "feat: TaskMeta 增加任务级并发字段（缺省 4，portal-rhuna 2 其余 4）"
```

---

### Task 2: 重写 queue.ts（任务级额度调度）+ app.ts 装配

**Files:**
- Modify: `tests/queue.test.ts`（整体重写）
- Modify: `src/engine/queue.ts`（整体重写）
- Modify: `src/app.ts:13,181-182`

**Interfaces:**
- Consumes: `DEFAULT_TASK_CONCURRENCY`（Task 1）
- Produces: `CoalescingEnqueuer(runner, logger, taskConcurrencyOf, staggerMaxSec?)`；方法 `enqueue(profile, taskKey)`、`hasTaskInFlight(taskKey, profileId?)`；`TaskQueue` 类删除

- [ ] **Step 1: 重写 tests/queue.test.ts（先写失败测试）**

整个文件替换为：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoalescingEnqueuer } from '../src/engine/queue'

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never

function makeEnq(
  run: ReturnType<typeof vi.fn>,
  concurrencyOf: (key: string) => number = () => 4,
  staggerMaxSec = 0,
) {
  return new CoalescingEnqueuer({ runWindowTasks: run } as never, logger, concurrencyOf, staggerMaxSec)
}

const mk = (id: number, bb: string) => ({ id, bitbrowserId: bb, name: bb, enabled: 1, circuitBreakerCount: 0 })

const tick = () => new Promise<void>(r => setTimeout(r, 10))

describe('CoalescingEnqueuer 任务级并发', () => {
  it('并发额度内窗口立即执行，超额窗口等待释放后滚动续跑', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }, _taskKeys: string[]) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 2)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(3, 'bb-3'), 'task-a')
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    releases[1]()
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2][0].id).toBe(3)
    releases[2]()
    releases[3]()
    await tick()
  })

  it('任务额度相互独立：A 排队不影响 B 立即执行', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, (key) => (key === 'task-a' ? 1 : 4))
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(3, 'bb-3'), 'task-b')
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][1]).toEqual(['task-b'])
    releases[1]()
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2][0].id).toBe(2)
    releases[2]()
    releases[3]()
    await tick()
  })

  it('同一窗口多任务合并为一次会话（各占各自任务额度）', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run)
    const p = mk(1, 'bb-1')
    enq.enqueue(p, 'task-a')
    enq.enqueue(p, 'task-b')
    enq.enqueue(p, 'task-c')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual(['task-a', 'task-b', 'task-c'])
  })

  it('运行中再次 enqueue 排队为第二批且不与第一批并发', async () => {
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>(r => { releaseFirst = r })
    const run = vi.fn((profile: { id: number }, taskKeys: string[]) => {
      if (profile.id === 1 && run.mock.calls.length === 1) return firstGate.then(() => undefined)
      return Promise.resolve(undefined)
    })
    const enq = makeEnq(run)
    const profile = mk(1, 'bb-1')
    enq.enqueue(profile, 'task-a')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    enq.enqueue(profile, 'task-b')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    releaseFirst()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][1]).toEqual(['task-b'])
  })

  it('runner 抛错不会产生未处理的 rejection', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    const enq = makeEnq(run)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('释放额度时窗口正被其他任务会话占用：转入 followUp 不并发开窗', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, (key) => (key === 'task-a' ? 1 : 4))
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-b')
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    releases[1]()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    releases[2]()
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
    expect(run.mock.calls[2][0].id).toBe(2)
    expect(run.mock.calls[2][1]).toEqual(['task-a'])
    releases[2]()
    await tick()
  })

  it('hasTaskInFlight：pending/running/waiting 均判在途', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 1)
    const p1 = mk(1, 'bb-1')
    const p2 = mk(2, 'bb-2')
    enq.enqueue(p1, 'task-a')
    await tick()
    enq.enqueue(p2, 'task-a')
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    expect(enq.hasTaskInFlight('task-a', 1)).toBe(true)
    expect(enq.hasTaskInFlight('task-a', 2)).toBe(true)
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
    releases[1]()
    await tick()
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    releases[2]()
    await tick()
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
  })

  it('followUp 追加任务判在途', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => { release = r })
    const run = vi.fn((_profile: { id: number }, _taskKeys: string[]) => gate.then(() => undefined))
    const enq = makeEnq(run)
    const p1 = mk(1, 'bb-1')
    enq.enqueue(p1, 'task-a')
    await tick()
    enq.enqueue(p1, 'task-b')
    expect(enq.hasTaskInFlight('task-b')).toBe(true)
    expect(enq.hasTaskInFlight('task-b', 1)).toBe(true)
    release()
    await tick()
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
  })
})

describe('CoalescingEnqueuer 随机错峰', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('staggerMaxSec > 0：窗口会话延迟到期才开窗', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4, 120)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('等待期内同窗口任务继续合并为一次会话', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4, 120)
    const profile = mk(1, 'bb-1')
    enq.enqueue(profile, 'task-a')
    enq.enqueue(profile, 'task-b')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual(['task-a', 'task-b'])
  })

  it('不同窗口各自独立随机延迟', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4, 120)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('等待期间 hasTaskInFlight 判在途，会话结束后解除', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 2, 120)
    const p1 = mk(1, 'bb-1')
    enq.enqueue(p1, 'task-a')
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/queue.test.ts`
Expected: FAIL（新构造签名 `CoalescingEnqueuer` 不匹配 / TaskQueue 缺失导致的编译失败）

- [ ] **Step 3: 重写 src/engine/queue.ts**

整个文件替换为：

```ts
/**
 * 窗口任务队列（engine 层）：任务级并发额度 + 同窗口任务合并
 * 依赖方向：依赖基础设施类型，被 server 路由依赖
 * 设计思路：
 * - 每个任务有独立并发额度（meta.concurrency，缺省 DEFAULT_TASK_CONCURRENCY=4）：
 *   active 计数已占窗口数，超额的窗口进 waiting FIFO，会话结束释放额度时滚动续跑
 * - 同窗口任务合并保留：pending 合并区 + running/followUp 两套机制（由来见类注释）
 * - 错峰：首次入队随机延迟 staggerMaxSec 内再开窗（批量触发打散起点；0 = 关闭）
 */
import type { ProfileRow } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'

/** 一个窗口的合并任务条目 */
interface Entry {
  profile: ProfileRow
  taskKeys: Set<string>
}

/** 单任务额度：concurrency 上限、active 已占窗口数、waiting 等待队列（FIFO） */
interface Gate {
  concurrency: number
  active: number
  waiting: Entry[]
}

/**
 * 同窗口任务合并入队器（任务级并发）
 * 两套机制的由来（关键设计）：
 * - pending：窗口会话尚未开始（还没拿到额度或错峰等待中）时到达的任务在此合并，启动时一次性执行
 * - running/followUp：窗口会话运行中到达的任务进 followUp，等本轮结束后重新入队——
 *   直接开会话会与当前会话并发开同一窗口（同窗口两会话互相打架）
 * 结果：同窗口永不并发跑两个会话；不同窗口各自独立
 * - 额度：每个任务 active 计数不超过 concurrency；超额窗口进 waiting，release 时滚动续跑
 * - 错峰：首次入队随机延迟 staggerMaxSec 内再投递开窗（批量触发打散各窗口起点；
 *   单窗口 runManual 不经此路径不等待；0 = 关闭）
 */
export class CoalescingEnqueuer {
  /** 尚未启动的窗口会话合并区（按窗口 id） */
  private pending = new Map<number, Entry>()
  /** 正在运行的窗口 → 会话内任务集合（in-flight 判定用，会话结束即删） */
  private running = new Map<number, Set<string>>()
  /** 运行中窗口收到的追加任务（本轮结束后重新入队） */
  private followUp = new Map<number, Entry>()
  /** 任务级并发额度表（懒创建） */
  private gates = new Map<string, Gate>()

  constructor(
    private runner: { runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<unknown> },
    private logger: Logger,
    /** 任务并发上限取值（meta.concurrency，缺省 DEFAULT_TASK_CONCURRENCY=4） */
    private taskConcurrencyOf: (taskKey: string) => number,
    /** 窗口会话启动随机错峰上限（秒，0 = 关闭）：批量触发时各窗口在 [0, staggerMaxSec] 内随机延迟后开窗 */
    private staggerMaxSec = 0,
  ) {}

  /** 取（或懒创建）任务额度表 */
  private gateFor(taskKey: string): Gate {
    let gate = this.gates.get(taskKey)
    if (!gate) {
      gate = { concurrency: this.taskConcurrencyOf(taskKey), active: 0, waiting: [] }
      this.gates.set(taskKey, gate)
    }
    return gate
  }

  /**
   * 为某窗口入队一个任务（自动合并 + 任务级额度控制）
   * @param profile 窗口记录
   * @param taskKey 任务 key
   */
  enqueue(profile: ProfileRow, taskKey: string): void {
    // 窗口正在跑：追加到 followUp，本轮结束后统一重排（不能进 pending，见类注释）
    if (this.running.has(profile.id)) {
      const fu = this.followUp.get(profile.id) ?? { profile, taskKeys: new Set<string>() }
      fu.taskKeys.add(taskKey)
      this.followUp.set(profile.id, fu)
      return
    }
    const gate = this.gateFor(taskKey)
    // 额度已满：进等待队列（同窗口同任务去重），额度释放后滚动续跑
    if (gate.active >= gate.concurrency) {
      if (!gate.waiting.some(e => e.profile.id === profile.id && e.taskKeys.has(taskKey))) {
        gate.waiting.push({ profile, taskKeys: new Set([taskKey]) })
      }
      return
    }
    this.occupy(taskKey, profile)
  }

  /** 占额度并进入 pending 合并区（已排队未启动的合并进已有条目；否则新建 + 错峰投递） */
  private occupy(taskKey: string, profile: ProfileRow): void {
    const gate = this.gateFor(taskKey)
    gate.active++
    const entry = this.pending.get(profile.id)
    if (entry) {
      entry.taskKeys.add(taskKey)
      return
    }
    const fresh: Entry = { profile, taskKeys: new Set([taskKey]) }
    this.pending.set(profile.id, fresh)
    const delayMs = Math.floor(Math.random() * this.staggerMaxSec * 1000)
    if (delayMs <= 0) {
      this.dispatch(fresh)
    } else {
      setTimeout(() => this.dispatch(fresh), delayMs)
    }
  }

  /** 执行合并完成的窗口会话（delayMs=0 时与 enqueue 同步） */
  private dispatch(entry: Entry): void {
    void (async () => {
      // 让出微任务：等后续 enqueue 合并完成后再删除 pending 条目
      await Promise.resolve()
      this.pending.delete(entry.profile.id)
      this.running.set(entry.profile.id, new Set(entry.taskKeys))
      try {
        await this.runner.runWindowTasks(entry.profile, [...entry.taskKeys])
      } catch (e) {
        // 单窗口会话异常不影响其他窗口，只记日志
        this.logger.error({ err: (e as Error).message }, '窗口任务执行异常')
      }
      this.running.delete(entry.profile.id)
      // 本轮期间收到的追加任务重新入队（下一轮会话；先于额度释放，追加任务可立即占额度或排队）
      const fu = this.followUp.get(entry.profile.id)
      if (fu) {
        this.followUp.delete(entry.profile.id)
        for (const k of fu.taskKeys) this.enqueue(fu.profile, k)
      }
      // 释放本会话各任务额度并滚动续跑等待队列
      for (const k of entry.taskKeys) this.release(k)
    })()
  }

  /** 释放一个任务的额度并滚动续跑：waiting 队首出队重新入队 */
  private release(taskKey: string): void {
    const gate = this.gates.get(taskKey)
    if (!gate) return
    gate.active--
    const next = gate.waiting.shift()
    if (!next) return
    // 等待期间该窗口可能已被其他任务的会话占用：转 followUp，由该会话结束后重新入队
    if (this.running.has(next.profile.id)) {
      const fu = this.followUp.get(next.profile.id) ?? { profile: next.profile, taskKeys: new Set<string>() }
      fu.taskKeys.add(taskKey)
      this.followUp.set(next.profile.id, fu)
      return
    }
    this.occupy(taskKey, next.profile)
  }

  /**
   * 某任务是否在途：pending/running/followUp/waiting 任一命中；
   * 指定 profileId 时只看该窗口（看板行级判定用）
   */
  hasTaskInFlight(taskKey: string, profileId?: number): boolean {
    const inSet = (keys: Set<string> | undefined) => !!keys?.has(taskKey)
    if (profileId !== undefined) {
      if (inSet(this.pending.get(profileId)?.taskKeys)) return true
      if (inSet(this.running.get(profileId))) return true
      if (inSet(this.followUp.get(profileId)?.taskKeys)) return true
      return this.gates.get(taskKey)?.waiting.some(e => e.profile.id === profileId) ?? false
    }
    for (const e of this.pending.values()) if (e.taskKeys.has(taskKey)) return true
    for (const keys of this.running.values()) if (keys.has(taskKey)) return true
    for (const e of this.followUp.values()) if (e.taskKeys.has(taskKey)) return true
    return (this.gates.get(taskKey)?.waiting.length ?? 0) > 0
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/queue.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 改 src/app.ts 装配**

第 13 行改为：

```ts
import { CoalescingEnqueuer } from './engine/queue'
```

同 import 区加一行（放在 `import { recoverRetryTasks } from './engine/retry-recovery'` 之前或之后均可）：

```ts
import { DEFAULT_TASK_CONCURRENCY } from './engine/task'
```

第 181-182 行替换为：

```ts
  // 任务级并发：enqueuer 内部按 meta.concurrency 控制每任务并行窗口数（缺省 DEFAULT_TASK_CONCURRENCY）
  enqueuer = new CoalescingEnqueuer(runner, logger, (key) => tasks.get(key)?.meta.concurrency ?? DEFAULT_TASK_CONCURRENCY, cfg.execution.staggerMaxSec)
```

（即删掉 `const queue = new TaskQueue(cfg.execution.concurrency)` 一行，并把 enqueuer 构造改为新签名）

- [ ] **Step 6: 全量验证**

Run: `npm run typecheck` 然后 `npm test`
Expected: 全部通过（typecheck 无错误；queue 测试全绿；其余测试不受影响）

- [ ] **Step 7: Commit**

```bash
git add tests/queue.test.ts src/engine/queue.ts src/app.ts
git commit -m "feat: 队列改为任务级并发额度调度（去掉全局 p-queue 并发）"
```

---

### Task 3: 删除全局 execution.concurrency 与 p-queue 依赖

**Files:**
- Modify: `src/infrastructure/config.ts:24-26,108-110`
- Modify: `config/config.json:9`
- Modify: `package.json`（npm uninstall 自动改）
- Modify: `package-lock.json`（npm uninstall 自动改）
- Modify: `tests/config.test.ts:15,25,28,32`

**Interfaces:**
- Consumes: Task 2（`TaskQueue` 已无引用）
- Produces: `ExecutionConfig` 无 `concurrency` 字段

- [ ] **Step 1: 删 config.ts 字段与默认值**

`src/infrastructure/config.ts` 第 24 行注释改为：

```ts
/** 执行引擎配置：超时、重试与熔断的全局默认值（任务级可覆盖部分字段；并发为任务级 meta.concurrency） */
```

第 26 行 `  concurrency: number` 删除。

第 108-110 行（默认值注释与 `concurrency: 6,`）删除，仅保留：

```ts
    // 单窗口会话超时 15 分钟（开窗+探活+全部任务），防止异常卡死占用并发槽位
    windowTimeoutMs: 900000,
```

- [ ] **Step 2: 删 config/config.json 的 concurrency 行**

`config/config.json` `execution` 段第 9 行 `    "concurrency": 2,` 删除。

- [ ] **Step 3: 卸载 p-queue 依赖**

Run: `npm uninstall p-queue`
Expected: package.json 与 package-lock.json 中 p-queue 移除，无报错

- [ ] **Step 4: 改 tests/config.test.ts**

第 15 行 `expect(cfg.execution.concurrency).toBe(6)` 删除（保留 staggerMaxSec 断言）。

第二个用例的覆盖测试改用 `windowTimeoutMs`：
- 第 25 行 `execution: { concurrency: 3, probeUrl: 'https://base.example' },` 改为 `execution: { windowTimeoutMs: 123000, probeUrl: 'https://base.example' },`
- 第 28 行 `execution: { concurrency: 8 },` 改为 `execution: { windowTimeoutMs: 999000 },`
- 第 32 行 `expect(cfg.execution.concurrency).toBe(8)` 改为 `expect(cfg.execution.windowTimeoutMs).toBe(999000)`

- [ ] **Step 5: 验证**

Run: `npm run typecheck` 然后 `npm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/config.ts config/config.json package.json package-lock.json tests/config.test.ts
git commit -m "chore: 删除全局 execution.concurrency 与 p-queue 依赖"
```

---

### Task 4: server 层——GET /tasks 返回并发、settings 删除并发

**Files:**
- Modify: `src/server/routes/tasks.ts:9,144-163`（GET 返回 + swagger 注解）
- Modify: `src/server/routes/settings.ts:14,48,99`
- Modify: `tests/web.test.ts:26,31,69`（MockDeps 类型与 fixture）

**Interfaces:**
- Consumes: `DEFAULT_TASK_CONCURRENCY`（Task 1）
- Produces: `/api/tasks` data 项含 `concurrency: number`；`/api/settings` data 无 `concurrency`

- [ ] **Step 1: tasks.ts GET 返回 concurrency**

`src/server/routes/tasks.ts` import 区（`import type { SiteTask } from '../../tasks/base'` 行后）加：

```ts
import { DEFAULT_TASK_CONCURRENCY } from '../../engine/task'
```

GET 处理器 `list.push({...})` 对象 `captcha: m.captcha ?? null,` 行后加：

```ts
        concurrency: m.concurrency ?? DEFAULT_TASK_CONCURRENCY,
```

GET 的 swagger 注解（约第 59 行 `captcha` 属性块之后，`*/` 结束前）加：

```
 *                       concurrency: { type: integer, description: '任务级并发：同一时间最多几个窗口并行，缺省 4' }
```

- [ ] **Step 2: settings.ts 删 concurrency（3 处）**

`src/server/routes/settings.ts`：
- 第 14 行 `  concurrency: number` 删除
- swagger 注解第 48 行 ` *                     concurrency: { type: integer }` 删除
- 第 99 行 `      concurrency: deps.cfg.execution.concurrency,` 删除

- [ ] **Step 3: 改 tests/web.test.ts**

- 第 26 行 tasks meta 类型改为 `{ key: string; name: string; url: string; wallet: string; enabled?: boolean; concurrency?: number }`
- 第 31 行 `execution: { concurrency: number; staggerMaxSec: number; circuitBreakerThreshold: number; probeUrl: string }` 改为 `execution: { staggerMaxSec: number; circuitBreakerThreshold: number; probeUrl: string }`
- 第 69 行 fixture `execution: { concurrency: 6, staggerMaxSec: 120, circuitBreakerThreshold: 2, probeUrl: 'https://probe.io' },` 改为 `execution: { staggerMaxSec: 120, circuitBreakerThreshold: 2, probeUrl: 'https://probe.io' },`

在 `GET /api/tasks 返回任务元信息列表` 用例（约第 129-134 行）后新增用例：

```ts
  it('GET /api/tasks 返回任务级并发（meta 未写时缺省 4）', async () => {
    const res = await request(createApp(makeDeps() as never)).get('/api/tasks')
    expect(res.body.code).toBe(0)
    expect(res.body.data[0].concurrency).toBe(4)
  })
```

- [ ] **Step 4: 验证**

Run: `npm run typecheck` 然后 `npm test`
Expected: 全部通过（含新增用例）

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/tasks.ts src/server/routes/settings.ts tests/web.test.ts
git commit -m "feat: 任务接口返回任务级并发，设置接口移除全局并发"
```

---

### Task 5: 前端——任务卡片并发展示、设置页删并发、schema 手补

**Files:**
- Modify: `web/src/api/schema.d.ts:59,242`
- Modify: `web/src/pages/tasks/index.tsx:37-38`
- Modify: `web/src/pages/settings/index.tsx:68`

**Interfaces:**
- Consumes: Task 4 的 API 结构（`/api/tasks` 含 concurrency；`/api/settings` 无 concurrency）
- Produces: `TaskMetaView.concurrency: number`（types.ts 由 schema 自动派生，无需改）

- [ ] **Step 1: schema.d.ts 手补**

`web/src/api/schema.d.ts`：
- `/api/tasks` 的 data 项块（约第 47-59 行 `timeoutSec`/`retry`/`captcha` 区域）在 `captcha` 块后（第 59 行 `} | null;` 之后、第 60 行 `}[];` 之前）加：

```ts
                                concurrency?: number;
```

- `/api/settings` 的 data 块（约第 242 行）删除 `                                concurrency?: number;` 一行

- [ ] **Step 2: 任务卡片加并发展示**

`web/src/pages/tasks/index.tsx` 第 37-38 行改为：

```tsx
              ⏱ 钱包 {task.wallet ?? '无'} · 并发 {task.concurrency} · 重试{' '}
              {task.retry?.max ?? '默认'} 次 · 验证码 {task.captcha?.auto === false ? '关' : '自动'}
```

- [ ] **Step 3: 设置页删并发行**

`web/src/pages/settings/index.tsx` 第 68 行 `            { key: 'concurrency', label: '并发', children: s.concurrency },` 删除。

- [ ] **Step 4: 验证**

Run: `npm run typecheck`、`npm test`、`npm run test:web`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add web/src/api/schema.d.ts web/src/pages/tasks/index.tsx web/src/pages/settings/index.tsx
git commit -m "feat: 面板任务卡片展示任务级并发，设置页移除全局并发"
```

---

### Task 6: 文档更新（API-GUIDE.md 与 AGENTS.md）

**Files:**
- Modify: `docs/API-GUIDE.md:165-183,859-861,881,896,1165`
- Modify: `AGENTS.md:27,40,49 附近`

**Interfaces:**
- Consumes: 无（纯文档）
- Produces: 无

- [ ] **Step 1: API-GUIDE TaskMeta 字段表加 concurrency 行**

`docs/API-GUIDE.md` 第 165 行（`captcha` 行）后加：

```
| `concurrency` | `number?` | `4` | 任务级并发：同一时间最多几个窗口并行跑该任务；批量触发时按此额度滚动分批跑完所有启用窗口；缺省 4（`DEFAULT_TASK_CONCURRENCY`，定义于 `src/engine/task.ts`）。portal-rhuna 为 2，其余任务为 4 |
```

第 167 行下方的示例代码块（`captcha: { auto: true, maxCost: 1500 },` 行后）加：

```ts
  concurrency: 4,
```

- [ ] **Step 2: API-GUIDE 入队语义段补充任务级并发**

第 859 行整段替换为：

```
所有入口最终都调用 `CoalescingEnqueuer.enqueue(profile, taskKey)`：同一窗口的多个任务合并为一次开窗会话（开窗/连接/探活只做一遍）；窗口正在执行时新的触发进入 follow-up 队列，窗口跑完再补跑，**不会并发开同一个窗口**。每个任务有独立的并发额度（`meta.concurrency`，缺省 4）：额度满的窗口进入该任务的 waiting 队列，某窗口跑完释放额度后自动滚动续跑，直到所有入队窗口跑完。
```

- [ ] **Step 3: API-GUIDE 配置表 execution 行替换**

第 881 行整行替换为：

```
| `execution` | `staggerMaxSec`、`windowTimeoutMs`、`probeUrl`、`taskTimeoutMs`、`retryMax`、`retryBackoffSec`、`circuitBreakerThreshold`、`humanize` | 执行引擎：并发为任务级（`meta.concurrency`，缺省 4，见第 2 章 TaskMeta 字段表）；`staggerMaxSec` 是窗口会话启动随机错峰上限（秒，默认 120，0 关闭）；单窗口会话超时默认 15 分钟（到点剩余任务标「窗口超时」跳过）；`probeUrl` 是开窗后的探活地址；`taskTimeoutMs`/`retryMax`/`retryBackoffSec` 是单任务超时与重试的全局默认（任务 meta 可逐个覆盖）；`circuitBreakerThreshold` 是窗口熔断阈值（连续失败达到即跳过剩余任务）；`humanize.minDelayMs`/`humanize.maxDelayMs` 是拟人动作的随机停顿区间（默认 800/3000 毫秒） |
```

- [ ] **Step 4: API-GUIDE 设置页描述删「并发/」**

第 896 行中 `执行参数 Descriptions 只读展示（并发/错峰上限/探活 URL/熔断阈值/版本）` 改为 `执行参数 Descriptions 只读展示（错峰上限/探活 URL/熔断阈值/版本）`。

- [ ] **Step 5: API-GUIDE 重试要点措辞**

第 1165 行 `（不 sleep 占并发名额）` 改为 `（不 sleep 占任务并发额度）`。

- [ ] **Step 6: AGENTS.md 三处更新**

- 第 27 行 `（端口、并发数、开关等以文件为准）` 改为 `（端口、开关等以文件为准）`
- 第 40 行 `queue(p-queue 并发 + 同窗口任务合并 CoalescingEnqueuer)` 改为 `queue（任务级并发额度 + 同窗口任务合并 CoalescingEnqueuer）`
- 要点行 `任务 = \`meta\`（key/name/url/wallet/timeoutSec/retry/captcha） + \`run(ctx)\`` 改为 `任务 = \`meta\`（key/name/url/wallet/timeoutSec/retry/captcha/concurrency） + \`run(ctx)\``

- [ ] **Step 7: Commit**

```bash
git add docs/API-GUIDE.md AGENTS.md
git commit -m "docs: 手册与协作指南同步任务级并发"
```

---

## 完成验证（全部任务结束后）

Run: `npm run typecheck` 然后 `npm test` 然后 `npm run test:web`
Expected: 三个命令全部通过，无 p-queue 残留引用（可 `npm ls p-queue` 确认已卸载）。
