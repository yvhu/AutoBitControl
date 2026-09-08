# 单实例守卫（single-instance guard）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保证同一台机器上同时只存在一个后端服务实例（第二个实例快速失败退出），杜绝 2026-09-08 双进程事故（计划双触发、同窗口双 CDP 会话、看板双批次）。

**Architecture:** 新增零依赖模块 `src/infrastructure/single-instance.ts`：以 `wx` 原子标志创建锁文件并写入本进程 PID；文件已存在时按 PID 存活探测区分「占用中（抛错退出）」与「残留锁（删除接管）」。装配进 `startApp`（日志初始化后、数据库打开前），优雅退出时释放。

**Tech Stack:** Node 内置 fs/process/path，Vitest，TypeScript 严格模式。

## Global Constraints

- 代码风格：无分号、单引号、2 空格缩进、camelCase 命名、文件 kebab-case；文件头中文注释块说明模块职责；注释/日志全部中文
- 测试：`npm test`（vitest run，tests/**/*.test.ts）；`npm run typecheck`（tsc --noEmit）两者必须全过
- 守卫只装配在 `startApp`（src/app.ts）；`scripts/run-task.ts`、smoke 脚本、Vite 面板进程不受影响
- 锁路径由 `storage.dbPath` 推导（默认 `data/app.lock`，data/ 已 gitignore）；不新增配置键、不新增 API、不新增依赖
- 测试用临时目录 + 注入 pid/probe，不触碰真实 `data/`
- commit 风格：`feat:`/`docs:` + 中文描述；文档与代码同批提交（本计划含 AGENTS.md 更新与 spec 文档）

---

### Task 1: 单实例锁模块（TDD：测试先行）

**Files:**
- Create: `tests/single-instance.test.ts`
- Create: `src/infrastructure/single-instance.ts`

**Interfaces:**
- Consumes: 无（纯 Node 内置模块）
- Produces:
  - `export class SingleInstanceError extends Error` — 字段 `readonly lockPath: string`、`readonly holderPid: number | null`
  - `export interface AcquireOptions { pid?: number; probe?: (pid: number) => boolean }`
  - `export function acquireSingleInstanceLock(lockPath: string, opts?: AcquireOptions): { release(): void }`
  - `export function singleInstanceLockPath(dbPath: string): string`
  - `export function readHolderPid(lockPath: string): number | null`（测试辅助与实现共用）

- [ ] **Step 1: 写失败测试**

`tests/single-instance.test.ts`（完整内容）：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireSingleInstanceLock, readHolderPid, singleInstanceLockPath, SingleInstanceError } from '../src/infrastructure/single-instance'

const aliveProbe = () => true
const deadProbe = () => false

