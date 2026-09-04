# 独立定时任务子系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AutoBitControl 增加完全独立的定时任务子系统：面板「定时任务」栏目配置计划（每 N 小时/每日/每周/每月），到点对全部启用窗口触发所选任务。

**Architecture:** 自研 tick 调度器（无新依赖）。`src/engine/schedule.ts` 提供纯函数（墙上时钟读取、到点匹配、下次执行计算、配置校验），`src/engine/scheduler.ts` 的 Scheduler 类每 15 秒 tick 扫描 SQLite `schedules` 表并触发，触发路径复用现有 `createBatch` + `enqueuer.enqueue`（不带 immediate，沿用全局错峰）。server 层新增 schedules CRUD 路由，前端新增 `/schedules` 页面。

**Tech Stack:** Node 20 + TS 严格模式、express 5、@libsql/client（SQLite）、vitest、React 18 + antd 5 + react-query。

**Spec:** `docs/superpowers/specs/2026-09-04-standalone-scheduler-design.md`（已确认；含「与现有系统的交互」章节）

## Global Constraints

- 所有注释/文档/commit message 用中文；代码风格：无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块说明模块职责与依赖方向；camelCase 命名、kebab-case 文件名
- **不引入任何新 npm 依赖**（含 cron 库、时区库）
- 分层方向不可反向：`tasks → engine → {integrations, automation} → infrastructure`；`server → {engine, infrastructure}`；engine 不得 import tasks 层（Scheduler 依赖的 tasks 用 `Map<string, { meta: TaskMeta }>` 结构类型）
- 后端响应统一 `{code, message, data}`（server/http/response.ts 的 ok/fail + asyncHandler），错误走 HttpError
- 日志用 logger（中文消息，格式 `logger.info({count}, '消息')`）
- commit 风格 conventional：`feat:`/`fix:`/`chore:`/`docs:` + 中文描述
- 验证命令：`npm run typecheck`、`npm test`、`npm run test:web` 全部通过才算完成
- 时区：`scheduler.timezone` 配置项，默认 `Asia/Shanghai`；所有「是否到点」判断在墙上时钟上做匹配（不涉及 epoch 换算）；间隔模式午夜对齐且**排除 00:00**
- 错过即跳过（无锚点持久化）；任务在途/停用/未注册则跳过该任务并记日志；计划级异常不抛出

---

### Task 1: DB 层 — schedules 表与 CRUD 方法 + batch kind 扩展

**Files:**
- Modify: `src/infrastructure/db.ts`（SCHEMA 数组加表；新增 `ScheduleRow` 类型与 5 个方法；`BatchRow.kind` 与 `createBatch` kind 联合类型加 `'schedule'`）
- Create: `tests/schedules-db.test.ts`

**Interfaces:**
- Produces（后续任务依赖）:
  ```ts
  export interface ScheduleRow {
    id: number
    name: string
    /** 0/1（SQLite 无布尔） */
    enabled: number
    mode: 'interval' | 'daily' | 'weekly' | 'monthly'
    /** JSON 原文（{everyHours} | {times} | {weekdays,times} | {days,times}） */
    config: string
    /** JSON 原文（任务 key 字符串数组） */
    taskKeys: string
    createdAt: string
    updatedAt: string
  }
  // AppDb 方法
  listSchedules(): Promise<ScheduleRow[]>
  getSchedule(id: number): Promise<ScheduleRow | null>
  createSchedule(input: { name: string; mode: string; config: string; taskKeys: string }): Promise<ScheduleRow>
  updateSchedule(id: number, patch: { name?: string; enabled?: boolean; mode?: string; config?: string; taskKeys?: string }): Promise<ScheduleRow | null>  // null = 不存在
  deleteSchedule(id: number): Promise<boolean>
  // createBatch 的 kind 参数扩展为 'bulk' | 'single' | 'schedule'
  ```

- [ ] **Step 1: 写失败测试** — 创建 `tests/schedules-db.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AppDb } from '../src/infrastructure/db'

let db: AppDb
// file::memory: 走 @libsql/client 本地引擎：测试无需凭据，每个用例独立空库
beforeEach(async () => { db = await AppDb.open('file::memory:') })
afterEach(() => { db.close() })

describe('AppDb · schedules 表', () => {
  it('createSchedule 后 listSchedules 读回（JSON 原文不变）', async () => {
    await db.createSchedule({ name: '每日签到', mode: 'daily', config: '{"times":["09:00","15:00"]}', taskKeys: '["task-a","task-b"]' })
    const list = await db.listSchedules()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('每日签到')
    expect(list[0].enabled).toBe(1)
    expect(list[0].mode).toBe('daily')
    expect(JSON.parse(list[0].config)).toEqual({ times: ['09:00', '15:00'] })
    expect(JSON.parse(list[0].taskKeys)).toEqual(['task-a', 'task-b'])
    expect(list[0].createdAt).toBeTruthy()
  })

  it('getSchedule 命中与未命中', async () => {
    const s = await db.createSchedule({ name: 'A', mode: 'interval', config: '{"everyHours":6}', taskKeys: '["task-a"]' })
    expect((await db.getSchedule(s.id))?.name).toBe('A')
    expect(await db.getSchedule(999)).toBeNull()
  })

  it('updateSchedule 部分更新（enabled=false 持久化，其余字段不动）', async () => {
    const s = await db.createSchedule({ name: 'A', mode: 'daily', config: '{"times":["09:00"]}', taskKeys: '["task-a"]' })
    const u = await db.updateSchedule(s.id, { enabled: false, name: 'B' })
    expect(u).not.toBeNull()
    expect(u!.enabled).toBe(0)
    expect(u!.name).toBe('B')
    expect(u!.mode).toBe('daily')
    expect(JSON.parse(u!.config)).toEqual({ times: ['09:00'] })
    expect(u!.updatedAt >= s.updatedAt).toBe(true)
    expect(await db.updateSchedule(999, { enabled: false })).toBeNull()
  })

  it('deleteSchedule 删除并返回布尔', async () => {
    const s = await db.createSchedule({ name: 'A', mode: 'daily', config: '{"times":["09:00"]}', taskKeys: '[]' })
    expect(await db.deleteSchedule(s.id)).toBe(true)
    expect(await db.deleteSchedule(s.id)).toBe(false)
    expect(await db.listSchedules()).toHaveLength(0)
  })

  it('createBatch 支持 kind=schedule 且 getBatch 读回', async () => {
    const b = await db.createBatch('schedule', 'task-a', '计划#1 每日签到')
    expect(b.kind).toBe('schedule')
    expect((await db.getBatch(b.id))?.kind).toBe('schedule')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/schedules-db.test.ts`
Expected: FAIL——类型错误（ScheduleRow 不存在）与运行时错误（表不存在/方法缺失）

- [ ] **Step 3: 实现 db.ts 变更**

3a. 在 `RunStatus` 类型之后加 `ScheduleRow` 类型与 `BatchKind`（并修改 `BatchRow` 的 kind）：

```ts
/** batches 表 kind 联合类型 */
export type BatchKind = 'bulk' | 'single' | 'schedule'

/** schedules 表行：一个定时计划（config/taskKeys 为 JSON 原文，语义见 engine/schedule.ts） */
export interface ScheduleRow {
  id: number
  name: string
  /** 0/1（SQLite 无布尔，读出保持数字由调用方判断） */
  enabled: number
  mode: 'interval' | 'daily' | 'weekly' | 'monthly'
  /** JSON 原文：interval {everyHours} / daily {times} / weekly {weekdays,times} / monthly {days,times} */
  config: string
  /** JSON 原文：任务 key 字符串数组 */
  taskKeys: string
  createdAt: string
  updatedAt: string
}
```

并把 `BatchRow` 的 `kind: 'bulk' | 'single'` 改为 `kind: BatchKind`。

3b. SCHEMA 数组在 `task_states` 建表语句之后加一条：

```ts
  // 定时计划表：计划（时间配置 + 任务列表）与任务代码完全解耦，由面板「定时任务」栏目管理
  `CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL,
    config TEXT NOT NULL,
    task_keys TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
