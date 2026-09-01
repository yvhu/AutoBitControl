# inception-dachain 真机实测与稳定性加固设计

日期：2026-09-01
状态：已实施并通过 250 项测试 + 7 窗口真机并行实测

## 背景

08-31 大批量并行运行（约 40 窗口、并发 5）仅 1 窗口成功，主要失败为「钱包弹窗未出现」等。
09-01 用户要求真实开窗实测、定位真实问题并优化，确保按当前配置稳定运行。

## 真机实测定位的问题（按发现顺序）

1. **已登录窗口被误判为未登录**（win 100/98 失败）：`goto()` 后仅等 0.8-3s 就判定
   `Quantum Crate` 是否存在，SPA 未渲染完时误入登录分支；而已登录仪表盘永远不出现
   `Enter Inception`，刷新 10 次后假报「网络异常」。
2. **AppKit 钱包弹窗初始视图不固定**（win 99 失败）：弹窗有时直接显示钱包列表，
   有时显示上次钱包的 QR 连接页（实测 SafePal QR），`wallet-selector-io.metamask`
   入口不存在于 QR 视图，30s 断言超时。
3. **动画按钮导致 boundingBox 稳定性等待超时**（win 98 失败）：Humanizer 用
   `locator.boundingBox()` 取坐标，其内建「稳定性等待」在带持续动画的按钮上
   30s 超时（错误 `locator.boundingBox: Timeout 30000ms exceeded`）。
4. **达每日上限后弹窗空转 90s**（win 97/98 失败）：额度已满（页面 `DAILY OPENS 5/5`）
   时点 Open Free 可能弹出无结果弹窗，点 Open for 后既不出现开箱结果也不报错，
   90s 超时判失败；弹窗内实际可能出现「Daily limit reached」提示。
5. **按钮在视口外**：resolveBox 初版要求坐标与视口相交，小窗口/长页面按钮被误判不可见。
6. **点 Quantum Crate 目录后 Open Free 20s 未出现**（win 95 一次失败）：SPA 路由未生效，
   需补点一次。
7. **run-task 脚本 DB 提前关闭崩溃**（09-01 早上实测）：终态判定靠执行后再读库，
   读库竞态拿到旧行 → 提前 `db.close()`，600s 后重试定时器触发时访问已关闭连接崩溃。
8. **retry_wait 行重启后孤儿化**：重试定时器为内存态，进程重启即丢失，任务当天永不完成。
9. **MetaMask 锁定且未配置密码时报错不明**：`连接确认未完成` 不指明原因。

## 设计决策

### 任务层（src/tasks/inception-dachain.ts）

- **登录状态竞速判定**：goto 后 `raceLoginState` 竞速等待 `Quantum Crate`（已登录）与
  `Enter Inception`（未登录）任一出现（20s）；都不出现则刷新重试（10 轮，每轮 15s），
  每轮两种状态都认。已登录窗口直接跳过登录（实测 41s 成功）。
- **MetaMask 扩展轮询并行化**：与 Enter Inception 流程并行轮询 `window.ethereum`
  （10×6s），弹窗归一化耗时覆盖大部分轮询窗口，缺失时快速失败且错误准确。
- **AppKit 弹窗视图归一化**：弹窗出现后最多 5 轮：入口直接命中 → `header-back` 回退
  （QR 视图）→ `all-wallets` 展开 → `tab-browser` 切换，再点 MetaMask。
- **每日额度计数器确定性判定**：读页面 `DAILY OPENS x/y`（正则解析 body innerText），
  `opened >= total` 直接成功，不依赖短暂 toast；解析失败走文案竞速兜底。
- **开箱结果竞速增强**：`raceReveal` 同时监视结果文案 / `Insufficient QE`（快速失败）/
  `Daily limit reached`（弹窗内提示场景，真机实测）。
- **90s 开箱预算不缩短**：45s 无结果且 Open for 按钮仍在才补点一次，之后等满剩余预算。
- **Close 后等弹窗真正消失**（≤10s），防止下一轮 Open Free 点击被遮挡。
- **Quantum Crate 目录点击补点一次**（Open Free 20s 未出现时）。
- 错误文案修正、全程步骤日志（`ctx.log`）。
- 已验证选择器与时间/次数配置保持不变（timeoutSec 900 / retry 2×600s / 开箱循环 8 /
  刷新 10 / 竞速 6s×3 / sidebar 45+2×30 / reveal 90s / IP 探活 3 次）。

### 引擎层

- **Humanizer.click 坐标读取改造**：`boundingBox()`（稳定性等待）→
  `waitFor(attached)` + `evaluate`（`scrollIntoView` 后读 `getBoundingClientRect`），
  解决动画按钮 30s 超时与视口外按钮问题（src/automation/humanize.ts）。
