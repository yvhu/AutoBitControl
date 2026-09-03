# 窗口启动随机错峰设计（stagger-start）

日期：2026-09-03
状态：已确认（用户确认后直接实施）

## 目标

多开窗口保持高并发，同时给每个窗口的会话启动加**随机时差**：批量触发时，每个窗口在 `[0, staggerMaxSec]` 秒内随机取一个延迟才开窗跑任务，避免所有窗口同时操作造成网络/站点堵塞。

已确认的关键决策：

- 错峰形态：**随机窗口内错峰**（均匀分布，非固定间隔）
- 作用点：**开窗前等待**（不空开窗口、不占并发槽位）
- 并发配合：**高并发 + 错峰**（p-queue 并发机制不动，上限由用户调 config）
- 默认窗口大小：**120 秒**（可配置，`0` = 关闭错峰）
- 生效范围：**批量触发 + 重试会话生效；单窗口入口跳过**（看板行级执行/重跑、task:run 脚本）
- 配置位置：**仅全局** `execution.staggerMaxSec`（时差是窗口会话级行为，不属任务 meta）

## 方案（enqueuer 延迟投递）

时差实现在 `CoalescingEnqueuer.enqueue`：窗口首次入队建条目时随机取延迟，到点才投递 p-queue 拿槽位开窗。对比 runner 内等待方案，本方案不占并发槽位、不空开窗口；单窗口入口不等待：看板行级触发走 `enqueue(..., { immediate: true })` 跳过延迟；task:run 脚本走 `runManual` 不经 enqueuer 天然不等待

## 改动清单

### 1. `src/engine/queue.ts`（核心）

`CoalescingEnqueuer` 构造函数加第 4 参数 `staggerMaxSec: number = 0`（默认 0：现有测试与调用零改动、行为不变）。

`enqueue` 首次建条目时：

1. `const delayMs = Math.floor(Math.random() * this.staggerMaxSec * 1000)`（窗口会话级：同窗口多任务合并共享同一次延迟）
2. `delayMs <= 0` → 立即走现有 `queue.add` 路径（行为与现在完全一致，向后兼容）
3. `delayMs > 0` → `setTimeout(delayMs)` 到期后走现有 `queue.add` 路径；等待期间条目保留在 pending map（同窗口新任务继续合并、`hasTaskInFlight` 照常判在途、触发接口 409 守卫照旧生效）
4. followUp 补跑与重试重排走同一 `enqueue` 路径，各自获得新随机延迟（重试错峰自然生效）

不修改：pending/running/followUp 三态结构、合并语义、p-queue 投递内容。

### 2. `src/infrastructure/config.ts` + `config/config.json`

- `ExecutionConfig` 加 `staggerMaxSec: number`
- defaults 加 `staggerMaxSec: 120`（注释：窗口会话启动随机错峰上限（秒），0 关闭）
- `config/config.json` 的 `execution` 段加 `"staggerMaxSec": 120`

### 3. `src/app.ts`

- `new CoalescingEnqueuer(queue, runner, logger, cfg.execution.staggerMaxSec)`

### 4. `scripts/run-task.ts`

- 无需改动（走 `runManual` 不经 enqueuer，单窗口调试不等待——已确认行为）

### 5. 设置页展示（只读）

- `src/server/routes/settings.ts`：`PublicSettings` 加 `staggerMaxSec: number`，响应返回 `deps.cfg.execution.staggerMaxSec`，swagger 注解同步
- `web/src/pages/settings/index.tsx`：「执行参数」Descriptions 加一行 `{ key: 'stagger', label: '错峰上限', children: `${s.staggerMaxSec} 秒` }`
- `web/src/api/schema.d.ts` 手补 `staggerMaxSec?: number;`

### 6. 测试

- `tests/queue.test.ts`：新增用例（vi.useFakeTimers）：
  - `staggerMaxSec > 0` 时窗口会话延迟后才投递（跑定时器前 run 未调用，跑满后调用）
  - 同一窗口等待期内继续合并（延迟期间 enqueue 多个任务仍只跑一次且含全部 key）
  - 不同窗口各自独立随机延迟
  - `staggerMaxSec = 0`（默认）行为不变（现有用例即为回归）
  - 等待期间 `hasTaskInFlight` 判在途
- `tests/web.test.ts`：MockDeps 的 `execution` 类型加 `staggerMaxSec: number`，fixture 补 `staggerMaxSec: 120`
- `tests/config.test.ts`：默认值断言（如有 defaults 断言处补 `staggerMaxSec: 120`）

### 7. 文档

- `docs/API-GUIDE.md` 第 7 章「入队语义」补错峰说明：批量触发/重试时每个窗口在 [0, staggerMaxSec] 内随机延迟后开窗；单窗口入口与 task:run 不等待；第 8 章配置表 `execution` 行加 `staggerMaxSec`；8.2 设置页描述加「错峰上限」
- `AGENTS.md` 踩坑提醒加一条：批量触发自带开窗随机错峰（execution.staggerMaxSec，默认 120 秒，0 关闭）

## 边界与权衡

- 等待中的 setTimeout 是内存态：进程退出自然丢弃（与队列现状一致），重启后 retry_wait 由重试恢复扫描接管
- `staggerMaxSec = 0` 时 `delayMs` 恒 0 走同步路径，与现有行为逐位一致
- 等待期不写 runs 表新行（窗口尚未开窗，等同排队期延长），面板 inFlight/409 守卫语义不变
- 总耗时不超预算：错峰只把各窗口起点拉散，不改变并发吞吐（并发 8 + 120s 错峰，100 窗口全批完成 ≈ 120s + 批次耗时）

## 明确不做

- 不做任务级错峰覆盖（meta.staggerMaxSec）——窗口会话可能跑多任务，取谁的配置语义混乱
- 不做固定间隔/顺序启动模式
- 不动 p-queue 并发机制、WindowRunner 主流程、retry-recovery
- 不做「错峰状态」的持久化与面板可视化（等待窗口数等）

## 验证计划

- `npm run typecheck`、`npm test`、`npm run test:web` 全绿
- 手动：config 设 `staggerMaxSec: 60` + 并发 4，任务页「立即触发」，观察日志开窗时刻分散在 60 秒内；设 0 再触发，行为与改造前一致；看板行级「执行」立即开窗不等