```

3c. `createBatch` 签名 kind 参数改为 `kind: BatchKind`。

3d. 在类里加 5 个方法（放在 `setTaskEnabled` 之后）：

```ts
  // ===== schedules 定时计划 CRUD（config/taskKeys 以 JSON 原文落库，语义解析在 engine/schedule.ts）=====

  /** 全部计划（按创建顺序）；引擎 tick 与面板列表共用 */
  async listSchedules(): Promise<ScheduleRow[]> {
    return (await this.exec(`SELECT id, name, enabled, mode, config, task_keys AS taskKeys, created_at AS createdAt, updated_at AS updatedAt FROM schedules ORDER BY id`)) as unknown as ScheduleRow[]
  }

  /** 按 id 查计划（不存在返回 null） */
  async getSchedule(id: number): Promise<ScheduleRow | null> {
    const rows = await this.exec(`SELECT id, name, enabled, mode, config, task_keys AS taskKeys, created_at AS createdAt, updated_at AS updatedAt FROM schedules WHERE id = ?`, [id])
    return (rows[0] as unknown as ScheduleRow | undefined) ?? null
  }

  /** 新建计划（enabled 默认 1）；createdAt/updatedAt 为本地墙钟时间（与 batches 同口径） */
  async createSchedule(input: { name: string; mode: string; config: string; taskKeys: string }): Promise<ScheduleRow> {
    const now = localWallNow()
    const rs = await this.client.execute({
      sql: `INSERT INTO schedules (name, enabled, mode, config, task_keys, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)`,
      args: [input.name, input.mode, input.config, input.taskKeys, now, now],
    })
    return (await this.getSchedule(Number(rs.lastInsertRowid)))!
  }

  /** 部分更新计划（缺省字段不动）；不存在返回 null */
  async updateSchedule(id: number, patch: { name?: string; enabled?: boolean; mode?: string; config?: string; taskKeys?: string }): Promise<ScheduleRow | null> {
    const current = await this.getSchedule(id)
    if (!current) return null
    await this.exec(
      `UPDATE schedules SET name = ?, enabled = ?, mode = ?, config = ?, task_keys = ?, updated_at = ? WHERE id = ?`,
      [patch.name ?? current.name, patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0, patch.mode ?? current.mode, patch.config ?? current.config, patch.taskKeys ?? current.taskKeys, localWallNow(), id],
    )
    return this.getSchedule(id)
  }

  /** 删除计划；返回是否存在过 */
  async deleteSchedule(id: number): Promise<boolean> {
    const rs = await this.client.execute({ sql: 'DELETE FROM schedules WHERE id = ?', args: [id] })
    return Number(rs.rowsAffected) > 0
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/schedules-db.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 全量回归 + commit**

Run: `npm run typecheck` 然后 `npm test`
Expected: 全过（db.test.ts 等既有用例不受影响）

```bash
git add src/infrastructure/db.ts tests/schedules-db.test.ts
git commit -m "feat: 数据层新增 schedules 表与 CRUD，batch kind 支持 schedule"
```

---

### Task 2: 配置 — scheduler.timezone

**Files:**
- Modify: `src/infrastructure/config.ts`（AppConfig 加 `scheduler`；defaults 加默认值）
- Modify: `config/config.json`（加 scheduler 段）
- Modify: `tests/config.test.ts`（新增用例）

**Interfaces:**
- Produces: `AppConfig.scheduler: { timezone: string }`（默认 `Asia/Shanghai`）

- [ ] **Step 1: 写失败测试** — 在 `tests/config.test.ts` 的 `loadConfig` describe 块内最后一个用例之后追加：

```ts
  it('scheduler.timezone 默认 Asia/Shanghai，可被 config.json 覆盖', () => {
    expect(loadConfig({ rootDir: dir }).scheduler.timezone).toBe('Asia/Shanghai')
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ scheduler: { timezone: 'UTC' } }))
    expect(loadConfig({ rootDir: dir }).scheduler.timezone).toBe('UTC')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL——`cfg.scheduler` 不存在（TS 编译错误）

- [ ] **Step 3: 实现**

3a. `config.ts` 在 `DataSourceConfig` 接口后加：

```ts
/** 定时任务调度配置 */
export interface SchedulerConfig {
  /** 固定时区（IANA 名称）：面板显示与到点判断统一按此时区的墙上时钟 */
  timezone: string
}
```

`AppConfig` 接口加 `scheduler: SchedulerConfig`。

3b. defaults 里（`dataSource` 之后）加：

```ts
  // 定时任务固定时区：配置与展示统一按此时区（Asia/Shanghai 无 DST，一般无需改动）
  scheduler: { timezone: 'Asia/Shanghai' },
```

3c. `config/config.json` 在 `"web"` 行之前加：

```json
  "scheduler": { "timezone": "Asia/Shanghai" },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: 全量回归 + commit**

Run: `npm run typecheck` 然后 `npm test`
Expected: 全过

```bash
git add src/infrastructure/config.ts config/config.json tests/config.test.ts
git commit -m "feat: 配置新增 scheduler.timezone（默认 Asia/Shanghai）"
```

---

### Task 3: 引擎纯函数 — src/engine/schedule.ts

**Files:**
- Create: `src/engine/schedule.ts`
- Create: `tests/scheduler.test.ts`（本任务只写纯函数部分；Task 4 追加 Scheduler 类用例）

**Interfaces:**
- Produces（Task 4/5 依赖）:
  ```ts
  export type ScheduleMode = 'interval' | 'daily' | 'weekly' | 'monthly'
  export interface ScheduleConfig {
    everyHours?: number
    times?: string[]          // 'HH:mm' 列表
    weekdays?: number[]       // 1=周一 … 7=周日
    days?: number[]           // 1–31
  }
  export interface WallClock { year: number; month: number; day: number; weekday: number; hour: number; minute: number }
  export function wallClockIn(tz: string, now?: Date): WallClock
  export function isDueMinute(mode: ScheduleMode, cfg: ScheduleConfig, wc: WallClock): boolean
  export function modeLabel(mode: ScheduleMode): string
  export function ruleText(mode: ScheduleMode, cfg: ScheduleConfig): string
  export function nextRunText(mode: ScheduleMode, cfg: ScheduleConfig, tz: string, now?: Date): string
  export function validateScheduleConfig(mode: ScheduleMode, cfg: ScheduleConfig): string | null  // null = 合法，否则错误文案
  ```

- [ ] **Step 1: 写失败测试** — 创建 `tests/scheduler.test.ts`（本任务部分）：

```ts
import { describe, it, expect } from 'vitest'
import { wallClockIn, isDueMinute, modeLabel, ruleText, nextRunText, validateScheduleConfig } from '../src/engine/schedule'

const TZ = 'Asia/Shanghai'

describe('wallClockIn（Intl 读配置时区墙上时钟）', () => {
  it('UTC 时间转 Asia/Shanghai 墙上时钟（+8）', () => {
    // 2026-09-04T01:00:00Z = 上海 2026-09-04 09:00 周五
    const wc = wallClockIn(TZ, new Date('2026-09-04T01:00:00Z'))
    expect(wc).toEqual({ year: 2026, month: 9, day: 4, weekday: 5, hour: 9, minute: 0 })
  })

  it('午夜边界：hour 不出现 24', () => {
    // 2026-09-03T16:00:00Z = 上海 2026-09-04 00:00
    const wc = wallClockIn(TZ, new Date('2026-09-03T16:00:00Z'))
    expect(wc.hour).toBe(0)
    expect(wc.day).toBe(4)
  })
})

describe('isDueMinute（四种模式到点匹配）', () => {
  const wc = (h: number, m: number, weekday = 5, day = 4) => ({ year: 2026, month: 9, day, weekday, hour: h, minute: m })

  it('interval：每 6 小时，06:00/12:00/18:00 命中，00:00 不命中', () => {
    const cfg = { everyHours: 6 }
    expect(isDueMinute('interval', cfg, wc(6, 0))).toBe(true)
    expect(isDueMinute('interval', cfg, wc(12, 0))).toBe(true)
    expect(isDueMinute('interval', cfg, wc(18, 0))).toBe(true)
    expect(isDueMinute('interval', cfg, wc(0, 0))).toBe(false)
    expect(isDueMinute('interval', cfg, wc(9, 5))).toBe(false)
  })

  it('daily：时间点命中，其它分钟不命中', () => {
    const cfg = { times: ['09:00', '15:00'] }
    expect(isDueMinute('daily', cfg, wc(9, 0))).toBe(true)
    expect(isDueMinute('daily', cfg, wc(15, 0))).toBe(true)
    expect(isDueMinute('daily', cfg, wc(9, 1))).toBe(false)
  })

  it('weekly：指定星期命中，其它星期不命中', () => {
    const cfg = { weekdays: [1, 3, 5], times: ['09:00'] }
    expect(isDueMinute('weekly', cfg, wc(9, 0, 1))).toBe(true)
    expect(isDueMinute('weekly', cfg, wc(9, 0, 3))).toBe(true)
    expect(isDueMinute('weekly', cfg, wc(9, 0, 7))).toBe(false)
  })

  it('monthly：指定日期命中，其它日期不命中', () => {
    const cfg = { days: [1, 15], times: ['09:00'] }
    expect(isDueMinute('monthly', cfg, wc(9, 0, 5, 15))).toBe(true)
    expect(isDueMinute('monthly', cfg, wc(9, 0, 5, 16))).toBe(false)
  })
})

describe('modeLabel / ruleText', () => {
  it('四种模式标签与摘要', () => {
    expect(modeLabel('interval')).toBe('每 N 小时')
    expect(modeLabel('daily')).toBe('每日')
    expect(modeLabel('weekly')).toBe('每周')
    expect(modeLabel('monthly')).toBe('每月')
    expect(ruleText('interval', { everyHours: 6 })).toBe('每 6 小时一次')
    expect(ruleText('daily', { times: ['09:00', '15:00'] })).toBe('09:00 / 15:00')
    expect(ruleText('weekly', { weekdays: [1, 3, 5], times: ['09:00'] })).toBe('周一、周三、周五 09:00')
    expect(ruleText('monthly', { days: [1, 15], times: ['10:30'] })).toBe('1、15 号 10:30')
  })
})

describe('nextRunText（下次执行墙上时间文本）', () => {
  it('daily：今天剩余时间点，已过则明天', () => {
    expect(nextRunText('daily', { times: ['09:00', '15:00'] }, TZ, new Date('2026-09-04T00:00:00Z'))).toBe('今天 09:00')
    expect(nextRunText('daily', { times: ['09:00', '15:00'] }, TZ, new Date('2026-09-04T08:30:00Z'))).toBe('明天 09:00')
  })

  it('interval：午夜对齐且排除 00:00', () => {
    expect(nextRunText('interval', { everyHours: 6 }, TZ, new Date('2026-09-03T23:59:00Z'))).toBe('今天 12:00')
    expect(nextRunText('interval', { everyHours: 6 }, TZ, new Date('2026-09-04T11:00:00Z'))).toBe('明天 06:00')
    expect(nextRunText('interval', { everyHours: 6 }, TZ, new Date('2026-09-03T16:00:00Z'))).toBe('今天 06:00')
  })

  it('weekly：扫描未来 7 天第一个匹配', () => {
    // 2026-09-04T02:00:00Z = 上海 周四 10:00
    expect(nextRunText('weekly', { weekdays: [1, 3, 5], times: ['09:00'] }, TZ, new Date('2026-09-04T02:00:00Z'))).toBe('明天 09:00')
    expect(nextRunText('weekly', { weekdays: [4], times: ['09:00'] }, TZ, new Date('2026-09-04T02:00:00Z'))).toBe('周四 09:00')
  })

  it('monthly：扫描未来 62 天；31 号在小月自动落到下月', () => {
    expect(nextRunText('monthly', { days: [1, 15], times: ['09:00'] }, TZ, new Date('2026-09-04T02:00:00Z'))).toBe('9月15日 09:00')
    // 2026-04-05 10:00（4 月无 31 号 → 5月31日，间隔 56 天，62 天扫描覆盖）
    expect(nextRunText('monthly', { days: [31], times: ['09:00'] }, TZ, new Date('2026-04-05T02:00:00Z'))).toBe('5月31日 09:00')
  })
})

describe('validateScheduleConfig', () => {
  it('四种合法配置返回 null', () => {
    expect(validateScheduleConfig('interval', { everyHours: 6 })).toBeNull()
    expect(validateScheduleConfig('daily', { times: ['09:00'] })).toBeNull()
    expect(validateScheduleConfig('weekly', { weekdays: [1, 7], times: ['09:00'] })).toBeNull()
    expect(validateScheduleConfig('monthly', { days: [1, 31], times: ['00:00'] })).toBeNull()
  })

  it('非法配置返回错误文案', () => {
    expect(validateScheduleConfig('interval', { everyHours: 0 })).toBeTruthy()
    expect(validateScheduleConfig('interval', { everyHours: 24 })).toBeTruthy()
    expect(validateScheduleConfig('daily', { times: [] })).toBeTruthy()
    expect(validateScheduleConfig('daily', { times: ['9:00'] })).toBeTruthy()
    expect(validateScheduleConfig('daily', { times: ['24:00'] })).toBeTruthy()
    expect(validateScheduleConfig('weekly', { weekdays: [], times: ['09:00'] })).toBeTruthy()
    expect(validateScheduleConfig('weekly', { weekdays: [8], times: ['09:00'] })).toBeTruthy()
    expect(validateScheduleConfig('monthly', { days: [32], times: ['09:00'] })).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: FAIL——`../src/engine/schedule` 模块不存在

- [ ] **Step 3: 实现** — 创建 `src/engine/schedule.ts`：

```ts
/**
 * 定时调度纯函数（engine 层）：计划时间语义的单一事实来源
 * 依赖方向：无业务依赖（仅 node 内置 Intl），被 scheduler.ts 与 server 路由依赖
 * 设计思路：全部判断在「配置时区的墙上时钟」上做匹配（不涉及 epoch 换算，DST 无影响）；
 * 星期 1=周一 … 7=周日（由年/月/日纯算得，不依赖 Intl 的星期输出避免 locale 差异）；
 * 四种模式：interval 每 N 小时（午夜对齐、排除 00:00）/ daily 每日多时间点 /
 * weekly 每周几+时间点 / monthly 每月几号+时间点（小月无该日自然跳过）
 */

/** 频率模式 */
export type ScheduleMode = 'interval' | 'daily' | 'weekly' | 'monthly'

/** 计划时间配置（对应 schedules.config JSON 的解析形态） */
export interface ScheduleConfig {
  /** interval：自 00:00 起每 N 小时（1–23） */
  everyHours?: number
  /** daily/weekly/monthly：'HH:mm' 列表（可多个时间点） */
  times?: string[]
  /** weekly：星期集合，1=周一 … 7=周日 */
  weekdays?: number[]
  /** monthly：每月几号集合（1–31） */
  days?: number[]
}

/** 配置时区的墙上时钟 */
export interface WallClock {
  year: number
  month: number
  day: number
  /** 1=周一 … 7=周日 */
  weekday: number
  hour: number
  minute: number
}

const WEEK_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

const pad = (n: number) => String(n).padStart(2, '0')

/** 由年月日纯算星期（1=周一 … 7=周日；用 UTC 避开本地时区影响） */
function weekdayOf(year: number, month: number, day: number): number {
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0=周日 … 6=周六
  return utcDay === 0 ? 7 : utcDay
}

/** 读某时刻在指定时区的墙上时钟（Intl formatToParts，无第三方依赖） */
export function wallClockIn(tz: string, now: Date = new Date()): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  let hour = get('hour')
  if (hour === 24) hour = 0 // 个别引擎午夜输出 24
  const year = get('year')
  const month = get('month')
  const day = get('day')
  return { year, month, day, weekday: weekdayOf(year, month, day), hour, minute }
}

