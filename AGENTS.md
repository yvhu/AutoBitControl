# AutoBitControl — AI 协作者指南

Web3 自动签到任务系统：比特浏览器多窗口。Node 单进程 + Vite React 面板。所有注释/文档/commit message 用中文。

## 动手前先报方案（硬性，最高优先级）

**任何代码改动前，必须先用文字给出「原因 + 解决方案」，并等用户明确确认后才允许修改文件。** 未收到确认（“可以/改吧/按方案 X”）时，禁止调用 `edit`/`write`/`bash` 等任何会产生改动的操作；只做只读调查（read/grep/glob）和方案陈述。

- 例外：用户当次指令已明确要求直接改（如“直接改掉”“不用问，改”），或纯只读的诊断/问答。
- 方案要给到可决策的粒度：改哪些文件、改什么、有什么副作用/风险，需要用户选的时候给编号选项。
- 不确定用户意图时同样先问，不要靠猜动手。

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
  - `execution.windowPool`：窗口池（唯一调度器，始终启用，无开关）。窗口跨任务复用、无任务级并发/顺序限制；有效池 = `min(maxOpenWindows, 内存允许的打开数)`，实际打开数含手动/`task:run` 窗口；`maxOpenWindows` 同时是手动/面板开窗的统一上限；内存 `warning` 停补池与普通分配（仅允许探测）、`critical` 停分配并关空闲；关闭窗口按最早 `queued_at` 排队轮转，idle/任务数/寿命/连续占用回收；开窗冷却由 `openCooldownMs` 控制
  - `execution.health`：全局健康门禁（**Phase 2 已接入窗口池**；只由比特 API `/browser/pids` 对账失败/本机整体故障触发 → 暂停开窗 + 指数退避 + half-open 探测；暂停期间任务保持 `pending`，不批量失败。单窗口代理/任务失败走窗口熔断，不拖停全局）
- `config/config.local.json` — 本机覆盖（gitignore，可不存在）
- `config/.env` — 密钥与端口：`WALLET_PASSWORDS`（JSON 映射 `{"metamask":"密码","petra":"密码"}`）、`WEB_PORT`、`VITE_PORT`。前端 Vite 也共用此文件（vite.config.ts 的 loadEnv 指向 `../config`）

定时任务时区在 `scheduler.timezone`（默认 Asia/Shanghai）。

**写代码前先读 `config/config.json` 和 `config/.env` 确认当前值**（端口、开关等以文件为准）。`config/.env`、`config.local.json`、`config/accounts.xlsx` 含真实密钥/账号，绝不提交或外泄；示例值一律写进 `.env.example` / `accounts.example.xlsx`。

## 分层架构（依赖方向不可反向）

```
tasks → engine → {integrations, automation} → infrastructure
server → {engine, infrastructure}   （唯一例外：server 可对 tasks 做 type-only import）
src/app.ts 组装一切（compose root，只被 index.ts 调用）
```

- `infrastructure/`：config / logger(log4js) / db(本地 SQLite，libsql 本地引擎) / datasource(Excel 账号表) / http 封装
- `integrations/`：bitbrowser.ts（本地 API 默认 http://127.0.0.1:54345）、ai/（OpenAI 兼容客户端，默认 DeepSeek，供 AI 答题）
- `automation/`：能力库（每目录一个 `index.ts` 出口）——`dom/`（探针/竞速/刷新恢复/坐标点击）、`wallet/`（types 注册表 + metamask/petra 四动作 unlock/connect/sign/confirmTx + actions/login-flow 登录编排 + appkit 归一化）、`captcha/`（仅 Turnstile 方框点击）、`diag/`（步骤记录 + 失败诊断包）
- `engine/`：queue（运行队列契约 `RunEnqueuer`/`SessionTask` 类型）、window-pool（唯一调度器：跨任务复用窗口、每窗口任务集、内存/健康门禁、队列轮转）、memory-governor / global-health（内存水位与全局健康纯逻辑）、scheduler（自研 tick 定时调度：计划独立于任务，存 schedules 表）、window-runner（开窗→CDP 接管→顺序跑任务→关窗/keep-open，patchright 驱动）、task-context（任务运行时数据袋子：任务经 `src/api` 能力函数操作 `ctx`，不暴露命名空间）、state（状态机）、run-recovery（启动时结算被新 slot 取代的旧行、把崩溃残留 running 重置为 pending）
- `tasks/`：站点任务，只经 TaskContext 使用引擎能力
- `server/`：express 路由按资源分文件（routes/），统一 `{code,message,data}` 响应（server/http/response.ts 的 ok/fail + asyncHandler），错误走 HttpError → 统一错误中间件
- `web/`：React 18 + Vite 5 + antd 5 + react-query + react-router，页面在 web/src/pages/{dashboard,profiles,tasks,schedules,settings,docs}

