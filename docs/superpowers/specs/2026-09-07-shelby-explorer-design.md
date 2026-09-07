# Shelby Explorer 上传任务设计（xyz-shelbynet）

日期：2026-09-07
状态：已确认（用户确认后直接实施）

## 目标

新增任务 `xyz-shelbynet`（面板名「shelbynet 领水和任务」）：在 Shelby Explorer（https://explorer.shelby.xyz/shelbynet）用 Petra 钱包登录后，完成「上传文件」任务，成功判定为页面出现 `All files uploaded successfully`。可重复任务（每次执行都走完整上传流程，无「已领取」短路）。

范围说明：任务名含「领水」，但用户确认本任务只做上传文件；领水已由独立任务 `shelby-faucet` 覆盖（docs.shelby.xyz）。

## 关键事实与依据

- 站点为 Next.js SPA（静态 HTML 不含上传流程文案，需登录后才渲染）
- 数据源 `config/accounts.xlsx` 已新增「文件地址」列（用户 2026-09-07 添加），每窗口一个本地文件绝对路径（如 `C:\Users\PC\Desktop\空投文件\...\xxx.png`，文件名含 `!` `$` `+` 等特殊字符）
- 登录方式 Petra：用户描述的登录流程（Connect Wallet → 站内弹窗选 Aptos/Petra → Connect → 可能直接登录；未登录过则 Petra 扩展弹窗输密码 Unlock → Approve）与现有 `portal-rhuna` 的 Petra 登录范式一致
- 上传时两次钱包确认：Upload 按钮点击后出现「Uploading files…」+ 第一个钱包 Approve 弹窗 → 点 Approve 后又弹第二个钱包 Approve 弹窗 → 点 Approve 后变为 `All files uploaded successfully`
- 网络切换（Petra 当前网络是否为 Shelbynet）：用户不确定，需真机验证——见「真机验证关卡」
- 来源页：https://cryptorank.io/zh/drophunting/shelby-activity1120

## 方案选择

- 方案 A（选定）：新建独立任务文件 `src/tasks/shelby-explorer.ts`，复用引擎能力（detectPageState / loginByWallet / uploadFile / waitForText 等），选择器先最佳猜测再真机核实迭代
- 方案 B（否决）：并入 `shelby-faucet.ts`——两个流程耦合，拖累领水任务稳定性，且 key 不同
- 方案 C（否决）：引擎级「上传+双钱包确认」封装——仅此一个任务用到，YAGNI

## 改动清单

### 1. `src/tasks/shelby-explorer.ts` 新建

meta（TaskMeta）：

- key `xyz-shelbynet`、name `shelbynet 领水和任务`、url `https://explorer.shelby.xyz/shelbynet`
- sourceUrl `https://cryptorank.io/zh/drophunting/shelby-activity1120`
- category `checkin`、lastUpdated `2026-09-07`、enabled `true`
- wallet `petra`、timeoutSec `600`（上传大文件 + 双签名耗时）
- retry `{ max: 2, backoffSec: 120 }`、captcha `{ auto: true }`、concurrency `4`

run 流程（选择器为最佳猜测，真机核实后修正）：

1. `closeOtherTabs()` → `goto()`
2. 登录态竞速：`detectPageState({ loggedInText: '0x', landingText: 'Connect Wallet', waitMs: 20000 })`；已登录（cookie 有效）跳过登录
3. 未登录：`ensureWalletReady()` → 点 header 的 Connect Wallet 按钮（radix dialog-trigger）→ 站内弹窗（Aptos 分区 → Petra 入口 + 右侧 Connect 按钮）→ 点 Petra 入口 → `loginByWallet({ reclick })`（Petra 扩展弹窗输密码 + Unlock → Approve）→ `waitForTextRecover('0x', { budgetMs: 60s, refreshEveryMs: 25s, recoverTexts: [Network Error 等] })`
   - 若真机确认弹窗为 AppKit（Reown）结构，改用 `openAppKitWallet`
4. 【网络核对 · 真机验证关卡】确认 Petra 当前网络是否为 Shelbynet：
   - 若登录时站点发起 switchNetwork/addNetwork 弹窗 → 已被第 3 步钱包弹窗处理覆盖，无需额外代码
   - 若不会自动切换 → 增加切换步骤：打开 Petra 扩展 popup 页 → 点网络选择器 → 选 Shelbynet（届时真机定选择器）
5. 点头部 0x 地址按钮 → 页面变化 → 等「Upload Files」出现（waitForText，含刷新恢复）
6. 点 Upload Files → 上传弹窗出现
7. 选文件：`ctx.uploadFile('input[type="file"]', await ctx.account('文件地址'))`（严格模式：缺列/空值即失败，防拿错文件上传）；弹窗若为拖拽区无 file input，真机确认后换选择器
8. 点弹窗内 Upload 按钮
9. 双钱包确认：`loginByWallet()` ×2（第一个 Approve 弹窗关闭后等第二个弹窗再 Approve；Petra 适配器 ensureConnected 自动点 Approve 至弹窗关闭）
10. `waitForText('All files uploaded successfully', 60s)` 即成功 → `screenshot` 留档

要点：每步失败抛错 → 走 retry（120s 退避 ×2）；网络错误文案沿用 portal-rhuna 的刷新恢复策略；无验证码显式处理点（captcha auto 保留为兜底）。

### 2. `src/tasks/index.ts`

- ALL 数组登记 `new ShelbyExplorerTask()`

### 3. 测试（`tests/shelby-explorer.test.ts` 新建）

- 单测（注入 fake ctx，秒级反馈，不连真浏览器，借鉴 portal-rhuna.test.ts / shelby-faucet.test.ts）：
  - 已登录分支：detectPageState 返回 loggedIn → 跳过登录直接进上传流程
  - 未登录分支：点 Connect Wallet → loginByWallet 被调用
  - 双弹窗确认顺序：登录 1 次 + 上传后 Approve 2 次（loginByWallet 共 3 次调用）
  - 成功断言：`All files uploaded successfully` 出现 → run 正常返回；超时 → 抛错
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