const hmOf = (wc: WallClock) => `${pad(wc.hour)}:${pad(wc.minute)}`
const minuteOfDay = (wc: WallClock) => wc.hour * 60 + wc.minute

/** 当前分钟是否匹配计划（到点判断；不感知「已触发过」，去重由 Scheduler 负责） */
export function isDueMinute(mode: ScheduleMode, cfg: ScheduleConfig, wc: WallClock): boolean {
  if (mode === 'interval') {
    const n = (cfg.everyHours ?? 0) * 60
    const cur = minuteOfDay(wc)
    return n > 0 && cur > 0 && cur % n === 0
  }
  if (!cfg.times?.includes(hmOf(wc))) return false
  if (mode === 'daily') return true
  if (mode === 'weekly') return cfg.weekdays?.includes(wc.weekday) ?? false
  if (mode === 'monthly') return cfg.days?.includes(wc.day) ?? false
  return false
}

/** 模式徽标文案（面板与规则摘要共用） */
export function modeLabel(mode: ScheduleMode): string {
  return { interval: '每 N 小时', daily: '每日', weekly: '每周', monthly: '每月' }[mode]
}

/** 触发规则摘要文案（面板列表展示） */
export function ruleText(mode: ScheduleMode, cfg: ScheduleConfig): string {
  if (mode === 'interval') return `每 ${cfg.everyHours} 小时一次`
  const times = (cfg.times ?? []).join(' / ')
  if (mode === 'daily') return times
  if (mode === 'weekly') return `${(cfg.weekdays ?? []).map((d) => WEEK_NAMES[d]).join('、')} ${times}`
  return `${(cfg.days ?? []).join('、')} 号 ${times}`
}

