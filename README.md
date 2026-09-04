# AutoBitControl

Web3 自动签到任务系统：比特浏览器多窗口 + 拟人化 + yescaptcha 自动打码。

## 环境要求

- Windows 10/11，Node 20.x，比特浏览器（本机运行中）
- 比特浏览器 API 已开启（默认 http://127.0.0.1:54345，可在 config 修改）
- 本地 SQLite 数据库（data/app.db，首次启动自动建表，WAL 模式支持多进程并发）

## 安装

```powershell
npm install
npx patchright install chromium
Copy-Item config/.env.example config/.env
# 编辑 config/.env 填入 CAPTCHA_CLIENT_KEY
```

## 运行

### 日常使用（唯一入口，面板 + API）

```powershell
npm run dev
```

同时启动两个独立进程：

- **后端 API**：`http://127.0.0.1:3000`（纯接口，不托管页面；`/api-docs` Swagger 文档在它上面）
- **前端面板**：`http://localhost:5173`（Vite dev server，带热更新，`/api` 自动代理到后端）

**面板一律访问 Vite 端口（5173）**，后端端口不需要在浏览器打开。

两个端口都可在 `config/.env` 改：`WEB_PORT` 改后端 API 端口（Vite 代理自动跟随），`VITE_PORT` 改前端面板端口（5173 被占用时）。改完重启 `npm run dev` 生效。

### 只跑后端（无面板）

```powershell
npm start           # 单进程启动后端，只出 API；pm2 开机自启用这个
```

> `npm run build:web` 已不再需要：后端不再托管前端产物，面板由 Vite dev server 提供。

## 开机自启（pm2）

```powershell
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # 按提示执行输出的命令
```

> pm2 只托管后端 API（`ecosystem.config.cjs` 跑 `src/index.ts`）；开机自启后如需要面板，再手动 `npm run dev` 起前端。
> 已验证（2026-08-28，pm2 6.0.14）：`pm2 start ecosystem.config.cjs` 启动后 8 秒内进程 online、API HTTP 200。验证时本机 3000 端口被 dev 进程占用，改用 `$env:WEB_PORT='3112'` 跑通后已删除进程；默认配置仍走 3000 端口。

## 配置

三层配置：`config/config.json`（通用）→ `config/config.local.json`（本机覆盖）→ `config/.env`（密钥）。
数据库为本地 SQLite 文件，路径在 `config.json` 的 `storage.dbPath`（默认 `data/app.db`，已在 .gitignore，不提交）。表结构首次打开时自动创建（profiles/runs/batches/captcha_logs/task_states/open_windows）；`storage.dbRetainDays`（默认 90）控制历史数据保留天数，超期行启动时自动清理。
钱包解锁密码在 `config/.env` 用 `WALLET_PASSWORDS` 环境变量按钱包类型配置（JSON 映射，`{"metamask":"密码","petra":"密码"}`，同类型钱包共用同一密码，重启生效）；也可写在 `config.local.json` 的 `wallet.passwords`，环境变量优先合并。
日志保留天数在 `config.json` 的 `storage.logRetainDays` 配置（默认 7 天，保留最近 N 天；启动时与按天滚动时均清理过期文件）。

## 日志

- 终端实时输出：`[时间] 级别 消息`，中文正常显示无乱码；颜色按终端能力自动检测（`storage.prettyColorize` 可强制开关）
- 文件：`data/logs/app.log`（当天）＋ `data/logs/app.log.<日期>`（按天滚动，如 `app.log.2026-08-31`），纯文本一行一条
- 历史文件保留最近 N 天：`storage.logRetainDays`（默认 7），启动时与按天滚动时均清理过期文件（numBackups=N 表示保留 N 个归档 + 当前文件，共 N+1 个）

## 冒烟测试

```powershell
BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window
BITBROWSER_PROFILE_ID=<窗口ID> WALLET_KEY=petra npm run smoke:wallet
```

单窗口单任务调试（只开一个窗口跑指定任务，结束即退出）：

```powershell
BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run
```

## Windows 中文乱码

本项目日志已改为字符串直写路径（WriteConsoleW），Git Bash / VS Code 终端 / PowerShell 均正常显示中文，无需任何设置。若仍遇到其它命令行工具输出乱码（Windows 控制台默认 GBK 代码页所致），在 PowerShell 执行一次：

```powershell
chcp 65001
```

或一劳永逸写入 PowerShell 配置文件（`$PROFILE`）：`[Console]::OutputEncoding = [Text.Encoding]::UTF8`。

## 新增任务

在 `src/tasks/` 新建类继承 `SiteTask`（参考 `example-checkin.ts`），在 `src/tasks/index.ts` 的 ALL 数组注册。

- **任务开关**：代码 `meta.enabled`（默认开启）是出厂默认值；面板任务页可拨动开关，写入云端 `task_states` 覆盖并立即生效（窗口跑/手动触发同步感知），跨机器保留
- **任务级并发**：`meta.concurrency`（缺省 4）控制同一时间最多几个窗口并行跑该任务，批量触发时按额度滚动分批跑完
- 新任务无需任何数据库操作，注册代码后重启即可（无云端行时跟随代码默认值）

## 测试

```powershell
npm test
```