## 新增/修改任务

权威手册是 `docs/API-GUIDE.md`（面板文档页也渲染它）——TaskMeta 字段全解、TaskContext 方法全解、常用模式/排错，写任务前先读对应章节。真机踩坑实录见 `docs/API-GUIDE.md` 第 6.7 节（真机经验，登录态判定/钱包弹窗/隐藏文件上传/卡死定位等，写新任务前必读）。

三步：在 `src/tasks/` 新建类继承 `SiteTask`（参考 `example-checkin.ts` 的逐行注释）→ 在 `src/tasks/index.ts` 的 ALL 数组登记（key 必须全局唯一）→ 重启生效。

要点：任务 = `meta`（key/name/url/wallet/timeoutSec/retry） + 可选 `login: LoginSpec`（声明式登录，`ctx.wallet.ensureLoggedIn` 执行）+ 可选 `action(ctx)`（默认 `run` 骨架：清理标签页 → `goto` 3 次重试 → `ensureLoggedIn` → `action`；多页等特殊流程可覆盖 `run`）；DOM 操作直接调 `ctx.page`（patchright），等待/恢复用 `ctx.recover`，竞速用 `ctx.race`，验证码用 `ctx.captcha.*`（仅 Turnstile 方框），截图用 `ctx.safeScreenshot`；成功必须显式断言；触发方式：手动（任务页「立即触发」= 全部启用窗口、看板行级「执行/重跑」= 单窗口单任务）+ 定时计划（「定时任务」栏目，到点全部启用窗口，错过不补跑、在途跳过）；`meta.enabled=false` 时手动触发 409；面板任务页开关写入本地库 task_states（运行时状态，换设备重置回代码默认值）。

**AI 帮写任务（元素清单式模板）**：用户按 `docs/API-GUIDE.md` 附录模板提交新任务时：① 筛选选择器（原始长选择器 → 稳定短选择器，优先 id/data-testid/按钮文案，多候选说明取舍）② 缺失关键信息（登录标志/成功判定/数据源列）一次性列全问题，不逐条追问、不瞎编 ③ 直接写代码（登录竞速/刷新恢复/钱包/领取循环按既有任务模式），真机闭环照常。用户给的是真值素材，不猜。

## 数据层

本地 SQLite（libsql file: 引擎），库文件 `storage.dbPath`（默认 `data/app.db`，已 gitignore），`src/infrastructure/db.ts` 的 AppDb 封装全部访问，表结构首次打开自动创建：`profiles`（窗口）、`runs`（窗口×任务×日期×slot 唯一，`batch_id` 归属运行批次；同时即运行队列，`not_before_ms` 控制队列到期/重试退避）、`batches`（运行批次）、`task_states`、`open_windows`（面板与 task:run 跨进程共享；`state` 区分 opening/open/closing，`owner_kind` 区分 pool/manual/taskrun，并记 `last_used_at`/`tasks_done`，窗口池用于复用、轮转与寿命回收）。WAL 模式支持多进程并发开库；启动时按 `storage.dbRetainDays`（默认 90）清理超期历史数据；截图按 `storage.screenshotRetainDays`（默认 3 天）在启动与每 6 小时清理超期日期目录。新增字段加 migrate 补列逻辑（老库兼容）。运行状态机：pending → running → success / retry_wait / captcha_failed / failed / skipped（`captcha_failed` 为历史遗留终态，无产生路径，保留状态机兼容；tests 与 db 均用注入隔离，不连真库）。