/** 闰年判断（纯墙钟日期算术用） */
function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/** 下次执行的墙上时间文本（面板展示用，纯墙钟算术，不做 epoch 换算） */
export function nextRunText(mode: ScheduleMode, cfg: ScheduleConfig, tz: string, now: Date = new Date()): string {
  const wc = wallClockIn(tz, now)
  const cur = minuteOfDay(wc)
  if (mode === 'interval') {
    const n = (cfg.everyHours ?? 1) * 60
    // 候选点为 n, 2n, …（<= 1439 分钟，即排除 00:00）
    const maxK = Math.floor((24 * 60 - 1) / n)
    if (cur < maxK * n) {
      const next = Math.max(n, Math.ceil(cur / n) * n)
      return `今天 ${pad(Math.floor(next / 60))}:${pad(next % 60)}`
    }
    return `明天 ${pad(Math.floor(n / 60))}:${pad(n % 60)}`
  }
  const times = [...(cfg.times ?? [])].sort()
  const after = (off: number) => (off === 0 ? times.filter((t) => t > hmOf(wc)) : times)
  const first = (off: number) => after(off).sort()[0]
  if (mode === 'daily') {
    return first(0) ? `今天 ${first(0)}` : `明天 ${times[0]}`
  }
  if (mode === 'weekly') {
    for (let off = 0; off <= 7; off++) {
      const d = ((wc.weekday - 1 + off) % 7) + 1
      if (!cfg.weekdays?.includes(d)) continue
      const t = first(off)
      if (t) return `${off === 0 ? '今天' : off === 1 ? '明天' : WEEK_NAMES[d]} ${t}`
    }
    return '—'
  }
  // monthly：逐日推进墙钟日期（日/月/年进位），扫 62 天（覆盖 2 月初到 3 月 31 的最坏间隔）
  let y = wc.year
  let m = wc.month
  let d = wc.day
  for (let off = 0; off <= 62; off++) {
    const dayNum = d
    if (off > 0) {
      d += 1
      if (d > daysInMonth(y, m)) { d = 1; m += 1; if (m > 12) { m = 1; y += 1 } }
    }
    if (!cfg.days?.includes(dayNum)) continue
    const t = first(off)
    if (t) return `${off === 0 ? '今天' : off === 1 ? '明天' : `${m}月${d}日`} ${t}`
  }
  return '—'
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 校验计划配置；null = 合法，否则为中文错误文案（路由 400 用） */
export function validateScheduleConfig(mode: ScheduleMode, cfg: ScheduleConfig): string | null {
  if (mode === 'interval') {
    const n = cfg.everyHours
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 23) return '间隔小时数需为 1–23 的整数'
    return null
  }
  if (!Array.isArray(cfg.times) || cfg.times.length === 0) return '至少需要一个时间点'
  for (const t of cfg.times) {
    if (typeof t !== 'string' || !TIME_RE.test(t)) return `时间点格式非法（须为 HH:mm）: ${t}`
  }
  if (mode === 'weekly') {
    if (!Array.isArray(cfg.weekdays) || cfg.weekdays.length === 0) return '至少选择一个星期'
    for (const d of cfg.weekdays) {
      if (!Number.isInteger(d) || d < 1 || d > 7) return '星期取值须为 1–7'
    }
  }
  if (mode === 'monthly') {
    if (!Array.isArray(cfg.days) || cfg.days.length === 0) return '至少选择一个日期'
    for (const d of cfg.days) {
      if (!Number.isInteger(d) || d < 1 || d > 31) return '日期取值须为 1–31'
    }
  }
  return null
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: PASS（本任务全部用例；若某断言与实现不符，以测试为权威修正实现）

- [ ] **Step 5: 全量回归 + commit**

Run: `npm run typecheck` 然后 `npm test`
Expected: 全过

```bash
git add src/engine/schedule.ts tests/scheduler.test.ts
git commit -m "feat: 定时调度纯函数（墙上时钟/到点匹配/下次执行/校验）"
```

---

### Task 4: 引擎 Scheduler 类 — src/engine/scheduler.ts

**Files:**
- Create: `src/engine/scheduler.ts`
- Modify: `tests/scheduler.test.ts`（追加 Scheduler 类用例）

**Interfaces:**
- Consumes: Task 1 的 `ScheduleRow`/`BatchRow`、Task 3 的纯函数
- Produces（Task 5/6 依赖）:
  ```ts
  export interface RunNowResult {
    taskKeys: string[]                       // 实际入队的任务 key
    skipped: Array<{ taskKey: string; reason: 'unknown-task' | 'task-disabled' | 'in-flight' }>
  }
  export class Scheduler {
    constructor(deps: SchedulerDeps)
    start(): void   // setInterval(tick, tickMs).unref()
    stop(): void    // clearInterval
    tick(): Promise<void>                     // 扫描启用的计划，到点且未触发过则 fire
    runNow(schedule: ScheduleRow): Promise<RunNowResult>  // 面板「立即运行」（不受时间/去重限制）
  }
  export interface SchedulerDeps {
    db: {
      listSchedules(): Promise<ScheduleRow[]>
      getTaskEnabled(taskKey: string, fallback: boolean): Promise<boolean>
      countInFlightRuns(taskKey: string, date: string): Promise<number>
      createBatch(kind: 'schedule', taskKey: string, source: string): Promise<BatchRow>
      listProfiles(enabledOnly: boolean): Promise<ProfileRow[]>
    }
    enqueuer: { enqueue(profile: ProfileRow, taskKey: string, opts?: { immediate?: boolean; batchId?: number }): void; hasTaskInFlight(taskKey: string, profileId?: number): boolean }
    /** 任务注册表（engine 不得 import tasks 层：用结构类型收 SiteTask 的最小视图） */
    tasks: Map<string, { meta: TaskMeta }>
    logger: Logger
    timezone: string
    tickMs?: number
    now?: () => Date
  }
  ```

- [ ] **Step 1: 写失败测试** — 在 `tests/scheduler.test.ts` 顶部追加 import、底部追加 describe：

import 部分（与既有 import 合并后）：

```ts
import { vi, afterEach } from 'vitest'
import { Scheduler, type SchedulerDeps } from '../src/engine/scheduler'
import type { ScheduleRow } from '../src/infrastructure/db'
```

用例（追加到文件末尾）：

```ts
// ===== Scheduler 类（假 db/enqueuer，注入固定 now，不经真定时器）=====

const TZ2 = 'Asia/Shanghai'

function makeSchedule(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 1, name: '每日签到', enabled: 1, mode: 'daily',
    config: '{"times":["09:00"]}', taskKeys: '["task-a"]',
    createdAt: '2026-09-04 00:00:00.000', updatedAt: '2026-09-04 00:00:00.000',
    ...over,
  }
}

function makeDeps(over: Partial<SchedulerDeps> = {}) {
  const deps: SchedulerDeps = {
    db: {
      listSchedules: vi.fn().mockResolvedValue([]),
      getTaskEnabled: vi.fn().mockResolvedValue(true),
      countInFlightRuns: vi.fn().mockResolvedValue(0),
      createBatch: vi.fn().mockResolvedValue({ id: 88, kind: 'schedule', taskKey: 'task-a', source: '', createdAt: '' }),
      listProfiles: vi.fn().mockResolvedValue([{ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 }]),
    },
    enqueuer: { enqueue: vi.fn(), hasTaskInFlight: vi.fn().mockReturnValue(false) },
    tasks: new Map([['task-a', { meta: { key: 'task-a', name: '任务A', url: '' } }]]),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    timezone: TZ2,
    now: () => new Date('2026-09-04T01:00:30Z'), // 上海 09:00:30，命中 09:00
    ...over,
  }
  return deps
}

afterEach(() => vi.restoreAllMocks())

describe('Scheduler', () => {
  it('到点触发：建 schedule 批次并按启用窗口入队（不带 immediate）', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    const s = new Scheduler(deps)
    await s.tick()
    expect(deps.db.createBatch).toHaveBeenCalledWith('schedule', 'task-a', '计划#1 每日签到')
    expect(deps.enqueuer.enqueue).toHaveBeenCalledWith({ id: 1, bitbrowserId: 'bb-1', name: '窗口1', enabled: 1, circuitBreakerCount: 0 }, 'task-a', { batchId: 88 })
  })

  it('同一分钟只触发一次（去重 Map）', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    const s = new Scheduler(deps)
    await s.tick()
    await s.tick()
    expect(deps.db.createBatch).toHaveBeenCalledTimes(1)
  })

  it('分钟不匹配不触发', async () => {
    const deps = makeDeps({ now: () => new Date('2026-09-04T01:59:00Z') }) // 上海 09:59
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    const s = new Scheduler(deps)
    await s.tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
  })

  it('停用计划跳过', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule({ enabled: 0 })])
    await new Scheduler(deps).tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
  })

  it('任务 key 未注册 → 跳过并告警', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule({ taskKeys: '["ghost"]' })])
    const s = new Scheduler(deps)
    await s.tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('任务开关关闭（getTaskEnabled=false）→ 跳过', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    await new Scheduler(deps).tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()
  })

  it('在途守卫（DB 有在途 run 或队列在途）→ 跳过', async () => {
    const deps = makeDeps()
    deps.db.listSchedules.mockResolvedValue([makeSchedule()])
    deps.db.countInFlightRuns.mockResolvedValue(1)
    await new Scheduler(deps).tick()
    expect(deps.db.createBatch).not.toHaveBeenCalled()

    // 队列在途分支用独立实例（避免与上一个实例的去重 Map 冲突）
    const deps2 = makeDeps()
    deps2.db.listSchedules.mockResolvedValue([makeSchedule()])
    deps2.enqueuer.hasTaskInFlight.mockReturnValue(true)
    await new Scheduler(deps2).tick()
    expect(deps2.db.createBatch).not.toHaveBeenCalled()
  })

  it('runNow 不受时间与去重限制，直接触发', async () => {
    const deps = makeDeps({ now: () => new Date('2026-09-04T01:59:00Z') }) // 09:59 不到点
    const s = new Scheduler(deps)
    const result = await s.runNow(makeSchedule())
    expect(result.taskKeys).toEqual(['task-a'])
    expect(deps.db.createBatch).toHaveBeenCalledTimes(1)
    await s.runNow(makeSchedule())
    expect(deps.db.createBatch).toHaveBeenCalledTimes(2)
  })

  it('runNow 汇总跳过原因（停用任务）', async () => {
    const deps = makeDeps()
    deps.db.getTaskEnabled.mockResolvedValue(false)
    const result = await new Scheduler(deps).runNow(makeSchedule())
    expect(result.taskKeys).toEqual([])
    expect(result.skipped).toEqual([{ taskKey: 'task-a', reason: 'task-disabled' }])
  })

  it('start/stop 挂载与清除定时器', () => {
    const deps = makeDeps()
    const s = new Scheduler(deps)
    const setSpy = vi.spyOn(global, 'setInterval').mockReturnValue(123 as unknown as ReturnType<typeof setInterval>)
    const clearSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {})
    s.start()
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 15000)
    s.stop()
    expect(clearSpy).toHaveBeenCalledWith(123)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: FAIL——`../src/engine/scheduler` 模块不存在

- [ ] **Step 3: 实现** — 创建 `src/engine/scheduler.ts`：

```ts
/**
 * 定时调度器（engine 层）：自研 tick 调度（每 tickMs 扫一次启用计划）
 * 依赖方向：依赖 infrastructure 类型与 engine/schedule.ts 纯函数，不依赖 tasks 层；
 *           被 src/app.ts 装配、被 server 路由经 runNow 调用
 * 设计思路：无 cron 库——到点判断走 schedule.ts 的墙上时钟匹配；
 * 错过即跳过（无锚点持久化，重启后从当前时间自然重算）；
 * 每分钟去重 Map（内存态，重启同分钟可能重复触发一次，由队列合并与在途守卫兜底）；
 * 触发路径与手动批量触发同构：createBatch('schedule') → 全部启用窗口 enqueue（不带 immediate 沿用全局错峰）
 */
import type { BatchRow, ProfileRow, ScheduleRow } from '../infrastructure/db'
import type { Logger } from '../infrastructure/logger'
import type { TaskMeta } from './task'
import { wallClockIn, isDueMinute, type ScheduleConfig, type ScheduleMode } from './schedule'

/** 一次触发的任务级结果（面板「立即运行」与日志共用） */
export interface RunNowResult {
  /** 实际入队的任务 key */
  taskKeys: string[]
  /** 被跳过任务的明细 */
  skipped: Array<{ taskKey: string; reason: 'unknown-task' | 'task-disabled' | 'in-flight' }>
}

export interface SchedulerDeps {
  db: {
    listSchedules(): Promise<ScheduleRow[]>
    getTaskEnabled(taskKey: string, fallback: boolean): Promise<boolean>
    countInFlightRuns(taskKey: string, date: string): Promise<number>
    createBatch(kind: 'schedule', taskKey: string, source: string): Promise<BatchRow>
    listProfiles(enabledOnly: boolean): Promise<ProfileRow[]>
  }
  enqueuer: {
    enqueue(profile: ProfileRow, taskKey: string, opts?: { immediate?: boolean; batchId?: number }): void
    hasTaskInFlight(taskKey: string, profileId?: number): boolean
  }
  /** 任务注册表最小视图（engine 不得 import tasks 层，SiteTask 结构兼容） */
  tasks: Map<string, { meta: TaskMeta }>
  logger: Logger
  /** 固定时区（配置 scheduler.timezone） */
  timezone: string
  /** tick 间隔（毫秒，默认 15000） */
  tickMs?: number
  /** 当前时间来源（测试注入固定时钟；默认 Date.now） */
  now?: () => Date
}

/**
 * 自研 tick 定时调度器
 * tick：扫描启用计划 → 到点（墙上时钟匹配）且该分钟未触发 → fire；
 * fire：对计划内每个任务做守卫（注册/开关/在途）后建批次并全窗口入队；
 * runNow：面板「立即运行」入口，跳过时间与去重判断（守卫保留）
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  /** 每分钟去重：计划 id → 'YYYY-MM-DD HH:mm' */
  private lastFired = new Map<number, string>()

  constructor(private deps: SchedulerDeps) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.tick().catch((e) => {
        this.deps.logger.warn({ err: (e as Error).message }, '调度 tick 异常（下轮重试）')
      })
    }, this.deps.tickMs ?? 15000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 扫描启用计划并触发到点者（对外暴露便于测试直调） */
  async tick(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))()
    const wc = wallClockIn(this.deps.timezone, now)
    const minuteKey = `${wc.year}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')} ${String(wc.hour).padStart(2, '0')}:${String(wc.minute).padStart(2, '0')}`
    for (const s of await this.deps.db.listSchedules()) {
      if (s.enabled !== 1) continue
      if (this.lastFired.get(s.id) === minuteKey) continue
      const cfg = parseConfig(s, this.deps.logger)
      if (!cfg) continue
      if (!isDueMinute(s.mode as ScheduleMode, cfg, wc)) continue
      this.lastFired.set(s.id, minuteKey)
      await this.fire(s)
    }
  }

  /** 立即运行一个计划（面板「立即运行」；停用校验在路由层） */
  async runNow(schedule: ScheduleRow): Promise<RunNowResult> {
    return this.fire(schedule)
  }

  /** 触发计划内全部任务（任务级守卫逐个判定，不互相影响） */
  private async fire(schedule: ScheduleRow): Promise<RunNowResult> {
    const result: RunNowResult = { taskKeys: [], skipped: [] }
    let keys: unknown
    try {
      keys = JSON.parse(schedule.taskKeys)
    } catch {
      this.deps.logger.warn({ id: schedule.id }, '计划任务列表 JSON 非法，跳过整个计划')
      return result
    }
    for (const key of keys as string[]) {
      const skip = async (reason: RunNowResult['skipped'][number]['reason']) => {
        this.deps.logger.warn({ schedule: schedule.name, task: key, reason }, '定时触发跳过任务')
        result.skipped.push({ taskKey: key, reason })
      }
      const t = this.deps.tasks.get(key)
      if (!t) { await skip('unknown-task'); continue }
      // 面板运行时开关（task_states 覆盖 meta.enabled）与手动触发守卫同语义
      if (!(await this.deps.db.getTaskEnabled(key, t.meta.enabled ?? true))) { await skip('task-disabled'); continue }
      if ((await this.deps.db.countInFlightRuns(key, todayLocal())) > 0 || this.deps.enqueuer.hasTaskInFlight(key)) { await skip('in-flight'); continue }
      const batch = await this.deps.db.createBatch('schedule', key, `计划#${schedule.id} ${schedule.name}`)
      for (const p of await this.deps.db.listProfiles(true)) {
        this.deps.enqueuer.enqueue(p, key, { batchId: batch.id })
      }
      result.taskKeys.push(key)
      this.deps.logger.info({ schedule: schedule.name, task: key }, `定时触发已入队`)
    }
    return result
  }
}

/** 解析计划 config JSON；非法时告警并返回 null（跳过该计划） */
function parseConfig(s: ScheduleRow, logger: Logger): ScheduleConfig | null {
  try {
    return JSON.parse(s.config) as ScheduleConfig
  } catch {
    logger.warn({ id: s.id, name: s.name }, '计划配置 JSON 非法，跳过')
    return null
  }
}

