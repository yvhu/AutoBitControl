# Turso 云库迁本地 SQLite 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 Turso 云库依赖，本地 SQLite 文件（`storage.dbPath`，默认 `data/app.db`）成为唯一数据存储。

**Architecture:** `AppDb.open` 改为接收本地文件路径并内部转 `file:` URL（`@libsql/client` 本地引擎，测试早已在用）；open 时启用 WAL + busy_timeout 支持面板进程与 `task:run` 脚本并发开库；启动时按 `storage.dbRetainDays` 清理超期历史数据；config 链删除 cloud 段与 TURSO 环境变量。

**Tech Stack:** Node + TS（tsx）、libsql（本地 file: 引擎）、Express 5、vitest（后端 tests/ 一套）。

## Global Constraints

- 不迁移 Turso 存量数据，本地库全新开始（设计文档已确认）
- 任务开关 `task_states` 表保留在本地库当运行时状态，不迁往配置文件
- 无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块；日志用 logger 中文消息（格式 `logger.info({count}, '消息')`）；commit 用 conventional 中文（`feat:`/`fix:`/`chore:`/`docs:`）
- 每个任务结束必须 `npm run typecheck` 通过（严格模式，无 eslint）；有测试的任务 `npm test` 通过
- 验证命令：`npm run typecheck`、`npm test`（vitest run，tests/**/*.test.ts，超时 30s）
- **AGENTS.md 约束：未经用户明确要求不得执行 git commit。各任务的 commit 步骤默认跳过，除非用户授权；如用户授权则按步骤写的中文消息提交。**
- 现有测试已全部用 `file::memory:` 隔离，不连真库；新测试同样用内存库或临时目录文件库
- libsql `file:` URL 形式 `file:C:/path` 已在现有测试验证可用（Windows 反斜杠转正斜杠即可）

---

### Task 1: StorageConfig 增加 dbRetainDays 配置

**Files:**
- Modify: `src/infrastructure/config.ts:60-70,146-153`
- Modify: `config/config.json:36-42`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: 现有 `loadConfig`（infrastructure/config）
- Produces: `AppConfig.storage.dbRetainDays: number`（默认 90；Task 3 的清理功能使用，Task 4 的文档引用）

- [ ] **Step 1: 写失败测试**

在 `tests/config.test.ts` 的 `describe('loadConfig')` 内、最后一个用例后追加：

```ts
  it('storage.dbRetainDays 默认 90 且可被配置文件覆盖', () => {
    expect(loadConfig({ rootDir: dir }).storage.dbRetainDays).toBe(90)
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      storage: { dbRetainDays: 30 },
    }))
    expect(loadConfig({ rootDir: dir }).storage.dbRetainDays).toBe(30)
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL，报 `dbRetainDays` 未定义（TS 严格模式类型错误 `Property 'dbRetainDays' does not exist on type 'StorageConfig'`）

- [ ] **Step 3: 实现配置字段**

`src/infrastructure/config.ts`：

1. `StorageConfig` 接口（60-70 行）`logRetainDays` 后新增：

```ts
  /** 数据库历史数据保留天数（runs/batches/captcha_logs 超期行启动时清理，默认 90） */
  dbRetainDays: number
```

2. `defaults.storage`（146-153 行）`logRetainDays: 7` 后新增：

```ts
    // 数据库历史数据保留 90 天，超期行启动时清理（runs/batches/captcha_logs）
    dbRetainDays: 90,