## 前端与 API 变更

后端路由有 @swagger 注解（src/server/openapi.ts 汇总）。`web/src/api/schema.d.ts` 由 `npx openapi-typescript http://127.0.0.1:3000/api/docs/openapi.json -o web/src/api/schema.d.ts` 生成，但项目先例是**手补类型**（多数计划如此执行）；前端发请求只走 `web/src/api/client.ts`/`endpoints.ts`，页面 hooks 放 `pages/<页>/hooks.ts`（hooks 配单测）。

## 文档同步（硬性要求）

**每次修改或新增功能，用户文档必须同步更新**，不是只写内部设计文档：

- `docs/API-GUIDE.md` 是面板「文档」页渲染的**唯一用户手册**，以下改动必须同步它：
  - 新增/修改 TaskMeta 字段或 TaskContext 方法 → 更新第 2/3 章对应小节
  - 新增/修改配置段或配置键 → 更新第 7 章配置速查（`scheduler` 段曾因此漏同步）
  - 新增/修改后端 API → 更新 §6 面板与排错中的接口说明（@swagger 注解也要同步写）
  - 新增/修改面板页面或功能 → 更新 8.2 面板使用（页面数量、新页说明）及相应章节
  - 新增工具（`src/tools/`）→ 更新第 11 章工具中心
- 真机踩坑经验 → 追加 `docs/API-GUIDE.md` 第 6.7 节（真机经验）
- 设计文档仍走 `docs/superpowers/specs/`，计划走 `docs/superpowers/plans/`；但它们是**内部文档**，不能替代上述用户文档
- 文档改动与代码同批提交，commit 用 `docs:` 前缀（中文描述）



## 代码风格

无分号、单引号、2 空格缩进、TS 严格模式；文件头中文注释块说明模块职责与依赖方向；命名用 camelCase，文件 kebab-case；日志用 logger（中文消息，格式 `logger.info({count}, '消息')`）。commit 风格 conventional：`feat:`/`fix:`/`chore:`/`docs:` + 中文描述。

### 命名规范（全项目统一，详见 `docs/superpowers/specs/2026-10-14-naming-conventions-design.md`）

- 标识符英文，注释/文档/commit 中文。
- 命名按层级：文件 `kebab-case`、类/接口 `PascalCase`、函数/变量 `camelCase`、常量 `SCREAMING_SNAKE_CASE`。
- 动作函数动词开头（`open`/`click`/`fill`/`wait`/`connect`…）；查询用 `getX`/`isX`/`hasX`。
- **类型/接口名禁用缩写**；导出即公共契约，命名同函数。
- 参数形状：**≥2 个可选参数 → 单个 `opts` 对象**；单一必填 → 位置参数。
- 布尔字段**肯定式**（`enabled`/`isX`/`hasX`），禁 `noX`/`disableX`。
- 时间带单位后缀（`Ms`/`Sec`/`Days`），同层统一；选择器字段以 `Selector` 结尾 / 文案用 `Text`；集合用复数。
- **不暴露第三方库/SDK/实现概念名**（如 appkit/reown/rainbowkit/w3m/scenario/intent/probe/spec/entry）；只说「站点上可见的行为」。
- 文件头注释块模板：一行模块职责 → `依赖方向：…` → 可选设计思路。
- 测试文件 `<模块>.test.ts`；用例名中文描述行为。
- `tests/api-docs-drift.test.ts` 守卫：`src/api/index.ts` 的每个导出名必须出现在用户手册 `docs/API-GUIDE.md`（改 API 出口要同步手册）。

## 真机验证规范（硬性执行）

任务写完/改完后的真机验证，严格按以下方式执行（2026-10-09 用户明确要求，后续一律照此）：

