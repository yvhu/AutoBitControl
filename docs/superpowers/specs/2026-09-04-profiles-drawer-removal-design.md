# 窗口页移除详情抽屉设计（2026-09-04）

## 背景与动机

窗口页（profiles）的详情抽屉在「运行批次」计划后只剩三样内容：一行「今日运行请查看运行批次页」导航提示、一行钱包密码配置说明、一个「重置熔断」按钮——无任何窗口专属信息。抽屉对用户的价值只剩重置熔断入口，不值得占一层交互。

核心决策：

- **删除详情抽屉**；重置熔断移到表格操作列，**仅熔断计数 > 0 时显示**（计数为 0 时重置无意义，列表保持干净）。
- 两行提示文本一并删除，不加替代（均为全局信息，与具体窗口无关）。
- 后端 `POST /api/profiles/:id/breaker/reset` 接口保留（操作列继续调用）；`useResetBreaker` hook 保留，仅调用点从抽屉移到表格行。

## 改动范围

### 1. 前端 `web/src/pages/profiles/index.tsx`

- 删除：`Drawer` 组件块（243-267 行）、`detailId` state、`detail` 计算（208 行）、`Drawer`/`ReloadOutlined` 导入（仅抽屉在用）
- 操作列（183-204 行）「详情」按钮替换为「重置熔断」链接按钮：
  - 渲染条件 `p.circuitBreakerCount > 0`
  - `loading={reset.isPending && reset.variables === p.id}`（与现抽屉内同款判定）
  - 无图标（与「打开/关闭」按钮风格一致）
  - `onClick={() => reset.mutate(p.id)}`
- 操作列宽度 300 → 240

### 2. 后端注释 `src/server/routes/profiles.ts:216`

- 「手动重置熔断：面板详情抽屉入口（连续失败恢复后放行）」→「手动重置熔断：面板窗口操作列入口（连续失败恢复后放行）」

### 3. 文档 `docs/API-GUIDE.md`（1108 行附近）

- 窗口页描述：删除「详情」打开 Drawer 的句子；操作列描述改为「打开/关闭、复制ID、重置熔断（仅熔断计数 > 0 时显示）」

## 明确不做

- 不删后端 breaker/reset 接口、不改 useResetBreaker hook 逻辑
- 不给两行提示文本找新位置（直接删除）
- 不动历史 plans/specs 文档
- 不新增页面组件级单测（本项目无此先例；hooks 层无逻辑变化，现有测试不受影响）

## 验证

- `npm run typecheck`、`npm run test:web` 全部通过
- 手动验证（需真实环境）：窗口页无详情入口；熔断计数 > 0 的行出现「重置熔断」，点击后计数归零且按钮消失