/** 本地时区「今天」（与 db.countInFlightRuns 的 date 口径一致） */
function todayLocal(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: PASS（10 个新用例 + Task 3 用例全绿）

- [ ] **Step 5: 全量回归 + commit**

Run: `npm run typecheck` 然后 `npm test`
Expected: 全过

```bash
git add src/engine/scheduler.ts tests/scheduler.test.ts
git commit -m "feat: Scheduler tick 调度器（到点触发/去重/守卫/立即运行）"
```

---

### Task 5: server 路由 — schedules CRUD + 立即运行

**Files:**
- Modify: `src/server/http/errors.ts`（ERROR_CODES 加两条）
- Create: `src/server/routes/schedules.ts`
- Modify: `src/server/app.ts`（ServerDeps.scheduler + 挂载）
- Modify: `tests/web.test.ts`（MockDeps 补 mock + 新用例）

**Interfaces:**
- Consumes: Task 1 的 AppDb 方法、Task 3 纯函数、Task 4 的 `RunNowResult`
- Produces:
  - `ERROR_CODES.SCHEDULE_NOT_FOUND = 40406`、`ERROR_CODES.SCHEDULE_DISABLED = 40903`
  - `schedulesRouter(deps: { db: AppDb; scheduler: { runNow(s: ScheduleRow): Promise<RunNowResult> }; tasks: Map<string, SiteTask>; timezone: string }): Router`
  - API 契约（前端 Task 7/8 依赖）：
    - `GET /api/schedules` → data 为数组：`{ id, name, enabled, mode, config, taskKeys, taskNames, ruleText, nextRun, createdAt, updatedAt }`（config 为解析后的对象；taskNames 与 taskKeys 对齐，未知 key 为 null）
    - `POST /api/schedules` body `{ name, mode, config, taskKeys }` → data 为新建项视图；校验失败 400（业务码 40000）
    - `PATCH /api/schedules/:id` body 可含 `{ name?, enabled?, mode?, config?, taskKeys? }` → data 为更新后视图；不存在 404（40406）
    - `DELETE /api/schedules/:id` → data null；不存在 404（40406）
    - `POST /api/schedules/:id/run` → data 为 `RunNowResult`；不存在 404（40406）；已停用 409（40903）

- [ ] **Step 1: 写失败测试** — 修改 `tests/web.test.ts`：

1a. `MockDeps` 接口：`db` 块在 `listUnbatchedRuns: Mock` 行后加 5 行，`enqueuer` 行后加 `scheduler` 行，`cfg` 块加 `scheduler` 行：

```ts
    listUnbatchedRuns: Mock
    listSchedules: Mock
    getSchedule: Mock
    createSchedule: Mock
    updateSchedule: Mock
    deleteSchedule: Mock
  }
  enqueuer: { enqueue: Mock; hasTaskInFlight: Mock; pendingCount: Mock }
  scheduler: { runNow: Mock }
```

`cfg` 块里（`execution` 行后）加：

```ts
    scheduler: { timezone: string }
```

1b. `makeDeps()`：db 对象加 mock 默认值（`listUnbatchedRuns` 行后）：

```ts
      listUnbatchedRuns: vi.fn().mockResolvedValue([]),
      listSchedules: vi.fn().mockResolvedValue([]),
      getSchedule: vi.fn().mockResolvedValue(null),
      createSchedule: vi.fn().mockResolvedValue(null),
      updateSchedule: vi.fn().mockResolvedValue(null),
      deleteSchedule: vi.fn().mockResolvedValue(true),
```

enqueuer 行后加：

```ts
    scheduler: { runNow: vi.fn().mockResolvedValue({ taskKeys: ['t1'], skipped: [] }) },
```

cfg 对象加：

```ts
      scheduler: { timezone: 'Asia/Shanghai' },
```

1c. 在 describe 根块内（如 `batches API` describe 之后、`createApp` 顶层测试之前任意位置）追加新 describe：

```ts
  describe('schedules API', () => {
    const row = {
      id: 1, name: '每日签到', enabled: 1, mode: 'daily' as const,
      config: '{"times":["09:00"]}', taskKeys: '["t1"]',
      createdAt: '2026-09-04 00:00:00.000', updatedAt: '2026-09-04 00:00:00.000',
    }

    it('GET /api/schedules 返回视图（taskNames/ruleText/nextRun 已计算）', async () => {
      const deps = makeDeps()
      deps.db.listSchedules.mockResolvedValue([row])
      const res = await request(createApp(deps as never)).get('/api/schedules')
      expect(res.status).toBe(200)
      expect(res.body.code).toBe(0)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0]).toMatchObject({ id: 1, name: '每日签到', enabled: true, mode: 'daily', taskKeys: ['t1'], taskNames: ['任务1'], ruleText: '09:00' })
      expect(res.body.data[0].nextRun).toBeTruthy()
    })

    it('POST /api/schedules 合法配置创建成功', async () => {
      const deps = makeDeps()
      deps.db.createSchedule.mockResolvedValue(row)
      const res = await request(createApp(deps as never))
        .post('/api/schedules')
        .send({ name: '每日签到', mode: 'daily', config: { times: ['09:00'] }, taskKeys: ['t1'] })
      expect(res.status).toBe(200)
      expect(res.body.code).toBe(0)
      expect(deps.db.createSchedule).toHaveBeenCalledWith({ name: '每日签到', mode: 'daily', config: '{"times":["09:00"]}', taskKeys: '["t1"]' })
    })

    it('POST /api/schedules 非法配置/未知任务 400', async () => {
      const deps = makeDeps()
      const cases = [
        { name: '', mode: 'daily', config: { times: ['09:00'] }, taskKeys: ['t1'] },
        { name: 'x', mode: 'daily', config: { times: ['25:00'] }, taskKeys: ['t1'] },
        { name: 'x', mode: 'daily', config: { times: ['09:00'] }, taskKeys: ['ghost'] },
        { name: 'x', mode: 'bogus', config: { times: ['09:00'] }, taskKeys: ['t1'] },
      ]
      for (const body of cases) {
        const res = await request(createApp(deps as never)).post('/api/schedules').send(body)
        expect(res.status).toBe(400)
        expect(res.body.code).toBe(40000)
      }
      expect(deps.db.createSchedule).not.toHaveBeenCalled()
    })

    it('PATCH /api/schedules/:id 部分更新；不存在 404（40406）', async () => {
      const deps = makeDeps()
      deps.db.getSchedule.mockResolvedValue(row)
      deps.db.updateSchedule.mockResolvedValue({ ...row, enabled: 0 })
      const res = await request(createApp(deps as never)).patch('/api/schedules/1').send({ enabled: false })
      expect(res.status).toBe(200)
      expect(res.body.data.enabled).toBe(false)
      expect(deps.db.updateSchedule).toHaveBeenCalledWith(1, { enabled: false })

      deps.db.getSchedule.mockResolvedValue(null)
      const miss = await request(createApp(deps as never)).patch('/api/schedules/99').send({ enabled: true })
      expect(miss.status).toBe(404)
      expect(miss.body.code).toBe(40406)
    })

    it('DELETE /api/schedules/:id 成功与 404', async () => {
      const deps = makeDeps()
      deps.db.deleteSchedule.mockResolvedValue(true)
      const ok = await request(createApp(deps as never)).delete('/api/schedules/1')
      expect(ok.status).toBe(200)
      expect(ok.body.code).toBe(0)

      deps.db.deleteSchedule.mockResolvedValue(false)
      const miss = await request(createApp(deps as never)).delete('/api/schedules/99')
      expect(miss.status).toBe(404)
      expect(miss.body.code).toBe(40406)
    })

    it('POST /api/schedules/:id/run 成功转发 runNow；停用 409（40903）', async () => {
      const deps = makeDeps()
      deps.db.getSchedule.mockResolvedValue(row)
      const ok = await request(createApp(deps as never)).post('/api/schedules/1/run').send({})
      expect(ok.status).toBe(200)
      expect(deps.scheduler.runNow).toHaveBeenCalledWith(row)

      deps.db.getSchedule.mockResolvedValue({ ...row, enabled: 0 })
      const disabled = await request(createApp(deps as never)).post('/api/schedules/1/run').send({})
      expect(disabled.status).toBe(409)
      expect(disabled.body.code).toBe(40903)
    })
  })
```

注意：`makeDeps` 中 `createApp(deps as never)` 依赖 `ServerDeps` 含 `scheduler` 字段——Task 5 完成后 `deps as never` 依旧编译通过；但 `mockResolvedValue(row)` 里 `mode: 'daily' as const` 确保字面量类型。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/web.test.ts`
Expected: FAIL——`GET /api/schedules` 404 / 编译错误（scheduler 字段不存在）

- [ ] **Step 3: 实现**

3a. `src/server/http/errors.ts` 的 ERROR_CODES 在 `BATCH_NOT_FOUND` 行后加：

```ts
  SCHEDULE_NOT_FOUND: 40406,
```

`TASK_RUNNING` 行后加：

```ts
  SCHEDULE_DISABLED: 40903,
```

3b. 创建 `src/server/routes/schedules.ts`：

```ts
/**
 * 定时计划路由（server 层）：计划的 CRUD 与「立即运行」
 * 依赖方向：依赖 engine/infrastructure；被 server/app 装配
 * 设计思路：GET 返回面板视图（config 解析为对象、任务名与规则摘要、下次执行已算好）；
 * 写接口先校验（mode/config/taskKeys 与任务注册表），失败 400；触发委托 Scheduler.runNow
 */
import { Router } from 'express'
import { ok, asyncHandler } from '../http/response'
import { HttpError, ERROR_CODES } from '../http/errors'
import type { AppDb, ScheduleRow } from '../../infrastructure/db'
import type { SiteTask } from '../../tasks/base'
import { ruleText, nextRunText, validateScheduleConfig, type ScheduleConfig, type ScheduleMode } from '../../engine/schedule'
import type { RunNowResult } from '../../engine/scheduler'

const MODES: ScheduleMode[] = ['interval', 'daily', 'weekly', 'monthly']

/** 计划行 → 面板视图（config 解析 + 任务名 + 规则摘要 + 下次执行） */
function toView(deps: { tasks: Map<string, SiteTask>; timezone: string }, s: ScheduleRow) {
  const config = JSON.parse(s.config) as ScheduleConfig
  const taskKeys = JSON.parse(s.taskKeys) as string[]
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled === 1,
    mode: s.mode as ScheduleMode,
    config,
    taskKeys,
    taskNames: taskKeys.map((k) => deps.tasks.get(k)?.meta.name ?? null),
    ruleText: ruleText(s.mode as ScheduleMode, config),
    nextRun: nextRunText(s.mode as ScheduleMode, config, deps.timezone),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

/** 校验请求体并解析出写入参数；非法抛 400 */
function parseBody(deps: { tasks: Map<string, SiteTask> }, body: Record<string, unknown>, existing?: ScheduleRow): { name?: string; enabled?: boolean; mode?: ScheduleMode; config?: ScheduleConfig; taskKeys?: string[] } {
  const out: { name?: string; enabled?: boolean; mode?: ScheduleMode; config?: ScheduleConfig; taskKeys?: string[] } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, '计划名称不能为空')
    out.name = body.name.trim()
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'enabled 必须为布尔值')
    out.enabled = body.enabled
  }
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode as ScheduleMode)) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'mode 非法')
    out.mode = body.mode as ScheduleMode
  }
  if (body.config !== undefined) {
    out.config = body.config as ScheduleConfig
  }
  if (body.taskKeys !== undefined) {
    if (!Array.isArray(body.taskKeys) || body.taskKeys.length === 0 || !body.taskKeys.every((k) => typeof k === 'string')) {
      throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKeys 必须为非空字符串数组')
    }
    out.taskKeys = body.taskKeys as string[]
  } else if (!existing) {
    throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'taskKeys 必填')
  }
  // 合成最终 mode/config 做整体校验（新建与局部更新同规则）
  const finalMode = out.mode ?? (existing?.mode as ScheduleMode | undefined)
  const finalConfig = out.config ?? (existing ? (JSON.parse(existing.config) as ScheduleConfig) : undefined)
  if (!finalMode) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, 'mode 必填')
  const err = validateScheduleConfig(finalMode, finalConfig ?? {})
  if (err) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, err)
  // 任务 key 必须已注册（与手动触发同守卫，不引用幽灵任务）
  if (out.taskKeys !== undefined) {
    for (const k of out.taskKeys) {
      if (!deps.tasks.has(k)) throw new HttpError(400, ERROR_CODES.INVALID_ARGUMENT, `任务不存在: ${k}`)
    }
  }
  return out
}

