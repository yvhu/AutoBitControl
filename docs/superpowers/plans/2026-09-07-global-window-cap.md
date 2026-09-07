# 全局窗口上限 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 CoalescingEnqueuer 增加全局窗口上限闸门（`execution.maxConcurrentWindows`，默认 4），与任务级并发双闸门取更严者，任务数量增长时机器资源有兜底约束。

**Architecture:** 全局闸门只卡开窗——`dispatch(entry)` 入口同步检查全局额度（同步判定保证会话结束释放额度时的滚动续跑 FIFO 公平），满则进 `globalWaiting` FIFO 队列；**排队条目保留在 pending 合并区**（同窗口后续任务继续合并进同一会话），因此 `pendingCount()`/`hasTaskInFlight()` 无需任何改动（pending 来源自动覆盖全局排队语义）。会话结束顺序：followUp 重入队 → 释放全局额度并 dispatch 队首 → 逐个释放任务额度。构造签名加第 5 参 `maxConcurrentWindows`，缺省 `Infinity`（行为与现状逐位一致，现有测试零改动即回归）。

**Tech Stack:** TypeScript 严格模式、vitest、无分号单引号 2 空格缩进、注释与 commit 全中文。

## Global Constraints

- 规格文档：`docs/superpowers/specs/2026-09-07-global-window-cap-design.md`（已提交 88ae018）
- 配置键名与默认值：`execution.maxConcurrentWindows`，默认 **4**（代码默认值与 config.json 显式值一致）
- 任务级并发语义**零变化**：enqueue/occupy/release 现有逻辑不动
- 全局续跑不重复错峰（直接 dispatch）；stagger 错峰只作用于 occupy 路径
- 构造参数 `maxConcurrentWindows` clamp 到 ≥1，缺省 `Number.POSITIVE_INFINITY`
- 验证命令：`npm run typecheck`、`npm test`（后端）、`npm run test:web`（前端），全部通过才算完成
- 注释/commit 用中文，commit 风格 conventional：`feat: 中文描述`

---

### Task 1: 配置层 maxConcurrentWindows（默认 4）

**Files:**
- Modify: `src/infrastructure/config.ts:24-35`（ExecutionConfig 接口）、`config.ts:108-122`（defaults）
- Modify: `config/config.json`（execution 段）
- Test: `tests/config.test.ts:12-17`

**Interfaces:**
- Produces: `AppConfig.execution.maxConcurrentWindows: number`（默认 4），后续 Task 3（app 装配）、Task 4（settings 路由）消费

- [ ] **Step 1: 写失败测试**

`tests/config.test.ts` 的「无配置文件时返回默认值」用例中，第 15 行后加一行：

```ts
    expect(cfg.execution.staggerMaxSec).toBe(120)
    expect(cfg.execution.maxConcurrentWindows).toBe(4)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL，`cfg.execution.maxConcurrentWindows` 为 undefined，断言 `toBe(4)` 失败

- [ ] **Step 3: 实现配置字段**

`src/infrastructure/config.ts` 的 `ExecutionConfig` 接口，在 `circuitBreakerThreshold: number` 行后加：

```ts
  /** 全局窗口上限：同时最多开几个窗口会话（机器资源兜底；与任务级 concurrency 双闸门取更严者） */
  maxConcurrentWindows: number
```

同文件 defaults 的 `execution` 段，在 `circuitBreakerThreshold: 2,` 行后加：

```ts
    // 全局窗口上限：所有任务共享的同时开窗总数封顶（缺省 4；与任务级 meta.concurrency 双闸门取更严者）
    maxConcurrentWindows: 4,
```

`config/config.json` 的 `execution` 段，在 `"circuitBreakerThreshold": 2,` 行后加：

```json
    "maxConcurrentWindows": 4,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/infrastructure/config.ts config/config.json tests/config.test.ts
