# 窗口启动随机错峰 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 批量触发时每个窗口会话在 `[0, staggerMaxSec]` 秒内随机延迟后才开窗跑任务，高并发下打散操作起点、避免网络/站点堵塞。

**Architecture:** 错峰实现在 `CoalescingEnqueuer.enqueue`：窗口首次入队随机取延迟，到点才投递 p-queue。不占并发槽位、不空开窗口；单窗口入口（runManual 不经 enqueuer）天然跳过等待；重试 re-enqueue 天然生效。`staggerMaxSec = 0` 时走同步路径，行为与现状逐位一致。

**Tech Stack:** Node + TS strict、vitest（fake timers）、React/antd 面板、p-queue。

**Spec:** `docs/superpowers/specs/2026-09-03-window-stagger-start-design.md`

## Global Constraints

- 每步改动后 `npm run typecheck`、`npm test`、`npm run test:web` 都必须通过
- 无分号、单引号、2 空格缩进；注释/commit message 用中文；commit 风格 conventional
- `web/src/api/schema.d.ts` 为手补类型（直接编辑，不重新生成）
- 默认值 `staggerMaxSec = 120`（秒）；`0` = 关闭错峰且行为与现状完全一致
- 不修改：p-queue 并发机制、WindowRunner、retry-recovery、runManual 路径、任务 meta
- config.json 中 `concurrency` 保持现值不动，只新增 `staggerMaxSec` 行

---

### Task 1: enqueuer 随机错峰（核心，TDD）

**Files:**
- Modify: `src/engine/queue.ts`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: 现有 `CoalescingEnqueuer(queue, runner, logger)` 三参构造（全部现有调用零改动）
- Produces: `new CoalescingEnqueuer(queue, runner, logger, staggerMaxSec: number)`；`enqueue` 延迟投递语义（`staggerMaxSec = 0` 同步投递、`> 0` setTimeout 延迟）；`dispatch(entry)` 私有方法承载原 queue.add 内容

- [ ] **Step 1: 写失败测试**

在 `tests/queue.test.ts` 末尾追加（`logger` 是其他 describe 的块内变量，本块需自带一份）：

```ts
describe('CoalescingEnqueuer 随机错峰', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} } as never

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('staggerMaxSec > 0：窗口会话延迟到期才投递开窗', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // 120s * 0.5 = 60s
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('等待期内同窗口任务继续合并为一次会话', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const profile = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(profile, 'task-a')
    enq.enqueue(profile, 'task-b')
    await vi.advanceTimersByTimeAsync(60_000)
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1]).toEqual(['task-a', 'task-b'])
  })

  it('不同窗口各自独立随机延迟', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(4)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const mk = (id: number, bb: string) => ({ id, bitbrowserId: bb, name: bb, enabled: 1, circuitBreakerCount: 0 })
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    await vi.advanceTimersByTimeAsync(60_000)
    await q.onIdle()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('等待期间 hasTaskInFlight 判在途，会话结束后解除', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const run = vi.fn().mockResolvedValue(undefined)
    const q = new TaskQueue(2)
    const enq = new CoalescingEnqueuer(q, { runWindowTasks: run } as never, logger, 120)
    const p1 = { id: 1, bitbrowserId: 'bb-1', name: 'A', enabled: 1, circuitBreakerCount: 0 }
    enq.enqueue(p1, 'task-a')
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    await q.onIdle()
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/queue.test.ts`
Expected: FAIL——`CoalescingEnqueuer` 构造只收 3 参，`Expected 3 arguments, but got 4` 编译错误（错峰用例红）。

- [ ] **Step 3: 实现最小改动**

`src/engine/queue.ts` 类注释（第 39-48 行目标段）在「目标：同一窗口的多个任务合并进一次开窗会话」条目后加一条：

```
 * - 错峰：首次入队时随机延迟 staggerMaxSec 内再投递开窗（批量触发打散各窗口起点；
 *   单窗口 runManual 不经此路径不等待；0 = 关闭）
```

构造与 enqueue 替换为（原 enqueue 内 queue.add 块整体抽到 dispatch）：