export function schedulesRouter(deps: { db: AppDb; scheduler: { runNow(s: ScheduleRow): Promise<RunNowResult> }; tasks: Map<string, SiteTask>; timezone: string }): Router {
  const router = Router()
  router.get('/schedules', asyncHandler(async (_req, res) => {
    const list = []
    for (const s of await deps.db.listSchedules()) {
      try {
        list.push(toView(deps, s))
      } catch {
        // 落库 JSON 损坏的计划跳过展示（防御；正常写入路径不会产生）
      }
    }
    ok(res, list)
  }))
  router.post('/schedules', asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const parsed = parseBody(deps, body)
    const s = await deps.db.createSchedule({
      name: parsed.name!,
      mode: parsed.mode!,
      config: JSON.stringify(parsed.config),
      taskKeys: JSON.stringify(parsed.taskKeys),
    })
    ok(res, toView(deps, s))
  }))
  router.patch('/schedules/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, ERROR_CODES.SCHEDULE_NOT_FOUND, '计划不存在')
    const existing = await deps.db.getSchedule(id)
    if (!existing) throw new HttpError(404, ERROR_CODES.SCHEDULE_NOT_FOUND, '计划不存在')
    const parsed = parseBody(deps, (req.body ?? {}) as Record<string, unknown>, existing)
    const s = await deps.db.updateSchedule(id, {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      ...(parsed.config !== undefined ? { config: JSON.stringify(parsed.config) } : {}),
      ...(parsed.taskKeys !== undefined ? { taskKeys: JSON.stringify(parsed.taskKeys) } : {}),
    })
    ok(res, toView(deps, s!))
  }))
  router.delete('/schedules/:id', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const deleted = Number.isInteger(id) && id > 0 ? await deps.db.deleteSchedule(id) : false
    if (!deleted) throw new HttpError(404, ERROR_CODES.SCHEDULE_NOT_FOUND, '计划不存在')
    ok(res, null)
  }))
  router.post('/schedules/:id/run', asyncHandler(async (req, res) => {
    const id = Number(req.params.id)
    const s = Number.isInteger(id) && id > 0 ? await deps.db.getSchedule(id) : null
    if (!s) throw new HttpError(404, ERROR_CODES.SCHEDULE_NOT_FOUND, '计划不存在')
    if (s.enabled !== 1) throw new HttpError(409, ERROR_CODES.SCHEDULE_DISABLED, '计划已停用')
    ok(res, await deps.scheduler.runNow(s))
  }))
  return router
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/web.test.ts`
Expected: PASS（原有用例 + 6 个新用例全绿）

- [ ] **Step 5: 全量回归 + commit**

Run: `npm run typecheck` 然后 `npm test`
Expected: 全过

```bash
git add src/server/http/errors.ts src/server/routes/schedules.ts tests/web.test.ts
git commit -m "feat: 定时计划 CRUD 与立即运行路由"
```

---

### Task 6: 装配 — app.ts Scheduler + server/app.ts 挂载

**Files:**
- Modify: `src/server/app.ts`（ServerDeps.scheduler 类型 + import + 挂载 schedulesRouter）
- Modify: `src/app.ts`（创建 Scheduler、start、优雅退出 stop、注入 createApp）

**Interfaces:**
- Consumes: Task 4 的 `Scheduler`/`RunNowResult`、Task 5 的 `schedulesRouter` 签名
- Produces: 完整运行链路（重启即生效）

- [ ] **Step 1: 修改 `src/server/app.ts`**

1a. import 区（`import type { SiteTask } from '../tasks/base'` 之后）加：

```ts
import type { ScheduleRow } from '../infrastructure/db'
import type { RunNowResult } from '../engine/scheduler'
import { schedulesRouter } from './routes/schedules'
```

1b. `ServerDeps` 接口（`tasks` 行后）加：

```ts
  /** 定时调度器（面板「立即运行」入口；Scheduler.runNow 的薄代理） */
  scheduler: { runNow(schedule: ScheduleRow): Promise<RunNowResult> }
```

1c. 挂载（`api.use(settingsRouter(...))` 行之后加）：

```ts
  api.use(schedulesRouter({ db: deps.db, scheduler: deps.scheduler, tasks: deps.tasks, timezone: deps.cfg.scheduler.timezone }))
```

- [ ] **Step 2: 修改 `src/app.ts`**

2a. import 区（`import { recoverRetryTasks } ...` 行后）加：

```ts
import { Scheduler } from './engine/scheduler'
```

2b. `enqueuer = new CoalescingEnqueuer(...)` 行之后、`const app = createApp({` 之前插入：

```ts
  // 定时调度器：自研 tick（每 15 秒扫一次 schedules 表）；触发路径与批量手动同构
  // （建 schedule 批次 + 全部启用窗口入队，不带 immediate 沿用全局错峰）
  const scheduler = new Scheduler({ db, enqueuer, tasks, logger, timezone: cfg.scheduler.timezone })
  scheduler.start()
```

2c. `createApp` 调用里（`enqueuer,` 行后）加：

```ts
    scheduler: { runNow: (s) => scheduler.runNow(s) },
```

2d. `shutdown` 函数（`logger.info('正在关闭...')` 之前）加：

```ts
    scheduler.stop()
```

- [ ] **Step 3: 验证**

Run: `npm run typecheck` 然后 `npm test` 然后 `npm run test:web`
Expected: 全过

- [ ] **Step 4: commit**

```bash
git add src/server/app.ts src/app.ts
git commit -m "feat: 装配定时调度器（启动 tick、优雅退出、路由注入）"
```

---

### Task 7: 前端基础 — endpoints/schema/types/看板徽标

**Files:**
- Modify: `web/src/api/client.ts`（加 `del`）
- Modify: `web/src/api/schema.d.ts`（手补 /api/schedules 路径 + kind 联合类型加 'schedule'）
- Modify: `web/src/api/endpoints.ts`（加 5 个函数）
- Modify: `web/src/types.ts`（加 `ScheduleItem`）
- Modify: `web/src/pages/dashboard/index.tsx`（KIND_TAG 加 schedule）
- Modify: `web/src/pages/dashboard/groupBatches.test.ts`（加 schedule 分流用例）

**Interfaces:**
- Produces（Task 8 依赖）:
  ```ts
  // endpoints.ts
  export const fetchSchedules = () => get<ScheduleItem[]>('/api/schedules')
  export const createSchedule = (body: { name: string; mode: ScheduleModeT; config: ScheduleConfigInput; taskKeys: string[] }) => post<ScheduleItem>('/api/schedules', body)
  export const updateSchedule = (id: number, body: Partial<{ name: string; enabled: boolean; mode: ScheduleModeT; config: ScheduleConfigInput; taskKeys: string[] }>) => patch<ScheduleItem>(`/api/schedules/${id}`, body)
  export const deleteSchedule = (id: number) => del<null>(`/api/schedules/${id}`)
  export const runSchedule = (id: number) => post<RunNowResultT>(`/api/schedules/${id}/run`, {})
  // types.ts
  export type ScheduleItem = EnvelopeData<'/api/schedules'>[number]
  ```

- [ ] **Step 1: 改 `web/src/api/client.ts`**（`patch` 行后加）：

```ts
export const del = <T>(path: string) => request<T>(path, { method: 'DELETE' })
```

- [ ] **Step 2: 手补 `web/src/api/schema.d.ts`**

2a. 两处 `kind?: "bulk" | "single";` 改为 `kind?: "bulk" | "single" | "schedule";`（第 815、884 行附近）。

2b. 在 `paths` 接口的 `"/api/tasks"` 条目之前插入（结构仿照现有条目，所有字段可选）：

```ts
    "/api/schedules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** 定时计划列表（面板视图） */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 计划列表 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @example 0 */
                            code?: number;
                            /** @example ok */
                            message?: string;
                            data?: {
                                id?: number;
                                name?: string;
                                enabled?: boolean;
                                mode?: "interval" | "daily" | "weekly" | "monthly";
                                config?: {
                                    everyHours?: number | null;
                                    times?: string[] | null;
                                    weekdays?: number[] | null;
                                    days?: number[] | null;
                                };
                                taskKeys?: string[];
                                /** @description 与 taskKeys 对齐的任务显示名，未知 key 为 null */
                                taskNames?: (string | null)[];
                                /** @description 触发规则摘要 */
                                ruleText?: string;
                                /** @description 下次执行的墙上时间文本 */
                                nextRun?: string;
                                createdAt?: string;
                                updatedAt?: string;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        /** 新建定时计划 */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name?: string;
                        mode?: "interval" | "daily" | "weekly" | "monthly";
                        config?: {
                            everyHours?: number | null;
                            times?: string[] | null;
                            weekdays?: number[] | null;
                            days?: number[] | null;
                        };
                        taskKeys?: string[];
                    };
                };
            };
            responses: {
                /** @description 新建成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                            data?: {
                                id?: number;
                                name?: string;
                                enabled?: boolean;
                                mode?: string;
                                config?: {
                                    everyHours?: number | null;
                                    times?: string[] | null;
                                    weekdays?: number[] | null;
                                    days?: number[] | null;
                                };
                                taskKeys?: string[];
                                taskNames?: (string | null)[];
                                ruleText?: string;
                                nextRun?: string;
                                createdAt?: string;
                                updatedAt?: string;
                            };
                        };
                    };
                };
                /** @description 参数校验失败 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/schedules/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 删除成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                        };
                    };
                };
                /** @description 计划不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name?: string;
                        enabled?: boolean;
                        mode?: "interval" | "daily" | "weekly" | "monthly";
                        config?: {
                            everyHours?: number | null;
                            times?: string[] | null;
                            weekdays?: number[] | null;
                            days?: number[] | null;
                        };
                        taskKeys?: string[];
                    };
                };
            };
            responses: {
                /** @description 更新成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                            data?: {
                                id?: number;
                                name?: string;
                                enabled?: boolean;
                                mode?: string;
                                config?: {
                                    everyHours?: number | null;
                                    times?: string[] | null;
                                    weekdays?: number[] | null;
                                    days?: number[] | null;
                                };
                                taskKeys?: string[];
                                taskNames?: (string | null)[];
                                ruleText?: string;
                                nextRun?: string;
                                createdAt?: string;
                                updatedAt?: string;
                            };
                        };
                    };
                };
                /** @description 参数校验失败 */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                        };
                    };
                };
                /** @description 计划不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/schedules/{id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description 触发成功 */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                            data?: {
                                taskKeys?: string[];
                                skipped?: {
                                    taskKey?: string;
                                    reason?: "unknown-task" | "task-disabled" | "in-flight";
                                }[];
                            };
                        };
                    };
                };
                /** @description 计划不存在 */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                        };
                    };
                };
                /** @description 计划已停用 */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code?: number;
                            message?: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
