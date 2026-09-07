# Shelby 领水任务提速与合并设计（shelby-faucet）

日期：2026-09-07
状态：已确认（用户确认后直接实施）

## 目标

将 `shelby-apt-faucet` / `shelby-usd-faucet` 合并为单任务 `shelby-faucet`（面板名「Shelby 领水」），一次开窗完成两页领水（APT 5 次 + ShelbyUSD 5 次），并落地四项提速/健壮性优化；任务级与全局窗口并发上限提到 6。旧两个 key 作废删除。

## 实测依据（2026-09-07 真机批次）

- 单任务平均 67s（55-81s）：开窗+导航+填表约 25-30s（重复开销）；领取循环约 35-40s（拟人点击 0.8-3s + 领取间隔 3-8s + 接口 1-2s）
- 每窗口两任务串行且各开各窗 → 每窗口每天 ≈134s
- 失败约 7%（5/75 窗口 retry_wait，600s 退避）：
  - 「第 2 次领取 /fund 响应超时」（窗口 40/55/69/74/75，全是 APT 第 2 次）——第 1 次成功 toast 插入后布局位移，第 2 次点击落空、请求未发出
  - 窗口 79：`page.screenshot ... waiting for fonts to load` 30s 超时——任务自身 `ctx.screenshot` 抛错致整 run 失败（框架自动截图已非致命，见 window-runner.ts:321 的 `.catch(() => null)`）

## 改动清单

### 1. `src/tasks/shelby-faucet.ts` 重写（合并 + 提速 + 健壮性）

- 删除 `ShelbyAptFaucetTask` / `ShelbyUsdFaucetTask`，新增 `ShelbyFaucetTask`：
  - key `shelby-faucet`、name `Shelby 领水`、url 为 APT 文档页、sourceUrl 两文档页数组、category `faucet`、lastUpdated `2026-09-07`、enabled `true`、不配 wallet、timeoutSec 300、retry `{ max: 2, backoffSec: 120 }`（短退避：服务端计数幂等）、captcha `{ auto: true }`、concurrency 6
  - 类属性 `usdUrl = 'https://docs.shelby.xyz/apis/faucet/shelbyusd'`（独立于 meta.url，供集成测试覆盖）
- 常量调整：
  - `FUND_WAIT_MS` 30s → 10s（判定补点用，真机响应 1-3s）
  - `CLAIM_GAP_MIN_MS/MAX_MS` 3-8s → 1-2s
  - 新增 `RECLICK_MAX = 1`（响应超时最多补点一次）
- 地址填充：`fill('')` 清空 + `fill(addr)` 直填，替代 `typeInto` 逐键（等价粘贴；服务端 checker 计次不管输入节奏，反检测风险可忽略）
- run 流程：
  1. `closeOtherTabs()` → `goto()`（APT 页）→ 等 `input[name="address"]` 可见 → `fill('')` + `fill(addr)` → `runClaimLoop(ctx, addr, 5)`
  2. `goto(usdUrl)`（USD 页）→ 等表单 → `fill('')` + `fill(addr)` → `runClaimLoop(ctx, addr, 5)`
  3. 成功截图 `try/catch`——截图失败 log warn，不判任务失败（留档产物，非业务成功条件）
- `runClaimLoop` 增强（原孤儿 waitForResponse 修复保留）：
  - 注册 `waitForResponse(POST + faucet.shelbynet.shelby.xyz/fund, 10s)` → 点击 → await
  - 响应超时 → 拟人补点一次（重新注册 waitForResponse 10s）→ 仍超时抛「第 N 次领取失败（等待 /fund 响应超时）」
  - 输入框空则回填（保留）；success/limit/rejected 判定与达上限提前退出不变
- note 更新：两页各 5 次、共享 10 次/天、达上限视为成功（重跑幂等）、成功响应 txn_hashes 非空、点击落空自动补点一次（残余风险：极慢响应下补点可能多领一次，但限额提前退出使任务自校正，最多造成两币种额度微偏）、网络选择器保持默认 Shelbynet、无验证码、不连钱包

### 2. `src/tasks/index.ts`

- ALL 数组：移除两旧实例，登记 `new ShelbyFaucetTask()`

### 3. `config/config.json`

- `execution.maxConcurrentWindows` 4 → 6（全局开窗上限，与任务级 concurrency 6 双闸门对齐；6 窗口并发内存/CPU 更高，机器顶得住）

### 4. 测试（`tests/shelby-faucet.test.ts` 更新 + fixture 更新）

- 单测：
  - `runClaimLoop` 补点路径：① 首响应超时 → 补点后成功（claimed 计数 1，click 调 2 次）② 补点仍超时 → 抛「等待 /fund 响应超时」③ 正常响应不补点
  - 原点击失败 unhandledRejection 回归测试保留
  - `judgeFundResponse` 四分支保留
  - 新增 meta 断言：key `shelby-faucet`、name `Shelby 领水`、concurrency 6、retry.backoffSec 120、usdUrl 默认值
- 集成测试更新：fixture 按页面路径发请求（`/aptos` 页发 `/fund`，`/usd` 页发 `/fund?asset=shelbyusd`）；路由拦截前 5 次（APT）成功、USD 第 3 次返回 429 上限 → 断言总拦截数 8（5 + 2 成功 + 1 上限）、run 成功；`task.meta.url` 与 `task.usdUrl` 均指向本地 fixture

### 5. 文档与运维

- 面板「定时任务」中引用旧 key 的计划需用户手动更新为新 key `shelby-faucet`（scheduler 对缺失 key 跳过，不会报错）
- 旧 key 的历史 runs 留在库里作历史记录
- 真机验证：窗口 5（`52b8efce7f1846d285cdf24f1137e367`，当日未消耗）跑 `task:run` 一次：期望 APT 5 次 + USD 5 次全部成功；复跑一次验证「已达上限=成功」收敛
