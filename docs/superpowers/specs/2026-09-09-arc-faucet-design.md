# Arc 领水任务设计（faucet-arc）

日期：2026-09-09
状态：已确认（用户确认后直接实施）

## 目标

新增 faucet 任务 `faucet-arc`（面板名「Arc 领水」）：在 Circle 测试网水龙头 https://faucet.circle.com/ 为每个窗口的 MetaMask 钱包地址领取 20 testnet USDC（Arc Testnet）。不连钱包，地址取自数据源 `metamask钱包地址` 列（用户确认，任务单「数据源：文件地址列」为模板复制残留、「登录方式：metamask」与「不需要登录」矛盾，以后者为准）。每次领取可能触发 reCAPTCHA v2 挑战，走 yescaptcha 自动打码。限频文案不做判定（用户隔天执行一次，撞限频即异常失败）。

## 页面实测依据（2026-09-09 SSR HTML 抓取，非真机）

https://faucet.circle.com/ 为 Next.js App Router 服务端渲染页，表单结构已确认：

- Network 下拉：downshift 组合框，触发按钮 `button[name="network"]`（内含 `.field-display-value` 显示当前值，默认 "Arc Testnet"）；选项列表 `[role="listbox"] [role="option"]` 共 38 项（item id 带随机数字后缀，不可硬编码，按文本匹配）。列表 DOM 常驻，闭合时可见性待真机确认
- 币种：三张 radio 卡片（USDC/EURC/CIRBTC），`input[name="currency"][value="USDC"]` 默认 checked；卡片 `[data-testid="select-card-USDC"]`（注意三卡片 id 重复非法，禁用 id 选择器）
- 地址输入：`input[name="address"]`，placeholder "Wallet address"
- 提交按钮：`form button[type="submit"]`，文案 "Send 20 USDC"，地址校验通过前 disabled
- 验证码：reCAPTCHA v3 无形（sitekey `6LcNs_0p...`，页面常驻 api.js）+ v2 回退挑战（sitekey `6LcCqC8s...`，提交被拒后动态注入 iframe）；阈值 `reCaptchaThreshold: 0.7`，v2 提示文案 "We detect unusual traffic from your request. Please verify that you are not a bot and submit again."
- 成功文案：headline "Tokens sent" + "20 testnet USDC is on its way to your wallet and should appear shortly."（任务单判定文案）
- 限频："Limit: One request per pairing of asset and test network every 2 hours"（配置数据 limits.ms=3600000 即 1 小时，两者不一致，真机待确认；首版不做判定）

## 改动清单

### 1. `src/tasks/arc-faucet.ts`（新任务文件）

仿 `shelby-faucet.ts` 风格：模块级常量/辅助函数（导出供单测）+ 任务类。文件头中文注释块说明站点元素与流程。

- 常量：
  - `ADDRESS_SELECTOR = 'input[name="address"]'`
  - `NETWORK_BUTTON_SELECTOR = 'button[name="network"]'`
  - `NETWORK_DISPLAY_SELECTOR = 'button[name="network"] .field-display-value'`
  - `NETWORK_OPTION_SELECTOR = '[role="listbox"] [role="option"]'`
  - `CURRENCY_RADIO_SELECTOR = 'input[name="currency"][value="USDC"]'`
  - `CURRENCY_CARD_SELECTOR = '[data-testid="select-card-USDC"]'`
  - `SUBMIT_SELECTOR = 'form button[type="submit"]'`
  - `SUCCESS_TEXT = 'is on its way to your wallet and should appear shortly'`
  - `CAPTCHA_V2_TEXT = 'verify that you are not a bot'`（v2 挑战出现标志）
  - `TARGET_NETWORK = 'Arc Testnet'`
- 辅助函数（导出）：
  - `currentNetwork(ctx)`：读 `.field-display-value` 文本
  - `isUsdcChecked(ctx)`：读 radio checked 属性
  - `ensureNetwork(ctx)`：当前值非 Arc Testnet 时点击触发按钮 + 点击文本匹配的 `[role="option"]`，再校验显示值；已是则跳过
  - `ensureUsdc(ctx)`：radio 非 checked 时点 `[data-testid="select-card-USDC"]`，再校验；已是则跳过
  - `ensureSubmitEnabled(ctx)`：轮询等提交按钮 `isEnabled()`（上限 15s），超时抛错
