# Turso 云库迁本地 SQLite 设计（2026-09-04）

## 背景与动机

数据层目前全部走 Turso 云数据库（libsql 协议，TURSO_DATABASE_URL/TURSO_AUTH_TOKEN）。实际运行环境是单机（比特浏览器必须与后端同机），云端带来的跨机共享价值有限，反而引入网络依赖与密钥配置成本。

核心决策：

- **彻底移除云库支持**，本地 SQLite 文件（`storage.dbPath`，默认 `data/app.db`，已在 .gitignore）成为唯一数据存储。
- **不迁移云库存量数据**，全新开始（代价：切换当天已成功的任务会重跑一轮）。
- **任务开关（task_states）留在本地库**当运行时状态，换设备后重置回 `meta.enabled` 代码默认值，可接受。
- 数据库只存运行时状态与统计（窗口列表、运行记录、批次、打码日志、开关、开窗登记）；密钥/钱包密码/端口等决策性配置继续走 config 文件链（config.json / config.local.json / .env），换设备不影响任务运行。
- 本地文件无限增长，加**保留天数启动清理**。

## 改动范围

### 1. 配置层 `src/infrastructure/config.ts` + `config/config.json` + `config/.env.example`

- 删 `CloudConfig` 接口、`AppConfig.cloud` 字段、默认值 `cloud: { url: '', authToken: '' }`
- 删环境变量读取：`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`
- 删 config.json 的 `cloud` 段
- `StorageConfig` 新增 `dbRetainDays: number`（默认 90）：runs/batches/captcha_logs 保留天数，超期行启动时清理
- config.json 加 `storage.dbRetainDays`（含注释性说明由 config 默认值兜底）
- `.env.example` 删 TURSO 两变量

### 2. 持久层 `src/infrastructure/db.ts`

- `AppDb.open(cfg: AppDbOpenConfig)` → `AppDb.open(dbPath: string)`
  - 内部构造 `file:` URL：相对路径直接 `file:${dbPath}`；Windows 绝对路径转 `file:/D:/...` 形式（盘符冒号保留，正斜杠替换）
  - `AppDbOpenConfig` 接口删除；测试 `file::memory:` 直接作为 dbPath 传入
- open 时执行 `PRAGMA journal_mode=WAL`（幂等，库级持久设置）：面板进程与 `task:run` 脚本同时开同一文件时读写不互锁；`PRAGMA busy_timeout=5000`（连接级，写竞争时等待）
  - 实现时实测 libsql 本地引擎对 WAL 支持情况；不支持则回退默认 journal 模式 + busy_timeout 兜底
- migrate 末尾新增 `cleanupOld(retainDays)`：
  - `DELETE FROM runs WHERE date < <cutoff>`（date 为 YYYY-MM-DD 文本，字典序安全）
  - `DELETE FROM batches WHERE date(created_at) < date(<cutoff>)`
  - `DELETE FROM captcha_logs WHERE date(created_at) < date(<cutoff>)`
  - cutoff = todayStr(now - retainDays)；runs.batch_id 无外键约束，先删 runs 后删 batches 安全
- 新增索引 `idx_runs_task_date ON runs(task_key, date)`（countInFlightRuns 每次手动触发/看板行级判定都查）
- 文件头注释更新：数据层描述改为本地 SQLite，删除「云库」表述

### 3. 装配层 `src/app.ts` + `scripts/run-task.ts`

- 删「未配置 TURSO_DATABASE_URL 即退出」的快速失败检查与云库连接失败日志
- 改为 `AppDb.open(cfg.storage.dbPath)`，启动日志打印本地库路径（app.ts）
- run-task.ts 同步：删 TURSO 检查、改 open 调用

### 4. 文档

- `AGENTS.md`：配置段说明删 TURSO 变量、「数据层」段改为本地 SQLite（file: URL 测试、WAL、保留天数清理）
- `docs/API-GUIDE.md`：配置段表删 `cloud` 行（1095 行附近）；`storage` 行的 `dbPath` 描述从「遗留字段、云库模式下不生效」改为「本地 SQLite 文件路径，数据层唯一存储」（1101 行附近）；排错表删「未配置 TURSO_DATABASE_URL」行（1455 行附近）

### 5. 测试

- `tests/db.test.ts`：`AppDb.open` 调用改为 `AppDb.open('file::memory:')` 路径参数
- `tests/config.test.ts`：删 cloud 段相关断言（如有）；补 `dbRetainDays` 默认值断言
- 其余测试已用 file 内存库隔离，不受影响
- 补 `cleanupOld` 清理用例：超期 runs/batches/captcha_logs 被删、未超期保留

## 明确不做

- 不迁移 Turso 存量数据
- 不做云/本地双模式切换（彻底删除 cloud 代码，不留死配置）
- 不做数据库备份机制（data/ 不进 git，由用户自行磁盘/网盘备份）

## 风险与边界

- 切换后当天 dedupe 状态丢失：已成功任务重跑一轮（单日一次性影响）
- 本地文件损坏即丢历史；对任务运行无致命影响（决策性配置在 config 文件）
- WAL 支持需实现时实测；失败回退默认模式（写入量低，busy_timeout 已够用）

## 验证

- `npm run typecheck`、`npm test` 全部通过
- 启动后端验证 data/app.db 生成、面板各页正常
- `task:run` 脚本与面板并发开库无锁冲突