1. **批量真机验证剩余窗口**：新任务/改动用 `task:run` 逐个窗口验证（`BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<任务key> npm run task:run`），覆盖剩余未验证窗口；已签到/已答题的窗口由任务逻辑自适应（幂等）。
2. **开窗上限 4**：同时最多开 4 个窗口（受 `execution.windowPool.maxOpenWindows` 缺省 4 约束；手动并行验证时每次也最多同时跑 4 个窗口，跑完一批再下一批）。
3. **问题自解决 + 及时暂停**：遇到问题先自行排查解决；**若长时间无法解决（最多 3 分钟）或同一问题尝试 3 次仍失败，立刻暂停通知用户人工辅助**，不要反复派自动化重跑消耗窗口/额度。
4. **每次验证前清理残留进程、单入口执行（2026-10-09 用户明确要求）**：开始验证前先检查并结束**此前由 AI 启动但未关闭的 node 进程**（`task:run`、探针脚本、临时起的服务/后端），确认无残留再开跑；**不要同时运行多个程序**——用户手动的 dev/pm2 后端在跑时，**不要再并行起 `task:run`/第二个后端**，统一走一个执行入口（优先复用已在运行的 dev 后端 API 触发），验证结束立即停止自启进程。
5. **只验证「尚未关闭/尚未验证」的任务**：一次只推进未验证的窗口/任务，不重跑已完成的。

## 踩坑提醒