```

3. `config/config.json` 的 `storage` 段改为：

```json
  "storage": {
    "dbPath": "data/app.db",
    "screenshotDir": "data/screenshots",
    "logDir": "data/logs",
    "logLevel": "info",
    "logRetainDays": 7,
    "dbRetainDays": 90
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS（新用例 + 原有用例全绿）

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add src/infrastructure/config.ts config/config.json tests/config.test.ts
git commit -m "feat: storage 配置新增 dbRetainDays 历史数据保留天数"
```

---

### Task 2: AppDb.open 改本地路径签名 + WAL/busy_timeout + 调用方切换

**Files:**
- Modify: `src/infrastructure/db.ts:98-102,170-188,190-192`
- Modify: `tests/db.test.ts`（全部 `AppDb.open` 调用点：10、120、127、138、148、173、181、191、205、302 行）
- Modify: `src/app.ts:91-102`
- Modify: `scripts/run-task.ts:44-48`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `cfg.storage.dbPath`（app.ts 使用）
- Produces: `AppDb.open(dbPath: string): Promise<AppDb>`（后续所有任务与测试依赖此签名）；`AppDbOpenConfig` 接口删除

- [ ] **Step 1: 写失败测试（Windows 绝对路径用例）**

在 `tests/db.test.ts` 的 `describe('AppDb')` 内、最后用例后追加：

```ts
  it('Windows 绝对路径（反斜杠）转换为 file: URL 后可正常读写且落盘持久', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abc-winpath-'))
    const absPath = join(dir, 'app.db')
    const db2 = await AppDb.open(absPath)
    const p = await db2.upsertProfile('bb-wp', '窗口')
    expect(p.bitbrowserId).toBe('bb-wp')
    db2.close()
    // 重新打开同一文件：数据仍在（真实落盘验证）
    const db3 = await AppDb.open(absPath)
    const list = await db3.listProfiles(false)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('窗口')
    db3.close()
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL（TS 类型错误：`AppDb.open` 只接受 `AppDbOpenConfig`，传字符串不匹配）

- [ ] **Step 3: 实现 db.ts 签名变更与 WAL**

`src/infrastructure/db.ts`：

1. 删除 `AppDbOpenConfig` 接口（98-102 行），换为路径转 URL 辅助函数：

```ts
/** 本地路径转 file: URL：file: 前缀原样透传（测试 file::memory:），其余反斜杠转正斜杠后加 file: 前缀 */
function toFileUrl(p: string): string {
  if (p.startsWith('file:')) return p
  return `file:${p.replace(/\\/g, '/')}`
}
```

2. `AppDb.open`（182-188 行）改为：

```ts
  static async open(dbPath: string): Promise<AppDb> {
    const client = createClient({ url: toFileUrl(dbPath) })
    const db = new AppDb(client)
    await db.migrate()
    return db
  }
```

3. 类注释（171 行）「云数据库访问门面」改为「本地 SQLite 访问门面：私有构造 + 异步 open 工厂，保证打开即迁移」。

4. `migrate()` 方法体开头（190 行后）插入：

```ts
    // WAL 日志模式：面板进程与 task:run 脚本可能同时开同一文件，读写不互锁（库级设置，幂等；
    // file::memory: 上执行无副作用）；busy_timeout 为连接级，写竞争时等待 5 秒而非立即报锁错
    await this.client.execute('PRAGMA journal_mode=WAL')
    await this.client.execute('PRAGMA busy_timeout=5000')
```

- [ ] **Step 4: 更新 tests/db.test.ts 全部 open 调用**

- 第 10 行：`beforeEach(async () => { db = await AppDb.open('file::memory:') })`
- 第 120、127 行：`AppDb.open({ url: fileUrl, authToken: '' })` → `AppDb.open(fileUrl)`
- 第 138、148、191、205 行：`AppDb.open({ url: 'file::memory:', authToken: '' })` → `AppDb.open('file::memory:')`
- 第 173、181 行：`AppDb.open({ url: `file:${file}`, authToken: '' })` → `AppDb.open(`file:${file}`)`
- 第 302 行：`AppDb.open({ url: `file:${file}`, authToken: '' })` → `AppDb.open(`file:${file}`)`
- 第 9 行注释「测试无需云库凭据」改为「测试无需凭据」

- [ ] **Step 5: 切换 app.ts 装配层**

`src/app.ts` 91-102 行替换为：

```ts
  // 本地 SQLite 数据库：storage.dbPath 有默认值（data/app.db），打开失败（磁盘/权限问题）快速失败
  let db: AppDb
  try {
    db = await AppDb.open(cfg.storage.dbPath)
  } catch (e) {
    logger.error({ err: (e as Error).message }, '本地数据库打开失败（请检查 storage.dbPath 与磁盘状态）')
    process.exit(1)
  }
  logger.info({ path: cfg.storage.dbPath }, '本地数据库已打开')
```

- [ ] **Step 6: 切换 run-task.ts**

`scripts/run-task.ts` 44-48 行替换为：

```ts
  const db = await AppDb.open(cfg.storage.dbPath)
```

（删除「未配置 TURSO_DATABASE_URL」检查；打开失败由脚本底部 main catch 兜底退出）

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS（新增 Windows 路径用例 + 全部原有用例全绿）

- [ ] **Step 8: 类型检查**

Run: `npm run typecheck`
Expected: 无错误（cfg.cloud 字段暂存，Task 4 移除）

- [ ] **Step 9: Commit（需用户授权）**

```bash
git add src/infrastructure/db.ts src/app.ts scripts/run-task.ts tests/db.test.ts
git commit -m "feat: 数据层切换本地 SQLite（AppDb.open 接收路径 + WAL 多进程并发）"
```

---

### Task 3: runs 复合索引 + cleanupOld 历史数据清理

**Files:**
- Modify: `src/infrastructure/db.ts`（migrate 末尾、类方法区）
- Modify: `src/app.ts`（启动时调用 cleanupOld）
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `cfg.storage.dbRetainDays`（app.ts 使用）；Task 2 的 `AppDb.open(dbPath)`
- Produces: `AppDb.cleanupOld(retainDays: number): Promise<{ runs: number; batches: number; captcha: number }>`

- [ ] **Step 1: 写失败测试**

在 `tests/db.test.ts` 末尾追加：

```ts
describe('cleanupOld 历史数据清理', () => {
  it('删除超期 runs/batches，保留期内数据不动', async () => {
    const db = await AppDb.open('file::memory:')
    const p = await db.upsertProfile('bb-clean', 'A')
    // 超期：400 天前（runs.date 直接造；batches.created_at 带时间戳）
    const oldDate = todayStr(new Date(Date.now() - 400 * 86400000))
    const today = todayStr()
    await db.upsertRun(p.id, 't', oldDate, 0, 'success')
    await db.upsertRun(p.id, 't', today, 0, 'success')
    await db.createBatch('bulk', 't', 'trigger-all', `${oldDate} 08:00:00.000`)
    await db.createBatch('bulk', 't', 'trigger-all', `${today} 08:00:00.000`)
    // captcha 记录 created_at 恒为当前时间，只验证保留期内不被误删
    await db.logCaptcha(p.id, 't', 'turnstile', 0.01, true)
    const result = await db.cleanupOld(90)
    expect(result.runs).toBe(1)
    expect(result.batches).toBe(1)
    expect(result.captcha).toBe(0)
    expect(await db.listRunsForDate(today)).toHaveLength(1)
    expect(await db.listRunsForDate(oldDate)).toHaveLength(0)
    const batches = await db.listBatchesForRange(null, today)
    expect(batches).toHaveLength(1)
    expect(await db.captchaStats(today).then((s) => s.count)).toBe(1)
    db.close()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL（`db.cleanupOld is not a function`）

- [ ] **Step 3: 实现 cleanupOld 与索引**

`src/infrastructure/db.ts`：

1. `migrate()` 末尾（244 行 `idx_runs_batch_id` 创建语句后）追加：

```ts
    // countInFlightRuns（任务/看板每次手动触发都查）用的复合索引
    await this.client.execute('CREATE INDEX IF NOT EXISTS idx_runs_task_date ON runs(task_key, date)')
```

2. 类方法区（`clearOpenWindow` 方法后）追加：

```ts
  /**
   * 清理超期历史数据（启动时调用）：runs.date 为 YYYY-MM-DD 文本，字典序安全直接比较；
   * batches/captcha_logs 的 created_at 为本地墙钟时间字符串，用 date() 提取日期比较。
   * runs.batch_id 无外键约束，先删 runs 再删 batches 安全。
   * @param retainDays 保留天数（0 或负数 = 仅清理今天之前的数据）
   * @returns 各表删除行数
   */
  async cleanupOld(retainDays: number): Promise<{ runs: number; batches: number; captcha: number }> {
    const now = new Date()
    const cutoff = todayStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() - retainDays))
    const r1 = await this.client.execute({ sql: 'DELETE FROM runs WHERE date < ?', args: [cutoff] })
    const r2 = await this.client.execute({ sql: 'DELETE FROM batches WHERE date(created_at) < date(?)', args: [cutoff] })
    const r3 = await this.client.execute({ sql: 'DELETE FROM captcha_logs WHERE date(created_at) < date(?)', args: [cutoff] })
    return { runs: Number(r1.rowsAffected), batches: Number(r2.rowsAffected), captcha: Number(r3.rowsAffected) }
  }
