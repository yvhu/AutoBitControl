# 删除 IP 探活设计（2026-09-03）

## 背景与动机

窗口会话流程原本为：开窗 → CDP 接管 → **IP 探活**（访问 `execution.probeUrl` 校验代理 IP 生效）→ 逐个跑任务 → 关窗。探活失败时整轮任务全部标 `skipped`（原因「IP 探活失败」）。

探活的核心价值是「绝不用错误 IP 碰目标站点」（防风控）。但实际决策为：逻辑更少优先，代理是否有问题由任务自身的访问失败暴露——网络不通时任务自然会失败，窗口熔断（连续 2 任务失败）仍兜底。接受代理失效时窗口可能用真实 IP 访问站点的风控风险。

## 改动范围

### 1. 核心逻辑 `src/engine/window-runner.ts`

- 删除 `probeWithRetry` 方法（3 次尝试、每次 30s 超时、间隔 5s）
- 删除 `runWindowTasks` 中探活调用与「IP 探活失败」整轮 skipped 分支
- 更新文件头与 `runWindowTasks` 注释：流程变为「开窗→连接→逐个跑任务→关窗」

### 2. 配置链路（连配置一起删，不留死配置）

- `config/config.json`：删 `execution.probeUrl`
- `src/infrastructure/config.ts`：删 `ExecutionConfig.probeUrl` 字段、默认值与注释
- `src/server/routes/settings.ts`：`PublicSettings` 删 `probeUrl` 字段、swagger 注解、返回值
- `web/src/api/schema.d.ts`：删 `probeUrl`
- `web/src/pages/settings/index.tsx`：删「探活 URL」Descriptions 项

### 3. 冒烟脚本 `scripts/smoke-open-window.ts`

- goto 目标改为固定轻量地址 `https://example.com`（目的仅为验证 CDP 连接可用，失败不中断）
- 更新文件头注释（不再提「探活页」）

### 4. 注释同步

- `src/engine/queue.ts`：窗口会话注释去掉「IP 探活」
- `src/tasks/portal-rhuna.ts`：note 中「个别窗口代理不稳 IP 探活会失败」描述更新

### 5. 测试

- `tests/windowRunner.test.ts`：删 3 个探活用例（「IP 探活失败熔断所有任务」「IP 探活前两次失败第三次成功仍算通过」「IP 探活三次全失败返回 false」）；fixtures 删 `probeUrl` 字段
- `tests/config.test.ts`：删 probeUrl 断言
- `tests/web.test.ts`：settings mock 删 probeUrl

### 6. 文档

- `AGENTS.md`：踩坑提醒「开窗后先 IP 探活」更新
- `docs/API-GUIDE.md`：去掉 IP 探活相关条目——流程表（Probe 行）、execution 参数表（probeUrl）、状态流转（skipped 原因「IP 探活失败」）、排错表、状态速查

## 保留的兜底机制

- 窗口熔断不变：连续 2 任务失败即跳过该窗口剩余任务，代理失效场景由它兜底
- 状态机不变：`skipped` 仍用于开窗失败 / 窗口熔断 / 窗口超时，仅少一个原因
- 冒烟脚本仍保留「打开页面」验证（换固定地址），部署后验证 CDP 链路的能力不丢

## 验证

- `npm run typecheck`、`npm test` 全部通过
- 手动冒烟（可选）：`BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window`
