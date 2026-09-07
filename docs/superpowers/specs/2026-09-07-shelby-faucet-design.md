# Shelby 领水任务设计（shelby-apt-faucet / shelby-usd-faucet）

日期：2026-09-07
状态：已确认（用户确认后直接实施）

## 目标

新增两个 faucet 任务，为每个窗口的 Petra 钱包地址领水：

- `shelby-apt-faucet`：https://docs.shelby.xyz/apis/faucet/aptos 领取 APT
- `shelby-usd-faucet`：https://docs.shelby.xyz/apis/faucet/shelbyusd 领取 ShelbyUSD

每次 run 循环最多领取 5 次（与服务端限额约定一致：**每币种 5 次 / 每窗口每 IP 合计 10 次/天**），达到当日上限提前退出并视为成功。钱包地址按窗口从 `config/accounts.xlsx` 的「petra钱包地址」列读取，不连接钱包插件。

## 真机核实（本次探索实测沉淀，2026-09-07）

窗口 1/2（机会已用完）只收集限制形态；窗口 3 各实测成功 1 次（消耗当日额度 2/10）：

- 两页面结构相同：地址输入框 `input[name="address"]`（placeholder "Address"）+ 网络选择器（默认 Shelbynet，无需切换，选项另有 Local）+ `Fund` 按钮（`button:has-text("Fund")`）
- 领水接口：APT 为 `POST https://faucet.shelbynet.shelby.xyz/fund`；ShelbyUSD 为 `POST .../fund?asset=shelbyusd`（浏览器跨域调用，来自文档页）
- 成功形态：HTTP 200 `{"txn_hashes":["<hash>"]}`（非空）；页面出现 `Funding successful! View in explorer`
- 达上限形态：HTTP 429 `{"message":"Request rejected by 1 checkers","error_code":"Rejected","rejection_reasons":[{"reason":"You have reached the maximum allowed number of requests per day: 10","code":"UsageLimitExhausted"}],"txn_hashes":[]}`；APT 页出现 `Request to [Faucet]: POST ... failed with: ...`，USD 页出现 `Failed to fund account: Error: ...`
- 页面加载与点击全程**未出现验证码/iframe**（服务端 checker 计费式拒绝）
- 窗口 1/2 各自独立耗尽 → 限额按窗口 IP 计（各窗口代理独立，互不影响）

## 实现方案

浏览器 UI 驱动 + 接口响应断言（与手动行为一致，IP/指纹/代理同源）：

- 不用 `ctx.waitForApi`（其谓词只匹配 URL 片段，不区分方法，会被 CORS 预检等误命中）——任务里直接用 `ctx.page.waitForResponse(r => r.url().includes('faucet.shelbynet.shelby.xyz/fund') && r.request().method() === 'POST')`，限定 host 同时防御「网络选择器残留 Local」的异常
- 不用页面文案断言成功（连续领取时成功 toast 累积，无法区分新旧）——以接口响应体判定

## 改动清单

### 1. `src/tasks/shelby-faucet.ts`（新任务文件，含两个任务类）

共享领取循环辅助函数 `claimLoop(ctx, maxClaims)`，返回 `{ claimed: number }`；两个 SiteTask 子类 `ShelbyAptFaucetTask` / `ShelbyUsdFaucetTask`（差异仅 meta 的 key/name/url 与 note）。

meta 要点：

- key：`shelby-apt-faucet` / `shelby-usd-faucet`；name：`Shelby APT 领水` / `Shelby ShelbyUSD 领水`
- url：两个文档页 URL；sourceUrl 同 url；lastUpdated `2026-09-07`
- category `faucet`；enabled `true`（面板开关可覆盖）
- **不配置 wallet**（只填地址，不连钱包）
- timeoutSec 300（5 次领取 + 导航余量）；retry { max: 2, backoffSec: 600 }；captcha { auto: true }；concurrency 4
- note 记录：共享 10 次/天限额、每币种最多 5 次约定、达上限视为成功、成功文案与接口形态

run 流程：

1. `closeOtherTabs()` → `goto()`
2. 等 `input[name="address"]` 可见（表单就绪）
3. `const addr = await ctx.account('petra钱包地址')` —— 严格模式：数据源缺行/缺列/空值抛错即任务失败（数据没备齐不该硬跑）
4. 填地址：先 `fill('')` 清空（防重试会话残留值），再 `typeInto('input[name="address"]', addr)` 拟人逐键输入
5. 循环最多 5 次（`MAX_CLAIMS_PER_RUN = 5` 常量，注释说明与限额约定一致）：
   - 每轮点击前防御性校验输入框仍含地址（成功领取后页面可能清空表单），为空则重新 `fill` 回填
   - 先注册 `waitForResponse`（POST + `faucet.shelbynet.shelby.xyz/fund`），再 `ctx.human.click('button:has-text("Fund")')`，避免响应早于等待注册
   - 响应体判定：`txn_hashes` 非空 → 成功计数 +1，logger 记录，拟人停顿 3-8s 继续下一轮
   - `error_code === 'Rejected'` 且 rejection_reasons 含 `UsageLimitExhausted` → logger「已达当日上限」→ break（**视为成功**：重跑幂等，今天领过部分/全部时稳定收敛）
   - 其他拒绝/网络错误/超时 → throw（带响应体摘要），走失败重试
6. 收尾：截图 `shelby-faucet-success`

### 2. `src/tasks/index.ts`

- ALL 数组登记 `new ShelbyAptFaucetTask()` 与 `new ShelbyUsdFaucetTask()`

### 3. `tests/shelby-faucet.test.ts`（新单测）

仿 `tests/task-base.test.ts` 注入假 driver/page：

- mock `waitForResponse` 依次返回成功响应 → 断言循环领满 5 次、claimed = 5
- 中途返回 429 `UsageLimitExhausted` → 断言提前退出、claimed 为已成功次数、不抛错
- 返回其他拒绝（如未知 reason）→ 断言抛错（进失败重试）
- 成功+上限混合序列、全上限（0 次成功）同样收敛为成功

## 错误处理与幂等

- 服务端按请求计数天然幂等：中途失败重试后，已领次数由服务端记，重跑补领剩余直至上限 → 稳定收敛
- 连续 2 任务失败触发窗口当日熔断（框架自带，无需处理）
- 未观测到验证码；若日后出现 Cloudflare 挑战，在点 Fund 前补 `solveCaptcha()`（meta.captcha auto 已配）

## 验证计划（真机）

- 单测 + `npm run typecheck` + `npm test` 通过
- `npm run task:run`（窗口 4，BITBROWSER_PROFILE_ID + TASK_KEY）对两个任务各跑一次实测：期望 success 且日志显示 5 次领取（会消耗该窗口当日额度 10/10，之后重跑应走「已达上限=成功」路径）
- 面板看板核对运行记录与截图
- 上线：`npm run dev` 重启 → 面板任务页出现两个卡片；建议「定时任务」建每日计划（APT 任务在前、ShelbyUSD 在后，每天各触发一次）

## 风险与已知项

- 限额按窗口 IP 计；两任务合计恰好用满 10 次/天，若某窗口手动领取过部分，任务补领至上限即停
- 成功文案/接口形态以 2026-09-07 实测为准（sourceUrl 已记录，站点改版时回查）
- 未观测到的拒绝形态（如每分钟限流的其他 reason）统一走失败重试，不单独分支