```

- [ ] **Step 4: app.ts 启动时调用清理**

`src/app.ts` 的 `recoverRetryTasks` 调用块（215-220 行）后追加：

```ts
  // 历史数据清理：按保留天数删超期 runs/batches/captcha_logs（本地文件无限增长，启动时收敛一次）
  try {
    const cleaned = await db.cleanupOld(cfg.storage.dbRetainDays)
    if (cleaned.runs + cleaned.batches + cleaned.captcha > 0) {
      logger.info({ retainDays: cfg.storage.dbRetainDays, cleaned }, '已清理超期历史数据')
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, '历史数据清理失败（不影响运行）')
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS（新用例 + 原有全绿）

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 7: Commit（需用户授权）**

```bash
git add src/infrastructure/db.ts src/app.ts tests/db.test.ts
git commit -m "feat: 新增历史数据保留天数清理与 runs 复合索引"
```

---

### Task 4: 移除 cloud 配置段与 TURSO 环境变量

**Files:**
- Modify: `src/infrastructure/config.ts:54-58,84-94,144-145,214-216`
- Modify: `config/config.json:33`
- Modify: `config/.env.example:5-10`

**Interfaces:**
- Consumes: Task 2（app.ts/run-task.ts 已不再引用 `cfg.cloud`，本任务删除后无引用点）
- Produces: `AppConfig` 不再含 `cloud` 字段；`CloudConfig` 接口删除

- [ ] **Step 1: 删除 config.ts 云库相关代码**

`src/infrastructure/config.ts`：

1. 删除 `CloudConfig` 接口（54-58 行，含注释「Turso 云数据库配置…」）
2. `AppConfig` 接口删除 `cloud: CloudConfig` 字段（90 行）
3. `defaults` 删除 `cloud: { url: '', authToken: '' }`（145 行）与其上注释（144 行）
4. 删除环境变量读取块（214-216 行，含注释）

- [ ] **Step 2: 删除配置文件云库段**

1. `config/config.json` 删除 `"cloud": { "url": "", "authToken": "" },`（33 行）
2. `config/.env.example` 删除「云数据库（Turso…）」整块（5-10 行：标题注释、说明注释、`TURSO_DATABASE_URL=`、`TURSO_AUTH_TOKEN=`、空行）

- [ ] **Step 3: 类型检查与全量测试**

Run: `npm run typecheck`
Expected: 无错误
Run: `npm test`
Expected: 全部 PASS（config.test.ts 无 cloud 断言，db/web 测试不受影响）

- [ ] **Step 4: Commit（需用户授权）**

```bash
git add src/infrastructure/config.ts config/config.json config/.env.example
git commit -m "feat: 移除 Turso 云数据库配置（cloud 段与 TURSO 环境变量）"
```

---

### Task 5: 文档与注释同步

**Files:**
- Modify: `AGENTS.md`（25、37、55 行）
- Modify: `README.md`（9、17、60 行）
- Modify: `docs/API-GUIDE.md`（1095、1101、1455 行）
- Modify: `src/infrastructure/db.ts`（2、104、193 行注释）
- Modify: `src/engine/window-runner.ts`（85 行注释）

**Interfaces:**
- Consumes: 无（纯文档/注释）
- Produces: 无

- [ ] **Step 1: AGENTS.md**

1. 25 行：`CAPTCHA_CLIENT_KEY`、`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`（云数据库，未配置启动直接报错退出）、`WALLET_PASSWORDS` → `CAPTCHA_CLIENT_KEY`、`WALLET_PASSWORDS`
2. 37 行：`db(Turso libsql)` → `db(本地 SQLite，libsql 本地引擎)`
3. 55 行「数据层」段改为：

```markdown
本地 SQLite（libsql file: 引擎），库文件 `storage.dbPath`（默认 `data/app.db`，已 gitignore），`src/infrastructure/db.ts` 的 AppDb 封装全部访问，表结构首次打开自动创建：`profiles`（窗口）、`runs`（窗口×任务×日期×slot 唯一，`batch_id` 归属运行批次）、`batches`（运行批次）、`captcha_logs`、`task_states`、`open_windows`（面板与 task:run 跨进程共享）。WAL 模式支持多进程并发开库；启动时按 `storage.dbRetainDays`（默认 90）清理超期历史数据。新增字段加 migrate 补列逻辑（老库兼容）。运行状态机：pending → running → success / retry_wait / captcha_failed / failed / skipped（tests 与 db 均用注入隔离，不连真库）。
```

- [ ] **Step 2: README.md**

1. 9 行：`- Turso 云数据库（数据层全部走云端，无需本地数据文件；首次启动自动建表）` → `- 本地 SQLite 数据库（data/app.db，首次启动自动建表，WAL 模式支持多进程并发）`
2. 17 行：`# 编辑 config/.env 填入 CAPTCHA_CLIENT_KEY、TURSO_DATABASE_URL、TURSO_AUTH_TOKEN` → `# 编辑 config/.env 填入 CAPTCHA_CLIENT_KEY`
3. 60 行：云数据库配置说明段落改为：

```markdown
数据库为本地 SQLite 文件，路径在 `config.json` 的 `storage.dbPath`（默认 `data/app.db`，已在 .gitignore，不提交）。表结构首次打开时自动创建（profiles/runs/batches/captcha_logs/task_states/open_windows）；`storage.dbRetainDays`（默认 90）控制历史数据保留天数，超期行启动时自动清理。
```

- [ ] **Step 3: docs/API-GUIDE.md**

1. 1095 行：删除 `cloud` 配置行整行
2. 1101 行：`storage` 行描述中 `dbPath` 是**遗留字段**——数据层已全走云端数据库，云库模式下不生效，无需配置 → `dbPath` 是本地 SQLite 库文件路径（默认 `data/app.db`，已 gitignore）；`dbRetainDays`（默认 90）控制 runs/batches/captcha_logs 保留天数，超期行启动时清理。其余字段说明保留
3. 1455 行：删除「未配置 TURSO_DATABASE_URL」排错行整行

- [ ] **Step 4: 代码注释同步**

1. `src/infrastructure/db.ts` 2 行：「Turso 云数据库数据访问」→「本地 SQLite 数据访问」；「全部数据层走云端（libsql 协议，file: URL 供测试使用本地引擎）」→「数据层走本地文件（libsql 本地引擎，file: URL；file::memory: 供测试使用）」
2. `src/infrastructure/db.ts` 104 行：「云库首次启动自动建表」→「首次打开自动建表」
3. `src/infrastructure/db.ts` 193 行：「云库多机共享同一 schema」→「本地库与老库共享同一迁移逻辑」
4. `src/engine/window-runner.ts` 85 行：「云库抖动/断网时任务照跑」→「数据库写失败时任务照跑」

- [ ] **Step 5: 类型检查与全量测试**

Run: `npm run typecheck`
Expected: 无错误
Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 6: Commit（需用户授权）**

```bash
git add AGENTS.md README.md docs/API-GUIDE.md src/infrastructure/db.ts src/engine/window-runner.ts
git commit -m "docs: 数据层文档同步为本地 SQLite（AGENTS/README/API-GUIDE 与代码注释）"
```

---

### Task 6: 全量验证

**Files:**
- 无代码改动（仅验证）

- [ ] **Step 1: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 2: 后端全量测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 3: 前端单测（回归确认面板未受影响）**

Run: `npm run test:web`
Expected: 全部 PASS

- [ ] **Step 4: 本地启动冒烟（可选，需真实环境）**

Run: `npm start`
Expected: 日志出现「本地数据库已打开」与 `data/app.db` 路径；`data/app.db` 文件生成；面板可正常访问

- [ ] **Step 5: Commit 前收尾（需用户授权）**

```bash
git status
git add .
git commit -m "feat: Turso 云库迁移本地 SQLite 完成"
```