git commit -m "feat: 配置层新增全局窗口上限 maxConcurrentWindows（默认 4）"
```

---

### Task 2: 引擎全局闸门（queue.ts 核心改造）

**Files:**
- Modify: `src/engine/queue.ts:44-62`（类注释与构造函数）、`queue.ts:145-168`（dispatch）
- Test: `tests/queue.test.ts`（makeEnq 助手 + 新增 describe 块）

**Interfaces:**
- Consumes: 无（独立于 Task 1）
- Produces: `new CoalescingEnqueuer(runner, logger, taskConcurrencyOf, staggerMaxSec, maxConcurrentWindows = Number.POSITIVE_INFINITY)`；Task 3（app.ts）消费第 5 参

- [ ] **Step 1: 写失败测试（助手签名 + 6 个新用例）**

`tests/queue.test.ts` 的 makeEnq 助手（第 6-12 行）改为：

```ts
function makeEnq(
  run: ReturnType<typeof vi.fn>,
  concurrencyOf: (key: string) => number = () => 4,
  staggerMaxSec = 0,
  maxWindows = Number.POSITIVE_INFINITY,
) {
  return new CoalescingEnqueuer({ runWindowTasks: run } as never, logger, concurrencyOf, staggerMaxSec, maxWindows)
}
```

文件末尾（`describe('CoalescingEnqueuer 随机错峰')` 块之后）新增 describe 块：

```ts
describe('CoalescingEnqueuer 全局窗口上限', () => {
  it('全局额度内立即执行，超额窗口进全局队列，会话结束 FIFO 滚动续跑', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 10, 0, 2)
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

  it('全局排队期间同窗口任务继续合并为一次会话', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 10, 0, 1)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    await tick()
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-b')
    await tick()
    expect(run).toHaveBeenCalledTimes(1)
    releases[1]()
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0].id).toBe(2)
    expect(run.mock.calls[1][1]).toEqual([{ taskKey: 'task-a' }, { taskKey: 'task-b' }])
    releases[2]()
    await tick()
  })

  it('全局排队中的窗口判在途，会话结束后解除', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 10, 0, 1)
    const p1 = mk(1, 'bb-1')
    const p2 = mk(2, 'bb-2')
    enq.enqueue(p1, 'task-a')
    await tick()
    enq.enqueue(p2, 'task-a')
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    expect(enq.hasTaskInFlight('task-a', 2)).toBe(true)
    expect(enq.hasTaskInFlight('task-b')).toBe(false)
    releases[1]()
    await tick()
    expect(enq.hasTaskInFlight('task-a')).toBe(true)
    releases[2]()
    await tick()
    expect(enq.hasTaskInFlight('task-a')).toBe(false)
  })

  it('pendingCount 包含全局排队中的窗口数', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 10, 0, 1)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    await tick()
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(3, 'bb-3'), 'task-a')
    expect(enq.pendingCount()).toBe(2)
    releases[1]()
    await tick()
    expect(enq.pendingCount()).toBe(1)
    releases[2]()
    releases[3]()
    await tick()
  })

  it('双闸门取更严者：全局额度 2 限制任务额度 10', async () => {
    const releases: Record<number, () => void> = {}
    const run = vi.fn((profile: { id: number }, _tasks: Array<{ taskKey: string }>) => new Promise<void>(resolve => { releases[profile.id] = resolve }))
    const enq = makeEnq(run, () => 10, 0, 2)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-a')
    enq.enqueue(mk(3, 'bb-3'), 'task-a')
    await tick()
    expect(run).toHaveBeenCalledTimes(2)
    releases[1]()
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
    releases[2]()
    releases[3]()
    await tick()
  })

  it('maxWindows 缺省 Infinity：不设全局限制，任务额度照常', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const enq = makeEnq(run, () => 4)
    enq.enqueue(mk(1, 'bb-1'), 'task-a')
    enq.enqueue(mk(2, 'bb-2'), 'task-b')
    enq.enqueue(mk(3, 'bb-3'), 'task-c')
    await tick()
    expect(run).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/queue.test.ts`
Expected: 新 describe 块 6 个用例 FAIL（构造器不消费第 5 参，全局额度未生效：`run` 被调用 3 次而非 2 次）；既有用例 PASS

- [ ] **Step 3: 实现全局闸门**

`src/engine/queue.ts` 类注释第 1-9 行改为：

```ts
/**
 * 窗口任务队列（engine 层）：任务级并发额度 + 全局窗口上限 + 同窗口任务合并
 * 依赖方向：依赖基础设施类型，被 server 路由依赖
 * 设计思路：
 * - 每个任务有独立并发额度（meta.concurrency，缺省 DEFAULT_TASK_CONCURRENCY=4）：
 *   active 计数已占窗口数，超额的窗口进 waiting FIFO，会话结束释放额度时滚动续跑
 * - 全局窗口上限（maxConcurrentWindows，缺省 Infinity）：所有任务共享的同时开窗总数封顶，
 *   dispatch 开窗前同步检查，超额会话进 globalWaiting FIFO（条目保留在 pending 合并区，
 *   同窗口后续任务继续合并）；会话结束先释放全局额度滚动续跑，再释放任务额度
 * - 同窗口任务合并保留：pending 合并区 + running/followUp 两套机制（由来见类注释）
 * - 错峰：首次入队随机延迟 staggerMaxSec 内再开窗（批量触发打散起点；0 = 关闭）
 */
```

字段区（`private followUp = new Map<number, Entry>()` 行后）加：

```ts
  /** 全局窗口闸门：同时开窗总数上限（clamp 到 ≥1；Infinity = 不限制） */
  private readonly globalMax: number
  /** 全局闸门已占开窗数 */
  private globalActive = 0
  /** 全局额度已满时的窗口会话 FIFO 排队（条目保留在 pending 合并区，续跑时直接 dispatch 不重复错峰） */
  private globalWaiting: Entry[] = []
```

构造函数（第 55-62 行）改为：

```ts
  constructor(
    private runner: { runWindowTasks(profile: ProfileRow, tasks: SessionTask[]): Promise<unknown> },
    private logger: Logger,
    /** 任务并发上限取值（meta.concurrency，缺省 DEFAULT_TASK_CONCURRENCY=4） */
    private taskConcurrencyOf: (taskKey: string) => number,
    /** 窗口会话启动随机错峰上限（秒，0 = 关闭）：批量触发时各窗口在 [0, staggerMaxSec] 内随机延迟后开窗 */
    private staggerMaxSec = 0,
    /** 全局窗口上限：同时最多开几个窗口会话（机器资源兜底；Infinity = 不限制） */
    maxConcurrentWindows = Number.POSITIVE_INFINITY,
  ) {
    this.globalMax = Math.max(1, maxConcurrentWindows)
  }
```

`dispatch` 方法（第 146-168 行）整体替换为：

```ts
  /** 执行合并完成的窗口会话（delayMs=0 时与 enqueue 同步）；全局额度满时进全局 FIFO 排队 */
  private dispatch(entry: Entry): void {
    // 全局窗口闸门（同步判定，保证会话结束释放额度时的滚动续跑 FIFO 公平）：
    // 额度已满则进全局等待队列（条目保持 pending 合并区，同窗口后续任务继续合并进同一会话）
    if (this.globalActive >= this.globalMax) {
      this.globalWaiting.push(entry)
      return
    }
    this.globalActive++
    void (async () => {
      // 让出微任务：等后续 enqueue 合并完成后再删除 pending 条目
      await Promise.resolve()
      this.pending.delete(entry.profile.id)
      this.running.set(entry.profile.id, new Set(entry.tasks.map((t) => t.taskKey)))
      try {
        await this.runner.runWindowTasks(entry.profile, entry.tasks)
      } catch (e) {
        // 单窗口会话异常不影响其他窗口，只记日志
        this.logger.error({ err: (e as Error).message }, '窗口任务执行异常')
      }
      this.running.delete(entry.profile.id)
      // 本轮期间收到的追加任务重新入队（下一轮会话；先于额度释放，追加任务可立即占额度或排队；
      // 全局满时其 dispatch 走同步闸门自然排到全局队尾，FIFO 公平）
      const fu = this.followUp.get(entry.profile.id)
      if (fu) {
        this.followUp.delete(entry.profile.id)
        for (const t of fu.tasks) this.enqueue(fu.profile, t.taskKey, { immediate: fu.immediate, batchId: t.batchId })
      }
      // 先释放全局额度并滚动续跑全局队列（队首直接 dispatch，不重复错峰：会话结束时机天然错开），
      // 再释放本会话各任务额度（其滚动续跑的新会话 dispatch 时重新过全局闸门）
      this.globalActive--
      const next = this.globalWaiting.shift()
      if (next) this.dispatch(next)
      for (const t of entry.tasks) this.release(t.taskKey)
    })()
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/queue.test.ts`
Expected: 全部 PASS（6 个新用例 + 既有用例；既有用例走 `maxWindows` 缺省 Infinity 路径，是回归证明）

- [ ] **Step 5: Commit**

```powershell
git add src/engine/queue.ts tests/queue.test.ts
git commit -m "feat: 引擎新增全局窗口上限闸门（与任务级并发双闸门取更严者）"
```

---

### Task 3: app.ts 装配传参

**Files:**
- Modify: `src/app.ts:182`

**Interfaces:**
- Consumes: Task 1（`cfg.execution.maxConcurrentWindows`）、Task 2（构造器第 5 参）
- Produces: 运行时装配完成

- [ ] **Step 1: 装配传参**

`src/app.ts` 第 181-182 行整体替换为：

```ts
  // 双闸门：任务级并发（meta.concurrency）+ 全局窗口上限（execution.maxConcurrentWindows），
  // enqueuer 内部取更严者控制开窗总数
  enqueuer = new CoalescingEnqueuer(runner, logger, (key) => tasks.get(key)?.meta.concurrency ?? DEFAULT_TASK_CONCURRENCY, cfg.execution.staggerMaxSec, cfg.execution.maxConcurrentWindows)
```

- [ ] **Step 2: 全量验证**

Run: `npm run typecheck`
Expected: 无类型错误

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 3: Commit**

```powershell
git add src/app.ts
git commit -m "feat: app 装配全局窗口上限（cfg.execution.maxConcurrentWindows）"
```

---

### Task 4: settings 路由公开全局上限

**Files:**
- Modify: `src/server/routes/settings.ts:11-24`（PublicSettings）、`:33-47`（swagger）、`:92-108`（响应）
- Test: `tests/web.test.ts:42`（MockDeps 类型）、`:92`（fixture）、`:529-538`（断言）

**Interfaces:**
- Consumes: Task 1（`AppConfig.execution.maxConcurrentWindows`）
- Produces: `PublicSettings.maxConcurrentWindows: number`，Task 5（前端设置页/schema.d.ts）消费

- [ ] **Step 1: 写失败测试**

`tests/web.test.ts` 第 42 行改为：

```ts
    execution: { staggerMaxSec: number; circuitBreakerThreshold: number; maxConcurrentWindows: number }
```

第 92 行 fixture 改为：

```ts
      execution: { staggerMaxSec: 120, circuitBreakerThreshold: 2, maxConcurrentWindows: 4 },
```

第 534 行（`expect(res.body.data.circuitBreakerThreshold).toBeTypeOf('number')`）后加：

```ts
    expect(res.body.data.maxConcurrentWindows).toBe(4)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web.test.ts`
Expected: FAIL，`GET /api/settings 返回非敏感配置且不含 clientKey` 用例断言 `maxConcurrentWindows` 为 undefined

- [ ] **Step 3: 实现路由**

`src/server/routes/settings.ts` 的 `PublicSettings` 接口，在 `circuitBreakerThreshold: number` 行后加：

```ts
  maxConcurrentWindows: number
```

swagger 注解 properties 块，在 `circuitBreakerThreshold: { type: integer }` 行后加：

```
 *                     maxConcurrentWindows: { type: integer }
```

响应构造（第 98 行 `circuitBreakerThreshold: deps.cfg.execution.circuitBreakerThreshold,`）后加：

```ts
      maxConcurrentWindows: deps.cfg.execution.maxConcurrentWindows,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/web.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/server/routes/settings.ts tests/web.test.ts
git commit -m "feat: settings 接口公开全局窗口上限 maxConcurrentWindows"
```

---

### Task 5: 前端设置页展示 + schema.d.ts 手补

**Files:**
- Modify: `web/src/pages/settings/index.tsx:63-73`（执行参数 Descriptions）
- Modify: `web/src/api/schema.d.ts:570-571`（settings data 块）

**Interfaces:**
- Consumes: Task 4（`PublicSettings.maxConcurrentWindows`）

- [ ] **Step 1: 设置页加一行**

`web/src/pages/settings/index.tsx` 第 68 行（`{ key: 'stagger', label: '错峰上限', children: `${s.staggerMaxSec} 秒` },`）后加：

```tsx
            { key: 'maxWin', label: '全局窗口上限', children: s.maxConcurrentWindows },
```

- [ ] **Step 2: schema.d.ts 手补**

`web/src/api/schema.d.ts` 第 571 行（`circuitBreakerThreshold?: number;`）后加：

```ts
                                maxConcurrentWindows?: number;
```

- [ ] **Step 3: 验证**

Run: `npm run typecheck`
Expected: 无类型错误

Run: `npm run test:web`
Expected: 全部 PASS（设置页无渲染单测，hooks 测试不受影响，是回归证明）

- [ ] **Step 4: Commit**

```powershell
git add web/src/pages/settings/index.tsx web/src/api/schema.d.ts
git commit -m "feat: 设置页展示全局窗口上限（schema.d.ts 手补）"
```

---

### Task 6: 文档更新与规格修正

**Files:**
- Modify: `docs/API-GUIDE.md:1074`（入队语义）、`docs/API-GUIDE.md:1130`（配置表）
- Modify: `AGENTS.md:42`（engine 描述）、`AGENTS.md:9-11`（常用命令附近无改动；配置描述在「配置」节）
- Modify: `docs/superpowers/specs/2026-09-07-global-window-cap-design.md`（实现细化修正）

**Interfaces:**
- Consumes: Task 2（最终实现语义）

- [ ] **Step 1: API-GUIDE 入队语义补全局闸门**

第 1074 行段落末尾（「task:run 调试脚本是独立进程，直接跑 runManual 不经本队列。」之前）插入：

```
除此之外还有一道**全局窗口上限**（`execution.maxConcurrentWindows`，缺省 4，`Infinity` 不限制）：所有任务共享的同时开窗总数封顶，超额的窗口会话进全局 FIFO 排队（排队期间同窗口后续任务仍合并进该会话），某会话结束即滚动续跑；与任务级并发双闸门取更严者（任务级管站点风控、全局管机器资源）。
```

- [ ] **Step 2: API-GUIDE 配置表更新**

第 1130 行 `| `execution` | ...` 单元格改为：

```markdown
| `execution` | `staggerMaxSec`、`maxConcurrentWindows`、`windowTimeoutMs`、`taskTimeoutMs`、`retryMax`、`retryBackoffSec`、`circuitBreakerThreshold`、`humanize` | 执行引擎：并发为任务级（`meta.concurrency`，缺省 4，见第 2 章 TaskMeta 字段表）**加全局窗口上限**（`maxConcurrentWindows`，缺省 4，双闸门取更严者，机器资源兜底）；`staggerMaxSec` 是窗口会话启动随机错峰上限（秒，默认 120，0 关闭）；单窗口会话超时默认 15 分钟（到点剩余任务标「窗口超时」跳过）；`taskTimeoutMs`/`retryMax`/`retryBackoffSec` 是单任务超时与重试的全局默认（任务 meta 可逐个覆盖）；`circuitBreakerThreshold` 是窗口熔断阈值（连续失败达到即跳过剩余任务）；`humanize.minDelayMs`/`humanize.maxDelayMs` 是拟人动作的随机停顿区间（默认 800/3000 毫秒） |
```

- [ ] **Step 3: AGENTS.md 更新**

第 42 行 `queue（任务级并发额度 + 同窗口任务合并 CoalescingEnqueuer）` 改为：

```markdown
queue（全局窗口上限 + 任务级并发双闸门 + 同窗口任务合并 CoalescingEnqueuer）
```

「配置（读它，别猜）」节的 config.json 通用参数描述（`- config/config.json — 通用参数（已提交）`）后补一句：

```markdown
  - `execution.maxConcurrentWindows`：全局开窗上限（缺省 4，与任务级 concurrency 双闸门取更严者）
```

- [ ] **Step 4: 规格修正（实现细化）**

`docs/superpowers/specs/2026-09-07-global-window-cap-design.md` 第 2 节做两处修正（实现时发现更简方案，语义不变）：

「新增状态」代码块改为：

```ts
/** 全局窗口闸门：同时开窗总数上限（clamp 到 ≥1；Infinity = 不限制） */
private readonly globalMax: number
private globalActive = 0
/** 全局额度已满时的窗口会话 FIFO 排队（条目保留在 pending 合并区，续跑时直接 dispatch 不重复错峰） */
private globalWaiting: Entry[] = []
```

流程第 1 条改为：

```
1. **dispatch(entry)** 开头**同步**检查全局额度（同步判定保证会话结束释放额度时的滚动续跑 FIFO 公平）：
   - `globalActive < globalMax` → `globalActive++`，继续现有开窗流程
   - 否则 entry 进 `globalWaiting` 队尾返回（条目**保留在 pending 合并区**：同窗口后续任务继续合并进同一会话）
```

流程第 4、5 条改为：

```
4. **hasTaskInFlight / pendingCount 无需改动**：全局排队条目保留在 pending 合并区，既有的 pending 来源自动覆盖「全局排队判在途」与「已入队未开窗」口径
```

- [ ] **Step 5: Commit**

```powershell
git add docs/API-GUIDE.md AGENTS.md docs/superpowers/specs/2026-09-07-global-window-cap-design.md
git commit -m "docs: 全局窗口上限文档同步（API-GUIDE/AGENTS/规格修正）"
```

---

## 最终验证（全部任务完成后）

```powershell
npm run typecheck
npm test
npm run test:web
```

三者全部通过即完成。