describe('single-instance 锁', () => {
  const dirs: string[] = []
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'single-instance-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('首次取锁成功，锁文件写入本进程 PID', () => {
    const p = join(mk(), 'app.lock')
    const h = acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('4242')
    h.release()
  })

  it('锁被存活进程持有 → 抛 SingleInstanceError 且带占用 PID', () => {
    const p = join(mk(), 'app.lock')
    writeFileSync(p, '1111')
    expect(() => acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })).toThrow(SingleInstanceError)
    try {
      acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })
    } catch (e) {
      expect(e).toBeInstanceOf(SingleInstanceError)
      expect((e as SingleInstanceError).holderPid).toBe(1111)
      expect((e as SingleInstanceError).lockPath).toBe(p)
    }
    // 持有者文件不被篡改
    expect(readFileSync(p, 'utf-8')).toBe('1111')
  })

  it('死进程残留锁 → 删除接管成功', () => {
    const p = join(mk(), 'app.lock')
    writeFileSync(p, '999999999')
    const h = acquireSingleInstanceLock(p, { pid: 4242, probe: deadProbe })
    expect(readFileSync(p, 'utf-8')).toBe('4242')
    h.release()
  })

  it('release 删除自己的锁文件', () => {
    const p = join(mk(), 'app.lock')
    const h = acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })
    h.release()
    expect(existsSync(p)).toBe(false)
  })

  it('release 不删已被接管的新锁（文件内容不是自己 PID）', () => {
    const p = join(mk(), 'app.lock')
    const h = acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })
    writeFileSync(p, '9999')
    h.release()
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('9999')
  })

  it('readHolderPid 内容非法或不存在时返回 null', () => {
    const p = join(mk(), 'app.lock')
    expect(readHolderPid(p)).toBeNull()
    writeFileSync(p, 'not-a-number')
    expect(readHolderPid(p)).toBeNull()
  })

  it('singleInstanceLockPath 由 dbPath 推导（file: 前缀剥离、:memory: 兜底）', () => {
    expect(singleInstanceLockPath('data/app.db')).toBe(join('data', 'app.lock'))
    expect(singleInstanceLockPath('file:data/app.db')).toBe(join('data', 'app.lock'))
    expect(singleInstanceLockPath(':memory:')).toBe(join('data', 'app.lock'))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/single-instance.test.ts`
Expected: FAIL — `Cannot find module '../src/infrastructure/single-instance'`

- [ ] **Step 3: 写最小实现**

`src/infrastructure/single-instance.ts`（完整内容）：

```ts
/**
 * 单实例守卫（infrastructure 层）：锁文件 + PID 存活检测，保证同一数据库文件同时只有一个后端实例
 * 依赖方向：纯 Node 内置模块（fs/process/path），不依赖任何项目层；被 src/app.ts 装配
 * 设计思路：wx 原子创建锁文件（Windows 等价 CREATE_NEW，并发抢锁只有一个成功）→ 写入本进程 PID；
 * 文件已存在则按 PID 存活探测区分：存活 → 抛 SingleInstanceError（快速失败）；
 * 已死 → 判定残留锁（taskkill /F、断电等场景），删除后重试一次接管
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 取锁失败（已有存活实例持有）：携带锁路径与占用者 PID（holderPid 为 null 表示读取失败） */
export class SingleInstanceError extends Error {
  constructor(readonly lockPath: string, readonly holderPid: number | null) {
    super(`另一个实例正在运行（PID: ${holderPid ?? '未知'}，锁文件: ${lockPath}）`)
  }
}

/** 测试注入项：pid 与存活探测默认取真实进程 */
export interface AcquireOptions {
  pid?: number
  probe?: (pid: number) => boolean
}

/** 默认存活探测：kill(pid, 0) —— ESRCH=进程不存在（已死），EPERM 等一律按存活处理 */
function defaultProbe(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 读取锁文件中的持有者 PID；不存在/内容非法返回 null */
export function readHolderPid(lockPath: string): number | null {
  try {
    const n = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** 由数据库路径推导锁文件路径（同目录 app.lock，相对/绝对原样透传；:memory: 等无目录场景兜底 data/app.lock） */
export function singleInstanceLockPath(dbPath: string): string {
  if (dbPath.startsWith('file:')) dbPath = dbPath.slice('file:'.length)
  if (!dbPath || dbPath === ':memory:') return join('data', 'app.lock')
  return join(dirname(dbPath), 'app.lock')
}

/**
 * 获取单实例锁：成功返回 release 句柄；已有存活实例持有则抛 SingleInstanceError
 * 残留锁（持有者已死）删除后重试一次；重试仍冲突（并发接管竞态）抛错由调用方处理
 */
export function acquireSingleInstanceLock(lockPath: string, opts: AcquireOptions = {}): { release(): void } {
  const myPid = opts.pid ?? process.pid
  const probe = opts.probe ?? defaultProbe
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, String(myPid))
      closeSync(fd)
      return { release: () => releaseLock(lockPath, myPid) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holderPid = readHolderPid(lockPath)
      if (holderPid !== null && probe(holderPid)) {
        throw new SingleInstanceError(lockPath, holderPid)
      }
      // 残留锁：删除后重试一次（删除失败/竞态由下一次循环的 EEXIST 分支收口）
      try {
        unlinkSync(lockPath)
      } catch {
        // 锁已被他人删除，继续重试
      }
    }
  }
  throw new SingleInstanceError(lockPath, null)
}

/** 释放锁：只删「内容为自己 PID」的文件（防误删接管者的新锁）；文件已不存在等异常忽略 */
function releaseLock(lockPath: string, myPid: number): void {
  try {
    if (readHolderPid(lockPath) === myPid) unlinkSync(lockPath)
  } catch {
    // 释放失败忽略：残留锁由下次启动的存活探测接管
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/single-instance.test.ts`
Expected: PASS（7 个用例全过）

- [ ] **Step 5: 提交**

```powershell
git add tests/single-instance.test.ts src/infrastructure/single-instance.ts docs/superpowers/specs/2026-09-08-single-instance-guard-design.md
git commit -m "feat: 新增单实例锁模块（锁文件+PID存活检测，防双后端实例互相踩踏）"
```

---

### Task 2: 装配进 startApp 并同步文档

**Files:**
- Modify: `src/app.ts`（import 区 + startApp 开头取锁 + finish 释放）
- Modify: `AGENTS.md`（踩坑提醒补一条）

**Interfaces:**
- Consumes: `acquireSingleInstanceLock`、`singleInstanceLockPath`、`SingleInstanceError`（Task 1 产出，签名见 Task 1）
- Produces: 无（行为变更：第二个后端实例启动即退出，退出码 1，日志含锁路径与占用 PID）

- [ ] **Step 1: 修改 src/app.ts**

在 import 区（`import { loadConfig }` 一行之后）加入：

```ts
import { acquireSingleInstanceLock, singleInstanceLockPath, SingleInstanceError } from './infrastructure/single-instance'
```

在 `startApp` 内 `const logger = createLogger(cfg)` 之后、`process.on('uncaughtException', ...)` 之前插入：

```ts
  // 单实例守卫：同一数据库文件同时只允许一个后端实例——
  // 2026-09-08 事故：旧 npm start 与新 dev 两进程并存，各自调度器重复触发计划、
  // 同一窗口被两个 CDP 会话同时接管（看板双批次、领水额度被打乱）。
  // 锁在 AppDb.open 之前获取（快速失败不产生副作用）；异常退出路径无需清理，
  // 残留锁由下次启动按 PID 存活探测自动接管
  const lockPath = singleInstanceLockPath(cfg.storage.dbPath)
  let singleLock!: ReturnType<typeof acquireSingleInstanceLock>
  try {
    singleLock = acquireSingleInstanceLock(lockPath)
  } catch (e) {
    if (e instanceof SingleInstanceError) {
      logger.error({ lockPath, holderPid: e.holderPid }, '检测到另一个后端实例正在运行（多实例会导致定时计划重复触发与窗口会话互杀），本实例退出；若确认旧实例已退出仍报此错，请删除该锁文件后重试')
      process.exit(1)
    }
    throw e
  }
  logger.info({ lockPath }, '已取得单实例锁')
```

在文件末尾的 `finish` 函数中，`finishing = true` 之后插入释放（`db.close()` 之前）：

```ts
    singleLock.release()
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `npm run typecheck; if ($?) { npm test }`
Expected: 两者全部通过（web.test.ts 只 import `buildBitbrowserDeps`，不受取锁影响）

- [ ] **Step 3: 双实例快速冒烟（可选，需手动重启后验证）**

```powershell
# 终端 1：启动第一个实例，等待打出「已取得单实例锁」
npm start
# 终端 2：再启动第二个实例
npm start
```

Expected: 第二个实例立即打出「检测到另一个后端实例正在运行…本实例退出」并退出（退出码 1）；第一个实例不受影响。

- [ ] **Step 4: 同步 AGENTS.md 踩坑提醒**

在「## 踩坑提醒」列表末尾追加：

```markdown
- 双后端实例会互相踩踏（2026-09-08 事故：旧 npm start 与新 dev 并存，定时计划双触发、同窗口双 CDP 会话、领水额度打乱）。已有单实例锁 `data/app.lock`（startApp 启动取锁，PID 存活检测自动接管残留锁）；报「检测到另一个后端实例正在运行」时先杀残留进程，确认无残留再删锁文件
```

- [ ] **Step 5: 提交**

```powershell
git add src/app.ts AGENTS.md
git commit -m "feat: startApp 装配单实例锁，防双后端实例并存（docs: 踩坑提醒同步）"
```
