# Arc 领水任务设计 rev2（faucet-arc）：reCAPTCHA 九宫格模拟点击路线

日期：2026-09-09
状态：已确认（真机验证驱动修订；用户确认后直接实施）

## rev2 变更动机

rev1 按「reCAPTCHA v3 无形 + v2 回退 token 注入」设计。真机验证（窗口 100，2026-09-09）推翻两个假设：

1. **挑战实际是 reCAPTCHA Enterprise 复选框**（`recaptcha/enterprise/anchor`），而项目 yescaptcha 检测器只认 `recaptcha/api2/anchor` → 检测从未命中、打码从未执行（captcha_logs 空表实锤）
2. **token 注入路线不可行**：挑战出现后站点禁用提交按钮，等 widget 完成（回调）才恢复；注入 token 无法触发回调。强制提交实测被站点以「Limit exceeded」响应（且 yescaptcha 官方 FAQ 明确：协议接口 token 非 100% 通过，站点按分数拒收；**图像识别方案「图片点完 100% 通过」**）

用户真机观察确认：点「进行人机身份验证」复选框后出现九宫格选图（如「请选择包含停车计时器的所有图片」），手动选图后领取成功。**rev2 采用官方推荐的 ReCaptchaV2Classification 模拟点击路线。**

## 真机核实事实（2026-09-09，窗口 100 + SSR 抓取 + yescaptcha 官方文档）

- 站点同时挂两个 enterprise widget：v3 评分（sitekey `6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2`）+ v2 复选框回退（sitekey `6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve`）；v3 评分 < 0.7 时后端拒绝，前端渲染 v2 复选框并**禁用提交按钮**
- 挑战 DOM（实测抓取）：主文档 `iframe[src*="recaptcha/enterprise/anchor"]`（锚点/复选框）与 `iframe[src*="recaptcha/enterprise/bframe"]`（九宫格内容）；`textarea[name="g-recaptcha-response"]` 在主文档（v2 完成时 Google 写入）
- 点复选框 → 九宫格出现（提示文字在 bframe 内，如「停车计时器」）；正确选图 → 点验证 → 复选框变绿（anchor iframe 内 `#recaptcha-anchor` 的 `aria-checked="true"`）→ 站点提交按钮恢复可用 → 再点 Send → 成功文案
- yescaptcha 分类接口（6 点/次）：`ReCaptchaV2Classification`，入参 `image`（Base64，3x3 缩放 300x300 / 4x4 缩放 450x450 / 单格小图 100x100）+ `question`（/m/ 问题 ID）+ 可选 `confidence`（0.5 时 3x3 返回全部命中而非固定 top3，可免小图二次识别）；返回 `solution.objects`（multi，需要点击的格子序号 0-8/0-15）或 `solution.hasObject`（single 小图判断）
- 官方 DEMO（Python Selenium，YesCaptcha 文档页 29786113）流程：点 anchor → 切 bframe → 读 `.rc-imageselect-desc-wrapper strong` 提示文字 → 下载网格 img → resize → 分类 → 按序号点 `#rc-imageselect-target table td` → 每格点击后检查 td class 含 `selected`（未刷新）否则截图小图 100x100 二次识别 → 点 `#recaptcha-verify-button` → 查 anchor `aria-checked` → 未通过则下一轮循环
- 站点限频文案（i18n）：`requestLimited` = headline "Limit exceeded" + "Sorry, you've hit the limit..."（每资产×网络 1-2 小时；真机撞见时用户确认无需判定——用户隔天执行一次，见 rev1 约定）
- 探针 4 的「Limit exceeded」实为限频响应（请求计数含失败请求，探针反复点 Send 耗尽窗口 100 当日额度）；用户手动领取成功记录说明手动流程无障碍

## 改动清单

### 1. `src/integrations/yescaptcha.ts`：新增九宫格分类任务支持

- `CaptchaKind` 增加 `'recaptcha_v2_grid'`；`ESTIMATED_COST_POINTS` 增加 `recaptcha_v2_grid: 6`
- `YesCaptchaClient` 新增方法 `classifyGrid(image: string, questionId: string, confidence?: number): Promise<{ type: 'multi'; objects: number[] } | { type: 'single'; hasObject: boolean }>`：createTask（type `ReCaptchaV2Classification`，body 含 image/question/confidence）→ 轮询 getResult → 解析 solution（objects 数组 = multi；hasObject = single）；同样挂串行链；超时抛 CaptchaFailure
- `CaptchaService` 新增 `solveGrid(image, questionId, opts)`：余额校验（maxCostPerTask）→ classifyGrid → onLog 记账；失败抛 CaptchaFailure（归 captcha_failed 终态语义不变）
- detectCaptcha 不动（九宫格由任务显式触发，不靠通用检测）
- config `taskTypes` 增加 `"recaptcha_v2_grid": "ReCaptchaV2Classification"`（config.json 同步）

### 2. `src/automation/recaptcha-grid.ts`（新模块）：九宫格模拟点击求解

模块级函数 + 导出常量（供单测），输入 page/captcha/logger/human：

