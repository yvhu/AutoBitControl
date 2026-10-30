# Konnex 多段登录修复（2026-10-30）

## 背景

真机日志中 `konnex-checkin` 窗口出现「只处理了 MetaMask `unlock`，没有 `sign`，随后报签到卡片未出现」。站点登录实际是多段确认：

1. 站内 `Sign in`
2. 弹窗 `Connect with Ethereum`
3. 钱包列表选 `MetaMask`
4. MetaMask 连接/解锁
5. MetaMask SIWE 签名请求
6. 页面 session 认证完成后才出现签到按钮

## 根因

旧任务用 `connected: { text: 'Balance' }` 判断登录。`Balance` 在钱包已连接、但站点 session 未认证时也会出现，导致 `connectWallet` 误判已登录直接跳过，后续站内确认和 SIWE 签名都没人点，签到卡片保持锁定。

## 决策与改动

- 登录完成标志改为**签到按钮 `button:has-text("Check in")` 出现**（只有 session 认证后才存在）。
- 先判已签到态（`Great job!` / `RESETS IN`），命中直接成功，不触发登录。
- 未登录（站内 `Sign in` 可见）时走登录：`connect` = 站内 Sign in，`confirm` = `Connect with Ethereum`，`walletOption` = MetaMask；SIWE 签名由 `autoConfirmTransaction` 默认自动确认。
- 文件：`src/tasks/konnex-checkin.ts`、`tests/konnex-login.test.ts`（新增）。
- 文档：`docs/API-GUIDE.md` 6.7 第 20 条。

## 风险

- 若站点把签到卡片也做成「登录前可见但锁定」，`waitCheckinState` 仍会等到超时；此时按现有逻辑交给 `checkin` 报卡片异常，便于排障。
- 站点改版（Sign in / Connect with Ethereum 文案变化）需要同步更新选择器。
