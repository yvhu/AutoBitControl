# Shelby Explorer 上传任务设计（xyz-shelbynet）

日期：2026-09-07
状态：已确认（用户确认后直接实施）

## 目标

新增任务 `xyz-shelbynet`（面板名「shelbynet 上传任务」）：在 Shelby Explorer（https://explorer.shelby.xyz/shelbynet）用 Petra 钱包登录后，完成「上传文件」任务。成功判定两条：① 页面出现 `All files uploaded successfully`（新上传成功）；② 页面出现 `Error: Blob name already taken`（该文件已上传过——每窗口的文件 blob name 唯一、只能传一次，重复上传即报此错误，视为「已上传=成功」，幂等收敛）。

范围说明：任务名含「领水」，但用户确认本任务只做上传文件；领水已由独立任务 `shelby-faucet` 覆盖（docs.shelby.xyz）。

## 关键事实与依据

- 站点为 Next.js SPA（静态 HTML 不含上传流程文案，需登录后才渲染）
- 数据源 `config/accounts.xlsx` 已新增「文件地址」列（用户 2026-09-07 添加），每窗口一个本地文件绝对路径（如 `C:\Users\PC\Desktop\空投文件\...\xxx.png`，文件名含 `!` `$` `+` 等特殊字符）
- 登录方式 Petra：用户描述的登录流程（Connect Wallet → 站内弹窗选 Aptos/Petra → Connect → 可能直接登录；未登录过则 Petra 扩展弹窗输密码 Unlock → Approve）与现有 `portal-rhuna` 的 Petra 登录范式一致
- 上传时两次钱包确认：Upload 按钮点击后出现「Uploading files…」+ 第一个钱包 Approve 弹窗 → 点 Approve 后又弹第二个钱包 Approve 弹窗 → 点 Approve 后变为 `All files uploaded successfully`
- **文件一次性（用户 2026-09-07 实测补充）**：每窗口的文件（blob name）只能发送一次；已提交过的窗口再上传会报 `Error: Blob name already taken`——该文案出现视为「已上传=成功」，不判失败
- **真机核实（2026-09-07，窗口 4e6bc67b83a840c7b665d2723c4837f0）**：已上传路径两次跑通（日志「文件已上传过…视为成功」+ 成功截图）；新上传路径待未提交窗口验证
- 网络：钱包网络已是 Shelbynet（真机核实结论），无需切链步骤
- 来源页：https://cryptorank.io/zh/drophunting/shelby-activity1120

## 方案选择

- 方案 A（选定）：新建独立任务文件 `src/tasks/shelby-explorer.ts`，复用引擎能力（detectPageState / loginByWallet / uploadFile / waitForText 等），选择器先最佳猜测再真机核实迭代
- 方案 B（否决）：并入 `shelby-faucet.ts`——两个流程耦合，拖累领水任务稳定性，且 key 不同
- 方案 C（否决）：引擎级「上传+双钱包确认」封装——仅此一个任务用到，YAGNI

## 改动清单

### 1. `src/tasks/shelby-explorer.ts` 新建

meta（TaskMeta）：

- key `xyz-shelbynet`、name `shelbynet 上传任务`、url `https://explorer.shelby.xyz/shelbynet`
- sourceUrl `https://cryptorank.io/zh/drophunting/shelby-activity1120`
- category `checkin`、lastUpdated `2026-09-07`、enabled `true`
- wallet `petra`、timeoutSec `900`（登录静默连接 + 会话恢复慢（真机 30-90s）+ 上传大文件 + 双签名，放宽单次超时）
- retry `{ max: 2, backoffSec: 120 }`、captcha `{ auto: true }`、concurrency `4`

run 流程（真机核实后定稿）：

