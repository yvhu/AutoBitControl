# 登录阶段钱包弹窗自动确认调整（2026-10-30）

## 背景

konnex-checkin 登录时，MetaMask 弹出登录签名请求（URL 尾部 `/signature-request`），弹窗一直不被确认，日志：

```
WARN 检测到交易确认弹窗，登录流程不自动处理（交由任务显式确认）
{"step":"connect","kind":"tx","url":"chrome-extension://.../notification.html#/confirm-transaction/.../signature-request"}
```

## 根因

1. MetaMask 签名页与交易确认页共用 `confirm-btn` / `confirm-footer-button`；`classifyPopup` 原本 tx 先于 sign，登录签名被误判成 `tx`。
2. `autoConfirmTransaction` 默认 `false`（安全边界），登录编排遇到 `tx` 只告警跳过；konnex-checkin 未显式开启，弹窗无人确认。

## 决策

- **分类正确答案按 URL**：MetaMask 签名路由固定包含 `/signature-request`，在 tx 判定前先判 `sign`；保留「tx 先于可见 sign 标记」的保守逻辑，兼容 count-only mock。
- **默认允许自动确认**：`autoConfirmTransaction` 缺省改为 `true`，登录阶段签名/授权/交易弹窗自动点掉；登录阶段会弹真实链上交易（花 gas）的特殊站点在任务里显式传 `false`。
- 签名页不受该开关限制：即使 `false`，`sign` 仍由 `handleLoginPopup` 自动处理。
- 登录完成后的交易确认行为不变，仍由任务显式 `confirmTransaction`。

## 改动

- `src/automation/wallet/metamask.ts`：`classifyPopup` 增加 URL `/signature-request` → `sign`。
- `src/automation/wallet/login-flow.ts`：默认值改为 `true`，同步注释。
- `src/api/wallet.ts`：`ConnectOptions.autoConfirmTransaction` 注释更新。
- `tests/config-adapter.test.ts`：新增签名 URL 分类、普通 URL 保持 tx 的用例。
- `tests/wallet-login-flow.test.ts`：默认自动确认、显式 `false` 不处理、`false` 不影响 sign 的用例。
- `docs/API-GUIDE.md`：§3 参数表/注意、§4.4 安全边界、§6 排错表、§6.7 第 19 条。

## 风险

- 默认 `true` 会放大登录阶段的弹窗处理范围；特殊站点必须显式 `false`。
- URL 判定依赖 MetaMask 路由；若版本变更，需要补新路由或改为「可见签名标记优先」。