```ts
  constructor(
    private queue: TaskQueue,
    private runner: { runWindowTasks(profile: ProfileRow, taskKeys: string[]): Promise<unknown> },
    private logger: Logger,
    /** 窗口会话启动随机错峰上限（秒，0 = 关闭）：批量触发时各窗口在 [0, staggerMaxSec] 内随机延迟后开窗 */
    private staggerMaxSec = 0,
  ) {}

  /**
   * 为某窗口入队一个任务（自动合并）
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
    // 已排队未启动：合并进已有条目（共享一次开窗）
    const entry = this.pending.get(profile.id)
    if (entry) {
      entry.taskKeys.add(taskKey)
      return
    }
    // 首次入队：建条目，随机错峰延迟后投递 p-queue（等待期间条目留在 pending，继续合并/判在途）
    const fresh: Entry = { profile, taskKeys: new Set([taskKey]) }
    this.pending.set(profile.id, fresh)
    const delayMs = Math.floor(Math.random() * this.staggerMaxSec * 1000)
    if (delayMs <= 0) {
      this.dispatch(fresh)
    } else {
      setTimeout(() => this.dispatch(fresh), delayMs)
    }
  }

  /** 把合并完成的窗口会话投递 p-queue 拿槽位开窗（delayMs=0 时与 enqueue 同步） */
  private dispatch(entry: Entry): void {
    void this.queue.add(async () => {
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
      // 本轮期间收到的追加任务重新入队（下一轮会话）
      const fu = this.followUp.get(entry.profile.id)
      if (fu) {
        this.followUp.delete(entry.profile.id)
        for (const k of fu.taskKeys) this.enqueue(fu.profile, k)
      }
    })
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/queue.test.ts`
Expected: PASS（4 个新用例 + 7 个既有用例全绿；既有用例走 `staggerMaxSec = 0` 默认同步路径，是回归证明）

Run: `npm run typecheck` → Expected: 无错误
Run: `npm test` → Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/engine/queue.ts tests/queue.test.ts
git commit -m "feat: 窗口会话启动随机错峰（enqueuer 延迟投递）"
```

---

### Task 2: 配置 + 装配 + 设置页展示 + 测试同步

**Files:**
- Modify: `src/infrastructure/config.ts`、`config/config.json`、`src/app.ts`、`src/server/routes/settings.ts`、`web/src/pages/settings/index.tsx`、`web/src/api/schema.d.ts`、`tests/config.test.ts`、`tests/web.test.ts`

**Interfaces:**
- Consumes: Task 1（`CoalescingEnqueuer` 第 4 参 `staggerMaxSec`）
- Produces: `AppConfig.execution.staggerMaxSec: number`（默认 120）；`PublicSettings.staggerMaxSec`；设置页「错峰上限」展示；schema.d.ts `staggerMaxSec?: number`

- [ ] **Step 1: 配置层**

`src/infrastructure/config.ts`：
- `ExecutionConfig` 接口 `concurrency: number` 行后加：

```ts
  /** 窗口会话启动随机错峰上限（秒，0 = 关闭）：批量触发时各窗口在 [0, staggerMaxSec] 内随机延迟后开窗 */
  staggerMaxSec: number
```

- defaults 的 `execution` 段 `concurrency: 6,` 行后加：

```ts
    // 窗口会话启动随机错峰上限（秒）：打散批量触发时各窗口的开窗起点，避免同时冲击网络/站点；0 = 关闭
    staggerMaxSec: 120,
```

`config/config.json` 的 `execution` 段 `"concurrency": 2,` 行后加：

```json
    "staggerMaxSec": 120,
```

（`concurrency` 现值保持不动，只新增这一行）

- [ ] **Step 2: 装配**

`src/app.ts` 第 183 行改为：

```ts
  enqueuer = new CoalescingEnqueuer(queue, runner, logger, cfg.execution.staggerMaxSec)
```

- [ ] **Step 3: 设置路由与面板展示**

`src/server/routes/settings.ts`：
- `PublicSettings` 的 `concurrency: number` 行后加 `  staggerMaxSec: number`
- swagger properties 的 `concurrency: { type: integer }` 行后加 ` *                     staggerMaxSec: { type: integer }`
- 响应构造的 `concurrency: deps.cfg.execution.concurrency,` 行后加 `      staggerMaxSec: deps.cfg.execution.staggerMaxSec,`

`web/src/pages/settings/index.tsx` 执行参数 items 中 `{ key: 'concurrency', label: '并发', children: s.concurrency },` 行后加：

```tsx
            { key: 'stagger', label: '错峰上限', children: `${s.staggerMaxSec} 秒` },