1. `closeOtherTabs()` → `goto()`
2. 登录态判定：自定义 `detectHeaderState` 做 header 范围选择器竞速（header 0x 地址按钮 vs header Connect Wallet 谁先出现）；不能用 `detectPageState` 的全页 0x 文案判定（首页表格全是 0x 文案）；SPA 渲染延迟下状态不明则刷新重试（最多 10 轮）；已登录（cookie 有效）跳过登录
3. 未登录：`ensureWalletReady()` → 点 header Connect Wallet → 站内钱包弹窗为 Petra Web（Aptos Labs）自定义弹窗（非 AppKit）：`[role="dialog"]` 出现 → 点弹窗内 Connect（Aptos 标签默认激活 = Petra 入口）→ 本窗口扩展已授权时静默连接（无扩展弹窗，容忍「钱包弹窗未出现」不判失败）→ 等 header 0x 地址出现（登录结果唯一判定）
4. 【网络核对 · 已核实结论】钱包网络已是 Shelbynet，无需切链步骤（原「网络核对真机验证关卡」已关闭）
5. 上传入口：`goto` 账号页 `https://explorer.shelby.xyz/shelbynet/account/<petra钱包地址>/blobs`（地址取自数据源「petra钱包地址」列，严格模式；点 header 地址是下拉菜单，无上传入口）→ 等 Upload Files 按钮出现（会话恢复慢真机 30-90s，周期刷新 + 可恢复错误刷新兜底；未恢复则在账号页重新登录后重等）
6. 点 Upload Files → 上传弹窗出现（SPA 渲染未稳点击可能落空，最多 2 轮补点）
7. 选文件：上传弹窗 file input 为隐藏元素（class=hidden，setInputFiles 可用，用 DOM 挂载判定不用可见性）→ `ctx.uploadFile('[role="dialog"] input[type="file"]', await ctx.account('文件地址'))`（严格模式：缺列/空值即失败，防拿错文件上传）；选文件后站点立即做 blob 名查重：
   - 已上传 → 弹窗直接显示 `Error: Blob name already taken` 且 Upload 按钮永不启用、不发起签名 → 短路视为成功（不点 Upload，截图留档）
   - 未上传 → chunkset 结算后 Upload 按钮才启用
8. 点弹窗内 Upload → 第一次 Petra prompt.html 签名弹窗出现（可能锁屏：Petra 适配器输密码 + Unlock → Approve，register_multiple_blobs）
9. 第二次 Petra prompt.html 签名弹窗出现 → 直接 Approve（commit_object）；弹窗未出现容忍（上传途中服务端查重报已上传时站点可能不再发起签名），终态交给 waitSuccess
10. 等待终态（waitSuccess 循环）：
    - `All files uploaded successfully` 出现 → 新上传成功
    - `Blob name already taken` 出现 → 文件已上传过，视为成功（幂等收敛，同样截图留档）
    - 可恢复错误（Network Error 等）且不在上传中 → 刷新恢复；超时 → 抛错进失败重试

要点：每步失败抛错 → 走 retry（120s 退避 ×2）；上传中不刷新防打断在途请求；成功截图等字体加载偶发超时非致命化（只告警）；网络错误文案沿用 portal-rhuna 的刷新恢复策略；无验证码显式处理点（captcha auto 保留为兜底）。

### 2. `src/tasks/index.ts`

- ALL 数组登记 `new ShelbyExplorerTask()`

### 3. 测试（`tests/shelby-explorer.test.ts` 新建）

- 单测（注入 fake ctx，秒级反馈，不连真浏览器，借鉴 portal-rhuna.test.ts / shelby-faucet.test.ts）：
  - 已登录分支：detectPageState 返回 loggedIn → 跳过登录直接进上传流程
  - 未登录分支：点 Connect Wallet → loginByWallet 被调用
  - 双弹窗确认顺序：登录 1 次 + 上传后 Approve 2 次（loginByWallet 共 3 次调用）
  - 成功断言：`All files uploaded successfully` 出现 → run 正常返回；超时 → 抛错
  - 已上传判定：`Blob name already taken` 出现 → run 正常返回（视为成功）；同时与「上传中不刷新」分支正交验证
  - 数据源严格模式：`ctx.account('文件地址')` 缺列/空值抛错
- 集成测试（沿用 shelby-faucet.test.ts 模式：本地 chromium + fixture + page.route 拦截）：fixture 模拟落地页 → 上传弹窗 → 成功文案，验证全链路

### 4. 真机验证（关键，比特浏览器在本机）

1. `BITBROWSER_PROFILE_ID=<窗口> TASK_KEY=xyz-shelbynet npm run task:run` 单窗口跑
2. 核对：登录弹窗结构（AppKit 还是自定义）、Petra 网络是否自动切到 Shelbynet、上传弹窗是否有 file input、双 Approve 弹窗时序
3. 按实际页面修正选择器，再跑一次确认成功
4. 面板看板行级「执行」抽查 + 截图核对

## 验证方式

- `npm run typecheck`、`npm test` 全过
- 真机单窗口 task:run 成功（成功截图含 `All files uploaded successfully`）
