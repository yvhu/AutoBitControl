# 单实例守卫设计（single-instance guard）

日期：2026-09-08
状态：已确认（2026-09-08，用户「确定」）

## 背景（2026-09-08 双实例事故）

9/7 20:21 启动的 `npm start` 后端一直未被关闭，9/8 19:54 又启动 `npm run dev`，两个后端进程并存到 21:00。
两个进程各自的定时调度器同时触发计划 #2「Shelby 领水-每周最少1次」，各建一个批次（126/127）各跑 100 个窗口：
看板出现两条记录；同一窗口被两个 CDP 会话同时接管，APT 被并发双领（当日 APT 804 次 vs ShelbyUSD 310 次）、
页面互杀报错 391 条。

根因复盘结论：进程级防重（调度器 `lastFired` 去重 Map、队列 `hasTaskInFlight`）都是单进程内存态，
跨进程不可见；DB 层 `countInFlightRuns` 又因 run 行是「窗口被领走时才写」而形同虚设。
且 Windows 上「端口占用检测」不可靠——libuv 在 Windows 设 SO_REUSEADDR，两个 Node 进程可同时成功绑定同一端口
（事故当晚两进程均打印「后端 API 已启动」）。

## 目标 / 非目标

**目标**：保证同一台机器、同一数据库文件上，同时只存在一个后端服务实例；第二个实例快速失败退出并给出清晰提示。

**非目标**：
- 不做分布式锁 / 跨机器协调（单机项目，不引入新依赖）
- 不限制 `task:run`、smoke 等调试脚本与主进程并发（它们不启动调度器/队列，走 SQLite WAL 多进程访问是本项目既定设计）
- 不做锁的自动心跳续期（PID 复用误判是低概率场景，出错时提示手动删锁文件即可）

## 方案：锁文件 + PID 存活检测

### 1. 新模块 `src/infrastructure/single-instance.ts`（纯 Node fs/process，零依赖）

```
acquireSingleInstanceLock(lockPath, opts?): SingleInstanceHandle
  opts: { pid?: number; probe?: (pid: number) => boolean }   // 测试注入
  SingleInstanceHandle: { release(): void }

抛出 SingleInstanceError：{ lockPath, holderPid }
```

**取锁流程**：
1. `fs.openSync(lockPath, 'wx')` 原子创建（Windows 上等价 CREATE_NEW——两个进程同时抢只有一个成功，杜绝竞态双持）
2. 创建成功 → 写入本进程 PID → 返回 handle
3. `EEXIST` → 读文件得 `holderPid` → `probe(holderPid)`（默认 `process.kill(pid, 0)`：ESRCH=死，EPERM/成功=活）
   - 存活 → 抛 `SingleInstanceError`
   - 已死 → 判定残留锁（taskkill /F、断电等场景）→ 删除后重试一次（重试仍冲突则抛错，防多进程同时接管打转）

**释放流程**：`release()` 先读文件校验「内容 == 自己 PID」再删除——防误删接管者的新锁。
正常退出路径由调用方调用；强杀无清理，残留锁由下次启动的存活检测自动接管。

### 2. 装配点 `src/app.ts`

位置：`loadConfig → createLogger → acquireSingleInstanceLock`，**在 `AppDb.open` 之前**（快速失败，不产生任何副作用）。

- 锁路径：由 `storage.dbPath` 所在目录推导 `<dbDir>/app.lock`（默认 `data/app.lock`，data/ 已 gitignore）；
  `:memory:` 或推导失败时兜底为 `data/app.lock`
- 取锁失败：`logger.error`（含 holderPid 与锁路径，提示「另一实例正在运行；确认旧实例已退出可删除该锁文件」）→ `process.exit(1)`
- `shutdown()` 优雅退出路径先 `release()` 再收尾；异常退出路径无需清理（残留锁由下次启动接管）

**不受影响**（守卫只放在 `startApp`）：`scripts/run-task.ts`、smoke 脚本、Vite 面板进程。

### 3. 测试 `tests/single-instance.test.ts`（注入临时目录与假 pid，不碰真实 data/）

- 首次取锁成功，文件内容为注入 pid
- 二次取锁抛 `SingleInstanceError`，含 holderPid
- 死 pid（探针返回 false）残留锁 → 删除接管成功
- `release()` 删除锁文件；文件内容不是自己 pid 时不删
- 同一路径并发取锁只有一个成功（可选，wx 原子性回归）

### 4. 文档同步

- 本设计文档：`docs/superpowers/specs/2026-09-08-single-instance-guard-design.md`
- `AGENTS.md`「踩坑提醒」补一条：双后端实例事故根因 + 单实例锁位置（`data/app.lock`）
- 无新增配置键、无新 API、无面板改动 → `docs/API-GUIDE.md` 不更新

## 风险与取舍

| 取舍 | 说明 |
|---|---|
| PID 复用误判 | 旧实例崩溃后 PID 被无关进程复用 → 误判「存活」拒绝启动；提示语引导手动删锁文件兜底 |
| 残留锁自动接管 | 接管方重写 PID 后，若原实例其实活着（探针竞态）仍有双实例可能——窗口极小，且下一次启动的守卫会继续收窄；不在本次处理 |
| 锁文件与 dbPath 耦合 | 换数据库路径即换锁路径，语义上正确（锁的是「这个库的服务实例」）；`:memory:` 有兜底 |