```

`web/src/api/schema.d.ts` settings data 块 `concurrency?: number;` 行后加 `                                staggerMaxSec?: number;`

- [ ] **Step 4: 测试同步**

`tests/config.test.ts` 第 15 行 `expect(cfg.execution.concurrency).toBe(6)` 后加 `    expect(cfg.execution.staggerMaxSec).toBe(120)`。

`tests/web.test.ts`：
- 第 31 行 `execution: { concurrency: number; circuitBreakerThreshold: number; probeUrl: string }` 改为 `execution: { concurrency: number; staggerMaxSec: number; circuitBreakerThreshold: number; probeUrl: string }`
- 第 69 行 fixture `execution: { concurrency: 6, circuitBreakerThreshold: 2, probeUrl: 'https://probe.io' },` 改为 `execution: { concurrency: 6, staggerMaxSec: 120, circuitBreakerThreshold: 2, probeUrl: 'https://probe.io' },`

- [ ] **Step 5: 验证**

Run: `npm run typecheck` → Expected: 无错误
Run: `npm test` → Expected: 全绿
Run: `npm run test:web` → Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/config.ts config/config.json src/app.ts src/server/routes/settings.ts web/src/pages/settings/index.tsx web/src/api/schema.d.ts tests/config.test.ts tests/web.test.ts
git commit -m "feat: 错峰上限配置与设置页展示（staggerMaxSec 默认 120）"
```

---

### Task 3: 文档同步

**Files:**
- Modify: `docs/API-GUIDE.md`、`AGENTS.md`

**Interfaces:**
- Consumes: Task 1-2（最终代码状态）
- Produces: 文档与代码一致

- [ ] **Step 1: API-GUIDE.md 三处替换**

1. 「入队语义」小节（约第 859 行）现有段落后追加一段：

```md
批量触发与失败重试的窗口会话开窗前自带**随机错峰**：每个窗口在 `[0, execution.staggerMaxSec]`（默认 120 秒）内随机取一个延迟才开窗，把各窗口的操作起点打散、避免同时冲击网络/站点；设为 `0` 关闭错峰。看板行级「执行/重跑」与 task:run 调试脚本不等待（立即开窗）。
```

2. 配置表 execution 行（约第 879 行，旧文本以 `| \`execution\` | \`concurrency\`、\`windowTimeoutMs\`` 开头）整行替换为：

```md
| `execution` | `concurrency`、`staggerMaxSec`、`windowTimeoutMs`、`probeUrl`、`taskTimeoutMs`、`retryMax`、`retryBackoffSec`、`circuitBreakerThreshold`、`humanize` | 执行引擎：窗口并发默认 6；`staggerMaxSec` 是窗口会话启动随机错峰上限（秒，默认 120，0 关闭）；单窗口会话超时默认 15 分钟（到点剩余任务标「窗口超时」跳过）；`probeUrl` 是开窗后的探活地址；`taskTimeoutMs`/`retryMax`/`retryBackoffSec` 是单任务超时与重试的全局默认（任务 meta 可逐个覆盖）；`circuitBreakerThreshold` 是窗口熔断阈值（连续失败达到即跳过剩余任务）；`humanize.minDelayMs`/`humanize.maxDelayMs` 是拟人动作的随机停顿区间（默认 800/3000 毫秒） |
```

3. 8.2 设置页描述（约第 894 行）中 `执行参数 Descriptions 只读展示（并发/探活 URL/熔断阈值/版本）` 改为 `执行参数 Descriptions 只读展示（并发/错峰上限/探活 URL/熔断阈值/版本）`。

- [ ] **Step 2: AGENTS.md 踩坑提醒加一条**

「踩坑提醒」清单末尾加：

```md
- 批量触发（任务页「立即触发」）与重试会话开窗前自带随机错峰（`execution.staggerMaxSec`，默认 120 秒，0 关闭）；单窗口入口（看板行级执行、task:run 脚本）不等待
```

- [ ] **Step 3: 验证**

Run: `npm run typecheck` → Expected: 无错误
Run: `npm test` → Expected: 全绿
Run: `npm run test:web` → Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add docs/API-GUIDE.md AGENTS.md
git commit -m "docs: 手册与指南同步窗口启动随机错峰"
```