- 未捕获异常默认退出进程，但 CDP 会话级瞬时错误（Protocol error/session closed 等，见 src/app.ts TRANSIENT_PATTERN）只告警不退出——修 bug 时别把这类错误当致命
- 窗口连续 2 次**环境级**终态失败触发熔断（只计开窗/CDP/浏览器/扩展/网络类失败，任务业务失败不计；该窗口剩余任务 skipped）；熔断后普通环境失败 30 分钟起步指数退避到 2 小时，**代理连接类失败（`ERR_PROXY_*`/`ERR_TUNNEL_*`/`ERR_SOCKS_*`）3 分钟起步到 15 分钟**，半开用真实任务探测；每日 23:59 全量重置（`execution.circuitBreakerResetAt`），任一任务成功/面板手动也清零；代理失效由任务自身失败暴露（已无前置 IP 校验）。全局健康门禁只由比特 API `/browser/pids` 对账失败触发，单窗口代理/任务失败不拖停整个池
- 定时触发与手动触发共享在途守卫与窗口熔断：定时失败同样按环境/任务分类，只有环境级终态失败计入熔断（连续 2 次后该窗口当日剩余任务 skipped，含手动）
- 面板端口被占/改端口：改 `config/.env` 的 WEB_PORT/VITE_PORT 后重启 dev
- 比特浏览器必须在同一台机器运行且 API 已开启；无它无法联调，跑任务需真实环境
- 设计文档在 `docs/superpowers/specs/`（按日期），计划在 `docs/superpowers/plans/`；实现前可查对应 spec
- 运行队列以 `runs` 表为准：触发即写 `pending + not_before_ms`（立即到期）；窗口池调度器每秒对账窗口并按到期行分配任务（同一窗口同一时刻只跑一个任务）；开窗/分配由池容量、内存与全局健康共同裁决。`not_before_ms` 用于重试退避与排队到期，不再挂进程内定时器；`task:run` 不启动调度器，按行内 `not_before_ms` 自行等待
- **本地库一律经 `src/infrastructure/sqlite-client.ts` 访问，不要直接用 `@libsql/client` 本地 client**：它每次 `execute` 新建 prepared statement 且不释放（约 3.8KB/条）、`transaction()` 每次新开原生连接且从不关闭（约 178KB/次），长跑必然原生内存暴涨，定时触发叠加批量入队时进程以 `0xC0000005` 退出（2026-10-21 事故）。高频单行判断用 `AppDb` 内的 `first`/单行查询路径（`.all()` 每次调用也泄漏约 1KB，与行数无关）；新增批量写尽量在一个事务内完成
- 跨午夜排队残留：旧日期的 `pending/retry_wait` 不补跑，窗口池调度器跨日时统一结算为 `skipped`（错误「跨日未执行，已结算」）；旧日期已在运行的会话仅在进程存活期间继续跑完并按认领日期落终态（仍占额度），进程重启时 `recoverRuns` 调用 `settleOldRunningRuns` 把旧日期残留 `running` 结算为 `failed`（错误「跨日崩溃残留」），不续跑、不补跑。看板 ETA（`not_before_ms`）只是最早可调度下界，受池容量/内存/健康门禁与在途任务影响可能更晚
- 批量触发（任务页「立即触发」）、批次重跑、多窗口测试触发与定时触发都不再按窗口铺开：触发即写 `pending` 并立即到期。批次重跑（批次头/明细行）写回原批次并强制入队，不按当天成功跳过；批次统计与明细按每窗口最新一轮（`run.id` 最大）计算，历史轮次保留但只读。定时/批量/测试触发属于显式执行，不按当天成功跳过（否则 hourly 计划会退化成每天一次），定时计划用 `last_fired_minute` 持久化分钟去重；单窗口手动触发始终新建一轮可重跑。
- 窗口池是唯一调度器（始终启用）：窗口跨任务保持打开、同一窗口同一时刻只跑一个任务；任务无并发/顺序限制（所有已打开窗口可同时跑同一任务）；关闭窗口按最早 `queued_at` 排队轮转；内存/全局健康门禁不满足时只停止开窗/分配，任务保持 `pending`。面板手动打开且存活（有调试地址）的窗口会直接作为该窗口的工作者接任务，但不计入 `poolSize`、不参与轮转、不自动关闭。
- `not_before_ms` 用于重试退避与排队到期（触发即写当前时间到期），不用于初始延迟；单窗口入口（看板行级执行、task:run 脚本）同样立即到期。
- 开窗/关窗统一经进程内 `SerialQueue` 串行（两次开窗最小间隔 `execution.windowPool.openCooldownMs`，默认 10 秒；冷却只约束开窗，关窗不等待），关窗要等比特 `/browser/pids` 确认 pids 消失后才清 `open_windows` 登记；孤儿回收只处理 `state=open` 且归属进程已死的窗口，`opening/closing` 一律跳过，避免误关正在打开/关闭的窗口。窗口池调度器内置后台对账：`opening/closing` 超时会重探/重试关窗，池窗口 pids 消失会清行。
- 真机任务卡死/连续失败时：先读 `data/logs/app.log` 与窗口截图定位（日志静默期=卡在无日志的等待循环）；**连续 2 次失败或 10 分钟无进展 → 立刻请求人工接入**（带日志+截图问用户），不要反复派自动化重跑（见 `docs/API-GUIDE.md` 第 6.7 节（真机经验））
- 双后端实例会互相踩踏（2026-09-08 事故：旧 npm start 与新 dev 并存，定时计划双触发、同窗口双 CDP 会话、领水额度打乱）。已有单实例锁 `data/app.lock`（startApp 启动取锁，PID 存活检测自动接管残留锁）；报「检测到另一个后端实例正在运行」时先杀残留进程，确认无残留再删锁文件
- **AI 自行启动的 node 进程，用后必须关闭**：无论出于什么目的（跑测试、临时探针脚本、起服务验证等），用完立即停止，绝不能留着后台跑——否则会和用户手动启动的 dev/pm2 后端冲突（端口占用、双实例踩踏）
- **真机调试禁止频繁开关浏览器窗口**（2026-09-09 用户明确要求）：task:run 每次开窗/关窗、失败重试会再开——验证前先想清楚再跑，减少无效重试；多轮观察复用同一次会话（探针脚本开窗后别关，观察完再关）；站点请求计数常含失败请求，反复点 Send 会消耗当日限频额度
- **临时调试文件不入仓库根目录**：调试脚本/截图放 `C:\Users\PC\AppData\Local\Temp\opencode` 或 `data/`（已 gitignore），用后删除；任务正式截图走框架产物 `data/screenshots/`（gitignore 内）；任务失败截图是排障证据不是成功判定，别把截图里的提示当结论（2026-09-09 教训：误把限频响应截图当验证通过）