```

- [ ] **Step 3: 改 `web/src/api/endpoints.ts`**（import 补 `del`；文件末尾加）：

```ts
import { get, post, patch, del } from './client'
import type { ScheduleItem, ScheduleConfigInput } from '../types'

export const fetchSchedules = () => get<ScheduleItem[]>('/api/schedules')
export const createSchedule = (body: { name: string; mode: ScheduleItem['mode']; config: ScheduleConfigInput; taskKeys: string[] }) => post<ScheduleItem>('/api/schedules', body)
export const updateSchedule = (id: number, body: Partial<{ name: string; enabled: boolean; mode: ScheduleItem['mode']; config: ScheduleConfigInput; taskKeys: string[] }>) => patch<ScheduleItem>(`/api/schedules/${id}`, body)
export const deleteSchedule = (id: number) => del<null>(`/api/schedules/${id}`)
export const runSchedule = (id: number) => post<{ taskKeys: string[]; skipped: Array<{ taskKey: string; reason: string }> }>(`/api/schedules/${id}/run`, {})
```

- [ ] **Step 4: 改 `web/src/types.ts`**（`TaskMetaView` 行后加）：

```ts
// 定时计划视图：与 /api/schedules envelope data 一致（config 已解析为对象）
export type ScheduleItem = EnvelopeData<'/api/schedules'>[number]

// 计划时间配置的写入形态（创建/更新接口入参；视图侧 config 因 DeepRequired 各字段必填可空）
export type ScheduleConfigInput = {
  everyHours?: number
  times?: string[]
  weekdays?: number[]
  days?: number[]
}
```

- [ ] **Step 5: 改 `web/src/pages/dashboard/index.tsx`**（KIND_TAG）：

```ts
const KIND_TAG: Record<BatchItem['kind'], { label: string; color: string }> = {
  bulk: { label: '批量 · 全部窗口', color: 'blue' },
  single: { label: '单窗口', color: 'default' },
  schedule: { label: '定时', color: 'purple' },
}
```

- [ ] **Step 6: 改 `web/src/pages/dashboard/groupBatches.test.ts`** — 在 `splitBatches 散批聚合` describe 内追加用例（`makeBatch` 与 `splitBatches` 为文件内既有辅助）：

```ts
  it('kind=schedule 归入 bulk 主列表', () => {
    const { bulk, single } = splitBatches([
      makeBatch({ id: 5, kind: 'schedule', source: '计划#1 每日签到' }),
    ])
    expect(bulk.map((b) => b.id)).toEqual([5])
    expect(single).toHaveLength(0)
  })
```

- [ ] **Step 7: 验证 + commit**

Run: `npm run test:web` 然后 `npm run typecheck`（web 目录：`npm --prefix web run build` 也可验证前端编译）
Expected: 全过

```bash
git add web/src/api/client.ts web/src/api/schema.d.ts web/src/api/endpoints.ts web/src/types.ts web/src/pages/dashboard/index.tsx web/src/pages/dashboard/groupBatches.test.ts
git commit -m "feat: 前端 API 客户端与类型支持定时计划，看板批次加定时徽标"
```

---

### Task 8: 前端页面 — web/src/pages/schedules/

**Files:**
- Create: `web/src/pages/schedules/hooks.ts`
- Create: `web/src/pages/schedules/hooks.test.ts`
- Create: `web/src/pages/schedules/index.tsx`
- Modify: `web/src/App.tsx`（路由 + import）
- Modify: `web/src/layouts/AppLayout.tsx`（菜单项 + icon import）

**Interfaces:**
- Consumes: Task 7 的 endpoints 与 `ScheduleItem`
- Produces: `/schedules` 页面（列表 + 新建/编辑弹窗：先模式 → 动态参数 → 选任务；立即运行/删除/启用开关）

- [ ] **Step 1: 写失败测试** — 创建 `web/src/pages/schedules/hooks.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { modeLabel, MODE_OPTIONS } from './hooks'

describe('modeLabel', () => {
  it('四种模式中文标签', () => {
    expect(modeLabel('interval')).toBe('每 N 小时')
    expect(modeLabel('daily')).toBe('每日')
    expect(modeLabel('weekly')).toBe('每周')
    expect(modeLabel('monthly')).toBe('每月')
  })
})

describe('MODE_OPTIONS', () => {
  it('四个选项且值与后端模式一致', () => {
    expect(MODE_OPTIONS.map((o) => o.value)).toEqual(['interval', 'daily', 'weekly', 'monthly'])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --prefix web exec vitest run src/pages/schedules/hooks.test.ts`
Expected: FAIL——`./hooks` 不存在

- [ ] **Step 3: 实现 `hooks.ts`** — 创建 `web/src/pages/schedules/hooks.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { fetchSchedules, createSchedule, updateSchedule, deleteSchedule, runSchedule } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { ScheduleItem, ScheduleConfigInput } from '../../types'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

export type ScheduleMode = ScheduleItem['mode']

/** 频率模式选项（弹窗 Segmented 与摘要徽标共用；顺序即表单展示顺序） */
export const MODE_OPTIONS: Array<{ label: string; value: ScheduleMode }> = [
  { label: '每 N 小时', value: 'interval' },
  { label: '每日', value: 'daily' },
  { label: '每周', value: 'weekly' },
  { label: '每月', value: 'monthly' },
]

/** 模式徽标文案（未知模式回退原文） */
export function modeLabel(mode: ScheduleMode): string {
  return MODE_OPTIONS.find((o) => o.value === mode)?.label ?? mode
}

/** 星期选项（1=周一 … 7=周日，与后端一致） */
export const WEEKDAY_OPTIONS = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 7 },
]

/** 几号选项（1–31） */
export const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ label: `${i + 1} 号`, value: i + 1 }))

export function useSchedules() {
  return useQuery({
    queryKey: ['schedules'],
    queryFn: fetchSchedules,
    refetchInterval: 15000,
  })
}

export function useCreateSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createSchedule,
    onSuccess: (_res, body) => {
      message.success(`已创建计划「${body.name}」`)
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useUpdateSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<{ name: string; enabled: boolean; mode: ScheduleItem['mode']; config: ScheduleConfigInput; taskKeys: string[] }> }) => updateSchedule(id, body),
    onSuccess: () => {
      message.success('已更新计划')
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useDeleteSchedule() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteSchedule,
    onSuccess: () => {
      message.success('已删除计划')
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

export function useRunSchedule() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: runSchedule,
    onSuccess: (res) => {
      if (res.skipped.length > 0) {
        message.warning(`已触发 ${res.taskKeys.length} 个任务，跳过 ${res.skipped.length} 个（在途/停用）`)
      } else {
        message.success(`已触发 ${res.taskKeys.length} 个任务`)
      }
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm --prefix web exec vitest run src/pages/schedules/hooks.test.ts`
Expected: PASS

- [ ] **Step 5: 实现 `index.tsx`** — 创建 `web/src/pages/schedules/index.tsx`：

```tsx
import { useState } from 'react'
import {
  App, Button, Card, Empty, Form, Input, InputNumber, Modal, Popconfirm,
  Segmented, Select, Space, Switch, Table, Tag, TimePicker, Typography,
} from 'antd'
import { ClockCircleOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import {
  MODE_OPTIONS, WEEKDAY_OPTIONS, DAY_OPTIONS, modeLabel,
  useSchedules, useCreateSchedule, useUpdateSchedule, useDeleteSchedule, useRunSchedule,
  type ScheduleMode,
} from './hooks'
import { useTasks } from '../tasks/hooks'
import type { ScheduleItem, ScheduleConfigInput } from '../../types'

/** 弹窗表单值（times 为 dayjs 列表，提交时转 'HH:mm' 字符串；everyHours 可 null 与视图类型对齐） */
interface FormValues {
  name: string
  mode: ScheduleMode
  everyHours?: number | null
  weekdays?: number[]
  days?: number[]
  times?: Dayjs[]
  taskKeys: string[]
}

function buildPayload(values: FormValues): { name: string; mode: ScheduleMode; config: ScheduleConfigInput; taskKeys: string[] } {
  const base = { name: values.name, taskKeys: values.taskKeys, mode: values.mode }
  if (values.mode === 'interval') return { ...base, config: { everyHours: values.everyHours ?? 6 } }
  const times = (values.times ?? []).map((t) => t.format('HH:mm')).sort()
  if (values.mode === 'daily') return { ...base, config: { times } }
  if (values.mode === 'weekly') return { ...base, config: { weekdays: values.weekdays ?? [], times } }
  return { ...base, config: { days: values.days ?? [], times } }
}

export default function SchedulesPage() {
  const { message } = App.useApp()
  const { data: schedules, isLoading } = useSchedules()
  const { data: tasks } = useTasks()
  const create = useCreateSchedule()
  const update = useUpdateSchedule()
  const remove = useDeleteSchedule()
  const run = useRunSchedule()

  const [form] = Form.useForm<FormValues>()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduleItem | null>(null)
  const mode = Form.useWatch('mode', form) ?? 'daily'

  const taskOptions = (tasks ?? []).map((t) => ({ label: t.name, value: t.key }))

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ mode: 'daily', times: [dayjs('09:00', 'HH:mm')], taskKeys: [] })
    setOpen(true)
  }

  const openEdit = (s: ScheduleItem) => {
    setEditing(s)
    form.resetFields()
    form.setFieldsValue({
      name: s.name,
      mode: s.mode,
      everyHours: s.config.everyHours,
      weekdays: s.config.weekdays ?? [],
      days: s.config.days ?? [],
      times: (s.config.times ?? []).map((t) => dayjs(t, 'HH:mm')),
      taskKeys: s.taskKeys,
    })
    setOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    const payload = buildPayload(values)
    if (editing) {
      update.mutate({ id: editing.id, body: payload }, { onSuccess: () => setOpen(false) })
    } else {
      create.mutate(payload, { onSuccess: () => setOpen(false) })
    }
  }

  const columns = [
    { title: '计划名称', dataIndex: 'name', render: (n: string) => <Typography.Text strong>{n}</Typography.Text> },
    {
      title: '触发规则', dataIndex: 'ruleText', render: (_: string, s: ScheduleItem) => (
        <Space size={6}><Tag color="blue">{modeLabel(s.mode)}</Tag><span>{s.ruleText}</span></Space>
      ),
    },
    { title: '下次执行', dataIndex: 'nextRun', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
    {
      title: '关联任务', dataIndex: 'taskNames', render: (names: Array<string | null>) => (
        <Space size={4} wrap>{names.map((n, i) => (n ? <Tag key={i}>{n}</Tag> : <Tag key={i} color="red">未知任务</Tag>))}</Space>
      ),
    },
    {
      title: '启用', dataIndex: 'enabled', width: 80, render: (v: boolean, s: ScheduleItem) => (
        <Switch size="small" checked={v} onChange={(checked) => update.mutate({ id: s.id, body: { enabled: checked } })} />
      ),
    },
    {
      title: '操作', width: 200, render: (_: unknown, s: ScheduleItem) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<ClockCircleOutlined />} loading={run.isPending && run.variables === s.id} disabled={!s.enabled} onClick={() => run.mutate(s.id)}>立即运行</Button>
          <Button type="link" size="small" onClick={() => openEdit(s)}>编辑</Button>
          <Popconfirm title={`删除计划「${s.name}」？`} onConfirm={() => remove.mutate(s.id)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="定时任务"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建计划</Button>}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        独立调度子系统：先配时间，再选任务。到点对全部启用窗口入队（沿用全局错峰），错过不补跑，任务在途则跳过。
      </Typography.Paragraph>
      <Table<ScheduleItem>
        rowKey="id"
        size="middle"
        loading={isLoading}
        dataSource={schedules}
        columns={columns}
        pagination={false}
        locale={{ emptyText: <Empty description="暂无计划，点击右上角新建" /> }}
      />

      <Modal
        title={editing ? `编辑计划 · ${editing.name}` : '新建计划'}
        open={open}
        onOk={submit}
        confirmLoading={create.isPending || update.isPending}
        onCancel={() => setOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ mode: 'daily', everyHours: 6, times: [dayjs('09:00', 'HH:mm')], taskKeys: [] }}>
          <Form.Item name="name" label="计划名称" rules={[{ required: true, message: '请填写计划名称' }]}>
            <Input placeholder="例如：每日签到集合" maxLength={30} />
          </Form.Item>
          <Form.Item name="mode" label="频率模式">
            <Segmented options={MODE_OPTIONS} />
          </Form.Item>

          {mode === 'interval' && (
            <Form.Item name="everyHours" label="执行间隔" rules={[{ required: true, message: '请填写间隔小时数' }]}>
              <InputNumber min={1} max={23} addonAfter="小时一次（自 00:00 起算）" style={{ width: 260 }} />
            </Form.Item>
          )}

          {mode === 'weekly' && (
            <Form.Item name="weekdays" label="星期" rules={[{ required: true, message: '至少选择一个星期' }]}>
              <Select mode="multiple" options={WEEKDAY_OPTIONS} placeholder="可多选" />
            </Form.Item>
          )}

          {mode === 'monthly' && (
            <Form.Item name="days" label="每月几号" rules={[{ required: true, message: '至少选择一个日期' }]}>
              <Select mode="multiple" options={DAY_OPTIONS} placeholder="可多选（小月无该日自动跳过）" />
            </Form.Item>
          )}

          {mode !== 'interval' && (
            <Form.Item label="执行时间点">
              <Form.List name="times" rules={[{ validator: async (_, value) => { if (!value || value.length === 0) throw new Error('至少一个时间点') } }]}>
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name }) => (
                      <Space key={key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                        <Form.Item name={name} rules={[{ required: true, message: '请选择时间' }]} style={{ marginBottom: 0 }}>
                          <TimePicker format="HH:mm" />
                        </Form.Item>
                        <Button size="small" danger onClick={() => remove(name)}>删除</Button>
                      </Space>
                    ))}
                    <Button type="dashed" onClick={() => add(dayjs('09:00', 'HH:mm'))} block>
                      + 添加时间点
                    </Button>
                  </>
                )}
              </Form.List>
            </Form.Item>
          )}

          <Form.Item name="taskKeys" label="选择任务（到点后依次触发）" rules={[{ required: true, message: '至少选择一个任务' }]}>
            <Select mode="multiple" options={taskOptions} placeholder="多选任务" optionFilterProp="label" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