- 常量：锚点 frame 匹配 `recaptcha/enterprise/anchor` 或 `recaptcha/api2/anchor`；挑战 frame 匹配 `recaptcha/enterprise/bframe` 或 `recaptcha/api2/bframe`（title 含 "recaptcha challenge" 兜底）；anchor 元素 `#recaptcha-anchor`；提示文字 `.rc-imageselect-desc-wrapper strong`；格子 `#rc-imageselect-target table td`；验证按钮 `#recaptcha-verify-button`
- `mapQuestionId(text)`：中英双语映射表（合并官方中文表 + DEMO 英文表：出租车/巴士/校车/摩托车/拖拉机/烟囱/人行横道/红绿灯/自行车/停车计价表·停车计时器/汽车·车辆/桥/船/棕榈树/山/消防栓/楼梯），未覆盖返回 null
- `solveRecaptchaGrid({ page, captcha, logger, human }): Promise<'solved' | 'none' | 'failed'>`：
  1. 找锚点 frame（无则 'none'）→ 点 `#recaptcha-anchor`
  2. 等挑战 frame 出现（预算 15s，出现即挑战；未出现且 anchor aria-checked=true 说明一键通过 → 返回 'solved'）
  3. 循环（最多 MAX_ROUNDS=5）：
     - 读提示文字 → mapQuestionId（null 抛错「未覆盖的提示语」）
     - 网格图：bframe 内截图网格容器 → jimp 判断/缩放至 300x300 或 450x450 → Base64
     - `captcha.solveGrid(image, questionId, { confidence: 0.5 })` → objects
     - 逐格点击（3x3 序号 0-8 / 4x4 0-15，按 td 索引）；每格点击后检查 td class 含 `selected`（未刷新跳过），否则等新小图 → 截图 100x100 → solveGrid 单格（不带 confidence）→ hasObject=true 再点该格（递归最多 2 次）
     - 点 `#recaptcha-verify-button`
     - 查锚点 frame `#recaptcha-anchor` aria-checked：true → 返回 'solved'；false 且挑战 frame 仍在新网格 → 继续下一轮
  4. 轮数耗尽 → 'failed'（抛错由调用方处理）
- 图片处理依赖新增 `jimp`（纯 JS 无原生依赖，Windows 友好）

### 3. `src/engine/task-context.ts`：包装方法

- 新增 `solveRecaptchaGrid(opts?: { maxRounds?: number })`：委托 recaptcha-grid 模块，注入 page/captcha/logger（turnstileLogger 同款窗口名包装）；无 captcha 服务返回 'none'（与 solveCaptcha 语义一致）
- 文档同步 API-GUIDE 第 3 章 TaskContext 方法表

### 4. `src/tasks/arc-faucet.ts`：接入新流程

- 新常量：`V3_SITEKEY = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'`（检测挑战时排除常驻 v3 anchor）
- 新增导出 `detectV2Challenge(ctx): Promise<boolean>`：主文档存在 `iframe[src*="recaptcha/enterprise/anchor"]` 且 k ≠ V3_SITEKEY，或存在 bframe iframe
- `runArcFaucet` 流程改为：
  1. 前置不变（closeOtherTabs/goto/fill/ensureNetwork/ensureUsdc/ensureSubmitEnabled）
  2. 点 Send → 竞速：成功文案 / v2 文案 / detectV2Challenge 任一（等待中检测挑战）
  3. 挑战 → `ctx.solveRecaptchaGrid()` → `ensureSubmitEnabled`（widget 完成后按钮恢复）→ 再点 Send → 竞速成功文案
  4. 仍失败抛错（重试重启窗口重跑）
- 删除 rev1 的「solveCaptcha + 强制提交」路径
- meta.note 更新真机事实；captcha.auto 语义不变

### 5. 测试

- `tests/yescaptcha`（现有文件扩展）：classifyGrid 结果解析（multi/single/错误/超时）、solveGrid 记账与余额校验
- `tests/recaptcha-grid.test.ts`（新）：mapQuestionId 中英映射与未覆盖 null；单测注入假 page/captcha 验证流程分支（无 anchor → none、aria-checked 一键通过、多轮循环、提示语未覆盖抛错）
- `tests/arc-faucet.test.ts` 更新：detectV2Challenge 单测（假 page iframe src）；集成 fixture 增加挑战模式（本地假 anchor iframe + v2 文案，fake captcha.solveGrid 记录调用）→ run 走挑战分支全链路
- jimp 参与测试环境（node 侧纯 JS，无需浏览器）

### 6. 文档同步

- API-GUIDE：第 3 章 TaskContext 新增 `solveRecaptchaGrid`；9.1 配置表 taskTypes 增加 recaptcha_v2_grid 键说明
- TASK-DEVELOPMENT-LESSONS.md：追加真机经验（enterprise anchor 检测坑、按钮禁用等回调机制、九宫格模拟点击路线、提示语映射覆盖风险、限频计数含失败请求）

### 7. 真机验证（窗口 100 冷却后或用户指定窗口，一次 task:run）

- 验证：点 Send → 挑战 → 自动点复选框 → 九宫格自动选图 → 变绿 → 按钮恢复 → 再点 Send → 成功文案
- 若窗口 100 冷却未到（1-2h），改用未请求过的窗口

## 风险与已知边界

- 问题 ID 映射表仅覆盖常见 16+ 类提示语；未覆盖提示语 → 任务失败（后续按失败日志扩充映射）
- 多轮网格时成本累积（6 点/轮 + 小图 2 点/张）；maxCostPerTask 1500 点上限内足够
- recaptcha 挑战 iframe 若为嵌套结构（未来改版）需再核实
