# AutoBitControl — AI 协作者指南

Web3 自动签到任务系统：比特浏览器多窗口 + 拟人化操作 + yescaptcha 自动打码。Node 单进程 + Vite React 面板。所有注释/文档/commit message 用中文。

## 常用命令

```powershell
npm run dev        # 唯一日常入口：同时起后端(tsx src/index.ts, 端口 WEB_PORT=3000) + 面板(Vite, VITE_PORT，代理 /api /api-docs /screenshots 到后端)
npm start          # 只起后端 API（pm2 开机自启用这个）
npm test           # vitest run（tests/**/*.test.ts，超时 30s）
npm run test:web   # 前端单测（vitest + testing-library + jsdom）
npm run typecheck  # tsc --noEmit（严格模式；无 eslint 脚本）
npm run smoke:window / smoke:wallet   # 单窗口冒烟（需 BITBROWSER_PROFILE_ID 等环境变量）
npm run task:run   # 单窗口单任务调试（BITBROWSER_PROFILE_ID + TASK_KEY，不受任务开关限制）
```

改完代码验证：`npm run typecheck` 和 `npm test` 都要过。面板一律访问 Vite 端口，后端 `http://127.0.0.1:3000` 只出 API（`/api-docs` Swagger 在其上）。

## 配置（读它，别猜）

三层配置 + 环境变量覆盖（`src/infrastructure/config.ts` 的 `loadConfig` 是唯一入口）：

- `config/config.json` — 通用参数（已提交）
- `config/config.local.json` — 本机覆盖（gitignore，可不存在）
- `config/.env` — 密钥与端口：`CAPTCHA_CLIENT_KEY`、`WALLET_PASSWORDS`（JSON 映射 `{"metamask":"密码","petra":"密码"}`）、`WEB_PORT`、`VITE_PORT`。前端 Vite 也共用此文件（vite.config.ts 的 loadEnv 指向 `../config`）

**写代码前先读 `config/config.json` 和 `config/.env` 确认当前值**（端口、开关等以文件为准）。`config/.env`、`config.local.json`、`config/accounts.xlsx` 含真实密钥/账号，绝不提交或外泄；示例值一律写进 `.env.example` / `accounts.example.xlsx`。

## 分层架构（依赖方向不可反向）

```
tasks → engine → {integrations, automation} → infrastructure
server → {engine, infrastructure}   （唯一例外：server 可对 tasks 做 type-only import）
src/app.ts 组装一切（compose root，只被 index.ts 调用）
```

- `infrastructure/`：config / logger(log4js) / db(本地 SQLite，libsql 本地引擎) / datasource(Excel 账号表) / http 封装
- `integrations/`：bitbrowser.ts（本地 API 默认 http://127.0.0.1:54345）、yescaptcha.ts
- `automation/`：humanize.ts（拟人操作）、wallet/（types 注册表 + metamask/petra 适配器）
- `engine/`：queue（任务级并发额度 + 同窗口任务合并 CoalescingEnqueuer）、window-runner（开窗→CDP 接管→顺序跑任务→关窗，patchright 驱动）、task-context（任务的 ctx 能力）、state（状态机）、retry-recovery（重启后恢复 retry_wait）
- `tasks/`：站点任务，只经 TaskContext 使用引擎能力
- `server/`：express 路由按资源分文件（routes/），统一 `{code,message,data}` 响应（server/http/response.ts 的 ok/fail + asyncHandler），错误走 HttpError → 统一错误中间件
- `web/`：React 18 + Vite 5 + antd 5 + react-query + react-router，页面在 web/src/pages/{dashboard,profiles,tasks,settings,docs}

## 新增/修改任务

权威手册是 `docs/API-GUIDE.md`（面板文档页也渲染它）——TaskMeta 字段全解、TaskContext 方法全解、常用模式/排错，写任务前先读对应章节。

三步：在 `src/tasks/` 新建类继承 `SiteTask`（参考 `example-checkin.ts` 的逐行注释）→ 在 `src/tasks/index.ts` 的 ALL 数组登记（key 必须全局唯一）→ 重启生效。

要点：任务 = `meta`（key/name/url/wallet/timeoutSec/retry/captcha/concurrency） + `run(ctx)`；成功必须显式断言（ctx.clickCheckin 的 assert 等）；无定时调度，仅手动触发（任务页「立即触发」= 全部启用窗口、看板行级「执行/重跑」= 单窗口单任务）；`meta.enabled=false` 时手动触发 409；面板任务页开关写入本地库 task_states（运行时状态，换设备重置回代码默认值）覆盖代码默认值。

## 数据层

本地 SQLite（libsql file: 引擎），库文件 `storage.dbPath`（默认 `data/app.db`，已 gitignore），`src/infrastructure/db.ts` 的 AppDb 封装全部访问，表结构首次打开自动创建：`profiles`（窗口）、`runs`（窗口×任务×日期×slot 唯一，`batch_id` 归属运行批次）、`batches`（运行批次）、`captcha_logs`、`task_states`、`open_windows`（面板与 task:run 跨进程共享）。WAL 模式支持多进程并发开库；启动时按 `storage.dbRetainDays`（默认 90）清理超期历史数据。新增字段加 migrate 补列逻辑（老库兼容）。运行状态机：pending → running → success / retry_wait / captcha_failed / failed / skipped（tests 与 db 均用注入隔离，不连真库）。

## 前端与 API 变更

后端路由有 @swagger 注解（src/server/openapi.ts 汇总）。`web/src/api/schema.d.ts` 由 `npx openapi-typescript http://127.0.0.1:3000/api/docs/openapi.json -o web/src/api/schema.d.ts` 生成，但项目先例是**手补类型**（多数计划如此执行）；前端发请求只走 `web/src/api/client.ts`/`endpoints.ts`，页面 hooks 放 `pages/<页>/hooks.ts`（hooks 配单测）。

## 代码风格

无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块说明模块职责与依赖方向；命名用 camelCase，文件 kebab-case；日志用 logger（中文消息，格式 `logger.info({count}, '消息')`）。commit 风格 conventional：`feat:`/`fix:`/`chore:`/`docs:` + 中文描述。

## 踩坑提醒

- 未捕获异常默认退出进程，但 CDP 会话级瞬时错误（Protocol error/session closed 等，见 src/app.ts TRANSIENT_PATTERN）只告警不退出——修 bug 时别把这类错误当致命
- 开窗后先 IP 探活（execution.probeUrl）再跑任务；窗口连续 2 任务失败触发当日熔断
- 面板端口被占/改端口：改 `config/.env` 的 WEB_PORT/VITE_PORT 后重启 dev
- 比特浏览器必须在同一台机器运行且 API 已开启；无它无法联调，跑任务需真实环境
- 设计文档在 `docs/superpowers/specs/`（按日期），计划在 `docs/superpowers/plans/`；实现前可查对应 spec
- 批量触发（任务页「立即触发」）与重试会话开窗前自带随机错峰（`execution.staggerMaxSec`，默认 120 秒，0 关闭）；单窗口入口（看板行级执行、task:run 脚本）不等待