- 验证码处理：
  - **不主动打 v3 码**（页面常驻 api.js，浏览器正常生成 token；盲目 solveCaptcha 会把 v3 脚本误判为目标白花点数）
  - 点 Send 后竞速：`CAPTCHA_V2_TEXT` 出现 / `SUCCESS_TEXT` 出现（`raceTexts`）
  - v2 出现 → `ctx.solveCaptcha()`（检测到 `iframe[src*="recaptcha/api2/anchor"]` 后解题回填）→ 再点 Send → 再竞速；仍 v2 → 抛错进重试
- `run(ctx)` 流程：
  1. `closeOtherTabs()` → `goto()` → `assertVisible(ADDRESS_SELECTOR, 20000)`
  2. `ctx.account('metamask钱包地址')` 严格读取 → `fill` 直填
  3. `ensureNetwork` → `ensureUsdc` → `ensureSubmitEnabled`
  4. 点 Send → 竞速（成功文案 / v2 文案，30s）
  5. v2 → `solveCaptcha()` → 再点 Send → 再竞速（30s），v2 再现抛错
  6. 成功文案出现 → 截图 `arc-faucet-success`（try/catch，失败只 warn 不判失败）
- meta：key `faucet-arc`、name `Arc 领水`、url/sourceUrl `https://faucet.circle.com/`、category `faucet`、lastUpdated `2026-09-09`、enabled `true`、不配 wallet、timeoutSec `240`、retry `{ max: 2, backoffSec: 120 }`、captcha `{ auto: true }`、concurrency `3`（公共水龙头，保守并发）
- note：记录全部真机核实事实（选择器、v3/v2 机制、成功文案、限频待定）

### 2. `src/tasks/index.ts`

- ALL 数组登记 `new ArcFaucetTask()`

### 3. 测试（`tests/arc-faucet.test.ts` 新建）

- 单测（注入 fake ctx，不连真浏览器）：
  - `ensureNetwork`：已是 Arc Testnet 不点击；非默认则点按钮+选项并二次校验；选择后仍非 Arc Testnet 抛错
  - `ensureUsdc`：已 checked 不点击；未 checked 点击卡片
  - `ensureSubmitEnabled`：按钮 disabled → enabled 轮询通过；超时抛错
  - meta 断言：key/name/category/enabled/concurrency 3/timeoutSec 240/captcha.auto true/retry 值
- 集成测试（本地 chromium + fixture + page.route，仿 shelby-faucet.test.ts）：
  - fixture 页面含完整表单（network 下拉默认 Arc Testnet、USDC checked、地址输入、disabled 提交按钮，fill 地址后 route 侧 JS 或测试侧解禁按钮）
  - 链路 1（无验证码）：点 Send → 成功文案出现 → run 成功
  - 链路 2（v2 挑战）：点 Send → 页面注入 v2 文案 + 假 recaptcha iframe（route 拦截 yescaptcha 平台接口返回 ready token，或注入 fake captcha service）→ 再点 Send → 成功文案 → 断言 solveCaptcha 被调用一次
  - 链路 3（v2 再现）：第二次提交仍 v2 → 抛错

### 4. 真机验证（窗口 100，实现后执行）

- `npm run task:run`（`BITBROWSER_PROFILE_ID=57acfefad5f94c449afe35397f97e45f` + `TASK_KEY=faucet-arc`）跑一次
- 确认点：① Network/USDC 默认值校验不误改 ② 地址 fill 后按钮 enabled ③ v2 挑战触发与打码回填 ④ 成功文案出现 ⑤ 若撞限频（窗口 100 已在 1-2 小时内领过），改另一窗口或等冷却再验
- 验证结论（v2 触发概率、限频实际文案/时间）追加 `docs/TASK-DEVELOPMENT-LESSONS.md`；若限频文案稳定可识别，后续可补「限频=成功」判定（本次不做）

### 5. 文档同步

- 无 TaskMeta/配置/API/面板变更，API-GUIDE 无需更新；真机经验追加 LESSONS（与代码同批提交，`docs:` 前缀）

## 范围外

- 限频判定（用户隔天执行一次，撞限频即失败）
- 接口直连/双判定（方案 C，真机验证抓到稳定接口后再议）
- EURC/CIRBTC 币种支持（任务单只要求 USDC）
