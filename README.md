# AutoBitControl

Web3 自动签到任务系统：比特浏览器多窗口 + 拟人化 + yescaptcha 自动打码。

## 环境要求

- Windows 10/11，Node 20.x，比特浏览器（本机运行中）
- 比特浏览器 API 已开启（默认 http://127.0.0.1:54345，可在 config 修改）
- Turso 云数据库（数据层全部走云端，无需本地数据文件；首次启动自动建表）

## 安装

```powershell
npm install
npx patchright install chromium
Copy-Item config/.env.example config/.env
# 编辑 config/.env 填入 CAPTCHA_CLIENT_KEY、TURSO_DATABASE_URL、TURSO_AUTH_TOKEN
```

## 运行

```powershell
npm run dev
```

Web 面板：http://127.0.0.1:3000

## 开机自启（pm2）

```powershell
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # 按提示执行输出的命令
```

> 已验证（2026-08-28，pm2 6.0.14）：`pm2 start ecosystem.config.cjs` 启动后 8 秒内进程 online、面板 HTTP 200。因验证时本机 3000 端口被 dev 进程占用，验证使用 `$env:WEB_PORT='3112'; pm2 start ecosystem.config.cjs` 指定端口跑通后已删除进程；默认配置仍走 3000 端口。

## 配置

三层配置：`config/config.json`（通用）→ `config/config.local.json`（本机覆盖）→ `config/.env`（密钥）。
云数据库在 `config/.env` 用 `TURSO_DATABASE_URL`（libsql:// 地址）与 `TURSO_AUTH_TOKEN`（Turso 令牌）配置，未配置时启动报错退出；也可写在 `config.json`/`config.local.json` 的 `cloud` 段，环境变量优先。表结构首次连接时自动创建（profiles/runs/captcha_logs/task_states）。
钱包解锁密码在 `config/.env` 用 `WALLET_PASSWORDS` 环境变量按窗口配置（JSON 映射，`{"窗口ID":"密码",...}`，重启生效）；也可写在 `config.local.json` 的 `wallet.passwords`，环境变量优先合并。

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

Git Bash 原生 UTF-8，无需处理。PowerShell 5.1 默认 GBK 代码页会乱码，运行前执行一次：

```powershell
chcp 65001
```

或一劳永逸写入 PowerShell 配置文件（`$PROFILE`）：`[Console]::OutputEncoding = [Text.Encoding]::UTF8`。

## 新增任务

在 `src/tasks/` 新建类继承 `SiteTask`（参考 `example-checkin.ts`），在 `src/tasks/index.ts` 的 ALL 数组注册。

- **任务开关**：代码 `meta.enabled`（默认开启）是出厂默认值；面板任务页可拨动开关，写入云端 `task_states` 覆盖并立即生效（调度/窗口跑/手动触发同步感知），跨机器保留
- 新任务无需任何数据库操作，注册代码后重启即可（无云端行时跟随代码默认值）

## 测试

```powershell
npm test
```