```

- [ ] **Step 6: 路由与菜单**

6a. `web/src/App.tsx`：import 区（`TasksPage` 行后）加 `import SchedulesPage from './pages/schedules'`；Routes 里（`tasks` 路由后）加 `<Route path="schedules" element={<SchedulesPage />} />`。

6b. `web/src/layouts/AppLayout.tsx`：icon import 加 `ScheduleOutlined`（`@ant-design/icons` 导入行内）；`menuItems` 数组在「任务」与「文档」之间加：

```ts
  { key: '/schedules', icon: <ScheduleOutlined />, label: '定时任务' },
```

- [ ] **Step 7: 验证 + commit**

Run: `npm run test:web` 然后 `npm run typecheck`，再 `npm --prefix web run build`
Expected: 全过（build 保证 JSX 类型无误）

```bash
git add web/src/pages/schedules web/src/App.tsx web/src/layouts/AppLayout.tsx
git commit -m "feat: 面板新增定时任务页面（列表+弹窗表单+立即运行）"
```

---

### Task 9: 文档 — API-GUIDE 与 AGENTS.md

**Files:**
- Modify: `docs/API-GUIDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: API-GUIDE.md**

1a. 第 7 章开头句（现为「系统**没有定时调度**：任务全部由人在面板上手动触发，或由失败重试机制自动补跑（重试与调度器无关）。」）替换为：

```md
系统有两类触发：**手动触发**（面板按钮）与**定时计划**（见第 8 章——到点自动触发，与手动共用守卫/熔断语义）。失败重试机制自动补跑与二者都无关（重试只补「同一轮次」）。
```

1b. 在第 7 章结束（`### 面板运行时覆盖` 小节之后）、`## 8. 配置与面板` 之前，插入新章节，并把后续章节号顺延（8→9、9→10、10→11，共 3 处标题改写）：

```md
## 8. 定时任务（计划）

### 心智模型

- **计划（schedule）与任务完全解耦**：一份「时间配置 + 任务列表」就是一条计划，存本地库 `schedules` 表，面板「定时任务」栏目管理，无需改代码重启
- **触发范围**：到点对**全部启用窗口**入队，与任务页「立即触发」同构（沿用全局错峰 `execution.staggerMaxSec`）
- **错过即跳过**：机器没开机/进程没跑，错过的触发不补跑（无锚点持久化，重启后从当前时间自然重算）
- **在途则跳过**：到点时任务已有在途运行（手动触发/重试中/另一计划），跳过该任务并记日志——与手动触发的 409 守卫同语义
- **熔断共用**：定时触发的失败同样计入窗口熔断（连续 2 次失败当日熔断，之后含手动在内全部 skipped，需在窗口页重置）

### 四种频率模式

| 模式 | 配置 | 语义 |
|---|---|---|
| `interval` | `everyHours` 1–23 | 自 00:00 起每 N 小时（06:00/12:00/18:00…；00:00 不触发） |
| `daily` | `times` 多个 `HH:mm` | 每日各时间点各触发一次 |
| `weekly` | `weekdays`（1=周一…7=周日）+ `times` | 每周指定星期的时间点 |
| `monthly` | `days`（1–31）+ `times` | 每月指定日期的时间点；小月无该日（如 31 号）自然跳过 |

时区：固定 `config/config.json` 的 `scheduler.timezone`（默认 `Asia/Shanghai`），面板「下次执行」显示按此时区计算。

### REST 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/schedules` | 计划列表（含 `ruleText` 摘要、`nextRun` 下次执行、`taskNames`） |
| POST | `/api/schedules` | 新建：`{ name, mode, config, taskKeys }`；校验失败 400 |
| PATCH | `/api/schedules/:id` | 改名称/开关/配置/任务列表（可部分）；不存在 404（40406） |
| DELETE | `/api/schedules/:id` | 删除；不存在 404（40406） |
| POST | `/api/schedules/:id/run` | 「立即运行一次」：跳过时间判断直接触发（守卫保留）；停用 409（40903） |

### 面板使用

定时任务页：新建计划 → 先选频率模式 → 按模式填参数（间隔小时数 / 时间点 / 星期 / 几号）→ 多选任务 → 保存。列表行内可开关计划、立即运行（验证配置用）、编辑、删除。看板批次列表中定时触发的批次带「定时」徽标。
```

- [ ] **Step 2: AGENTS.md**

2a. 分层架构 `engine/` 行改为（追加 scheduler 描述）：

```md
- `engine/`：queue（任务级并发额度 + 同窗口任务合并 CoalescingEnqueuer）、scheduler（自研 tick 定时调度：计划独立于任务，存 schedules 表）、window-runner（开窗→CDP 接管→顺序跑任务→关窗，patchright 驱动）、task-context（任务的 ctx 能力）、state（状态机）、retry-recovery（重启后恢复 retry_wait）
```

2b. 任务触发描述行（「要点」段：`无定时调度，仅手动触发（任务页「立即触发」= 全部启用窗口、看板行级「执行/重跑」= 单窗口单任务）；`）改为：

```md
触发方式：手动（任务页「立即触发」= 全部启用窗口、看板行级「执行/重跑」= 单窗口单任务）+ 定时计划（「定时任务」栏目，到点全部启用窗口，错过不补跑、在途跳过）；
```

2c. 前端页面列表（`页面在 web/src/pages/{dashboard,profiles,tasks,settings,docs}`）改为 `web/src/pages/{dashboard,profiles,tasks,schedules,settings,docs}`。

2d. 配置段「三层配置」说明后补一句：

```md
定时任务时区在 `scheduler.timezone`（默认 Asia/Shanghai）。
```

2e. 踩坑提醒加一条：

```md
- 定时触发与手动触发共享在途守卫与窗口熔断：定时跑着时手动触发该任务 409；定时失败同样计入熔断（连续 2 次后该窗口当日全部 skipped，含手动）
```

- [ ] **Step 3: 验证 + commit**

Run: `npm run typecheck` 然后 `npm test` 然后 `npm run test:web`（文档改动不影响代码，跑一遍确认无回归）
Expected: 全过

```bash
git add docs/API-GUIDE.md AGENTS.md
git commit -m "docs: API 手册与 AGENTS 增补定时任务章节"
```

---

## 最终验证计划（全部任务完成后）

1. `npm run typecheck`、`npm test`、`npm run test:web` 全过
2. `npm run dev` 手动验证（需比特浏览器真实环境）：
   - 面板出现「定时任务」栏目；新建四类计划各一，列表显示规则摘要与下次执行
   - 「立即运行」→ 看板出现「定时」批次，窗口按错峰依次执行
   - 停用计划后「立即运行」返回 409 提示；删除/编辑/开关即时生效
   - 任务在途时定时 tick 跳过并日志可见（logs/data/logs）
   - 重启后端后计划仍在（DB 持久化）、调度恢复
3. 未验证项（需等待真实到点）：可临时把计划时间设为下一分钟观察自动触发

## 明确不做

- 无新依赖、无 cron 表达式输入、无错过补跑、无窗口子集、无计划级错峰覆盖
- 不动现有触发路径/重试/队列/WindowRunner；旧 task_fired_at 残留表数据不动
