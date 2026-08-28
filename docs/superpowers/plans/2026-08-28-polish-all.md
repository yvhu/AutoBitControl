# AutoBitControl 全量打磨实施计划（2026-08-28）

> 用户指令：直接实现所有未完成项；钱包密码走环境变量；task_states 表不动。
> 全局约束：`npm test` 全绿 + `npm run typecheck` 干净；中文注释规范延续；行为不变原则仅限重构项，本计划明确列出行为变化。

## Task A: 钱包密码环境变量化

- config 增加 `wallet: { passwords: Record<string, string> }`：来源 `config.local.json` 的 `wallet.passwords` 与 `.env` 的 `WALLET_PASSWORDS`（JSON 字符串，形如 `{"窗口ID":"密码",...}`），env 优先合并
- `.env.example` 增 `WALLET_PASSWORDS={}`
- db.ts：profiles 表删除 `wallet_password` 列（SQLite 用 ALTER TABLE DROP COLUMN 需要版本；更简单：表重建迁移——但用户说库不重要，直接修改 SCHEMA 定义 + 说明"升级需删除 data/ 或由代码检测旧列并重建"；实现取简单方案：检测 `PRAGMA table_info(profiles)` 含 wallet_password 则执行 ALTER TABLE DROP COLUMN（SQLite ≥3.35 支持），better-sqlite3 12 内置 SQLite 版本满足）；ProfileRow 移除 walletPassword；setProfileWalletPassword 删除
- engine/task-context.ts：loginByWallet 密码来源改为 `deps.walletPasswords[profile.bitbrowserId]`（TaskContextDeps 增加 `walletPasswords: Record<string, string>`）
- engine/window-runner.ts：WindowRunnerDeps 增加 walletPasswords 并透传
- src/app.ts：`walletPasswords: cfg.wallet.passwords` 注入 WindowRunner
- server/routes/profiles.ts：PATCH 不再处理 password；profiles GET 不返回密码
- 面板 profiles.js 抽屉：密码行改为 `钱包解锁密码：由环境变量 WALLET_PASSWORDS 配置（重启生效）`，删除设置/修改入口；app.js 删 abcPassword 桥
- 手册第 4 章更新密码配置说明
- 测试：config.test.ts（WALLET_PASSWORDS 解析/合并）、db.test.ts（无密码列/迁移）、task-context 相关测试更新、web.test.ts（PATCH password 用例删除或改为 400）

## Task B: 小修集（DB/校验/安全/清理）

1. db.ts captchaStats 用本地日期过滤：`WHERE date(created_at, 'localtime') = ?`
2. config.ts WEB_PORT 非法值校验（NaN 回退默认并 warn？无 logger——非法则忽略并保留默认）
3. db.ts upsertRun 内部 existing 查询补 profileName（JOIN）
4. tests/db.test.ts 删未用 import
5. tests/bitbrowser.test.ts 补 URL 断言（listBrowsers/health）
6. server 全部路由 `req.body` 访问加 `?? {}`（Express 5 bodyless 安全）
7. screenshots 路由：realpathSync 防符号链接逃逸
8. screenshots 路由：startsWith 前统一小写（盘符大小写）
9. web.test.ts 补 rerun-failed 用例
10. scripts/smoke-wallet.ts 弹窗超时 exitCode=1
11. src/app.ts 删死代码 `if (!yescaptcha) return null`
12. src/app.ts shutdown 增加 http server close（listen 返回 server，shutdown 里 `server.close()` 后再 exit）
13. scheduler.ts start() 重入保护（已 start 再次调用先 stop 或直接跳过）
14. wallet/popup.ts finish 时 clearTimeout(timeout handle)
15. wallet.test.ts 补 ensureConnected 3 次耗尽用例

## Task C: 执行引擎增强（行为变化，各带测试）

1. **重试不占窗**：window-runner runTask 遇到 retry_wait 不再 sleep 占窗；WindowRunnerDeps 增 `scheduleRetry(profile, taskKey, delayMs)`；app.ts 注入（setTimeout → enqueuer.enqueue）。retry_wait 后立即 return（本轮窗口继续下一个任务/正常关窗）
2. **重试前页面复位**：每次新 attempt（非首次）先 `page.goto('about:blank')`（catch 忽略），避免上一轮残留操作干扰
3. **windowTimeoutMs 生效**：runWindowTasks 循环内检查截止时间，超时剩余任务标 skipped
4. **午夜跨天错峰**：pickRandomTimeInWindow 支持 end<start（跨天窗口）
5. **错峰每日重随机**：scheduler 对 stagger 任务注册 00:01 的 cron，触发时停旧任务 cron 并重选新时间；stop() 一并清理
6. window-runner finally 中 connected.close() 加 .catch 保护
7. yescaptcha getResult 轮询遇 errorId!==0 立即抛错（fail fast）
8. humanize.ts minDelay/maxDelay 实际使用（click 前置 hesitation 用 min/max 延迟）
9. captcha 检测器补 recaptcha v3：`script[src*="recaptcha/api.js"]` 的 src 提取 `render=` sitekey；yescaptcha 支持类型已有
10. tests：captcha.test.ts 补 detectCaptcha（fake page）+ applyToken 逻辑（fake page with evaluate mock）+ v3 检测；humanize/task-base 测试浏览器 try/finally 收尾
11. config.ts：storage 相对路径已绝对化（核对，如未则补）

## Task D: 前端交互与运维

1. 全局错误 toast：app.js 顶部固定 toast 元素；api.js 抛错时经 app.js 的 handler 显示（避免 api.js 直接操作 DOM：app.js 注册 `window.addEventListener('unhandledrejection')` + api.js 抛 Error 由调用方 catch？简化：api.js 保留 throw，app.js 全局 unhandledrejection 监听器显示 toast）
2. 面板轮询竞态：dashboard.render 入口加 in-flight 守卫（上一轮未完成则跳过本轮）
3. 「同步比特浏览器」按钮恢复：新增 `POST /api/bitbrowser/sync`（listBrowsers → upsertProfile → 返回数量），profiles 页按钮调用后刷新
4. 前端补漏 XSS：tasks 视图 option 与 drawer 插值 esc（核对已有，缺则补）
5. package.json：pino-pretty 移入 dependencies
6. pm2 真机验证：安装/检测 pm2，`pm2 start ecosystem.config.cjs` 跑通后记录到 README（若本机无 pm2 且安装失败，则 README 标注"未验证"并报告）
7. README：Windows 乱码说明（chcp 已内置脚本，说明即可）+ 钱包密码 .env 说明