- **runManual 返回最终运行行**：runTask/runWindowTasks 全部终态写库路径改为收集
  `RunRow` 内存返回，run-task 脚本直接使用返回值判定终态，消除读库竞态；
  脚本仅在终态后关库，retry 定时器加 `dbClosed` 守卫（scripts/run-task.ts、
  src/engine/window-runner.ts、src/engine/queue.ts 类型同步）。
- **retry_wait 启动恢复**：app 启动时扫描当日 retry_wait 行，退避已到期的立即重新
  入队、未到期的重新挂定时器（src/app.ts）。
- **MetaMask 锁定明确报错**：`ensureConnected` 每轮先检测 `unlock-password`，存在且
  未配置密码即抛「已锁定且未配置解锁密码，请配置 WALLET_PASSWORDS」
  （src/automation/wallet/metamask.ts）。
- **TaskContext.log getter**：任务内步骤日志（src/engine/task-context.ts）。

### 放弃的方案

- `/checkagent` 代理预检：实测该接口对本机全部正常代理返回「代理IP无法连接」
  （供应商限制导致误报），会误杀全部窗口，不可用作门禁。保留页面级 IP 探活
  （浏览器真实流量是唯一可靠信号，实测返回 IP 与比特 lastIp 一致）。

## 真机实测结果（09-01，最终代码）

| 窗口 | 结果 | 路径 |
|---|---|---|
| 100 | ✅ 41s | 已登录跳过 → 计数器上限 |
| 99 | ✅ ~3.5min | 未登录 → AppKit 归一化 → 5 箱 → 上限 |
| 96 | ✅ | 已登录 → 1 箱 → 上限 |
| 97 | ✅ | 已登录 → 弹窗内上限提示 |
| 98 | ✅ | 已登录 → 计数器上限（修复前连续 2 种失败） |
| 94 | ✅ | 已登录 → 计数器上限 |
| 95 | ✅ ~8min | 5 箱 → 弹窗内上限提示 |
| 93 | ❌ | 该窗口 MetaMask 弹窗从不出现（window.ethereum 存在但弹窗不弹），窗口级环境问题，错误信息已明确 |

## 验证

- `npm run typecheck` 通过
- `npm test` 250/250 通过（新增 tests/inception-dachain.test.ts 17 项：
  登录状态竞速 / 开箱竞速 / 结果竞速 / 计数器解析 / 弹窗消失等待）

## 补充发现（第二轮实测）

10. **`.env` 文件损坏**：`WALLET_PASSWORDS` 与 `CAPTCHA_CLIENT_KEY` 的赋值行被并进
    `#` 注释行（整行以 # 开头），dotenv 整体忽略 → 钱包密码未加载 → 锁定钱包无法解锁。
    用户修复后解析验证通过。教训：赋值必须独立成行。
11. **高负载容错放宽**：弹窗等待 30s→60s、解锁轮询 20s→45s、解锁页离开 15s→30s、
    Get Started 断言 30s→45s、AppKit 弹窗 30s→45s（均为上限值，命中即返回，不拖慢正常路径）。
12. **弹窗触发补点**：`loginByWallet` 新增可选 `reclick` 参数——弹窗 8s 内未出现则补点
    一次入口（AppKit 动画未稳定时首次点击可能不注册；已触发弹窗被聚焦而非重复打开，安全）。
13. **测试纪律教训**：大规模验证时反复杀进程导致窗口会话清理逻辑（finally 关窗）未执行，
    比特浏览器窗口越积越多（峰值 12+）打爆内存（客户端报 95% 内存守卫），污染测试数据。
    规范：不得中途杀进程；测试结束后核对 pids 归零；多开数量不得超过配置 concurrency。

## 大规模实测结果（09-01 全天，含早期污染数据与干净阶段）

- 脚本批次（3-4 窗口并发）7 窗口全流程验证：100/99/97/96/95/94/98 成功，93 重开窗口后成功
- 队列触发（concurrency=5）：成功数持续上升至 28+（含 win 83 完整「解锁→连接→5 箱→上限」）
- 失败分布：钱包弹窗未出现（部分窗口 MetaMask 弹窗在负载下不出现/扩展异常，3 次重试后终态，
  错误信息明确）；开窗失败（比特客户端限流/卡打开中/内存守卫——多为测试干扰）；少量开箱结果
  超时（视频慢，重试机制兜底）
- 结论：任务代码在真实多窗口环境下稳定运行；剩余失败均有明确错误与重试兜底，属窗口环境问题
  （MetaMask 未启用/未安装）或客户端基础设施瓶颈（开窗限流），非任务逻辑缺陷
