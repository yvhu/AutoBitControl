# Arc 领水人机验证架构重设计 rev3：打码平台抽象 + 九宫格求解器对齐官方 DEMO

日期：2026-09-10
状态：设计已确认（用户确认后进入实施计划）

## 背景与动机

rev2 的九宫格模拟点击路线真机批量 15 窗口 **0 通过**，成功全部来自重试换新窗口碰 v3 直过。真机日志证据链：

- 窗口 92：连续 5 轮分类稳定返回 `[1,2]`，但每轮都报「点击可能未注册（src 未变且无 selected）」——点选从未落到格子上
- 窗口 93/100：同一提示语连续轮分类返回 1~5 个不同格子、频繁空数组——分类结果不稳定
- 窗口 100 前两次：「九宫格提示文字未找到」——提示语读取失败

对照 yescaptcha 官方 reCaptchaV2 模拟点击教程（wiki 页 29786113）与参考实现 Python3WebSpider/RecaptchaResolver，现有实现偏离官方做法的三处恰好对应三个根因：

| 环节 | 官方 DEMO | rev2 实现 | 真机后果 |
|---|---|---|---|
| 网格图来源 | `div.rc-image-tile-wrapper > img` 原生整图（naturalWidth 300/450）下载后 resize | 容器元素截图 + 中心裁剪 + resize | CSS 缩放/内边距污染，分类乱跳、空数组 |
| 点击方式 | selenium 原生元素点击（trusted、自动居中） | human.clickAt 坐标点击（frame 偏移计算） | 窗口 92 点击从未注册 |
| 失败重试 | 无限递归重做整题 | 5 轮封顶 | 同窗口死磕风控（用户真机经验：死磕即使选对也过不去） |

用户三点诉求：

1. 不要逮着一个窗口照死验证（同会话风控保护）
2. 重新设计现有架构：yescaptcha 只是打码平台之一，未来会接入更多平台
3. 人机验证模块独立出来封装（automation 层自研模块不绑定具体平台）

改造原则：**除真机验证过的自定义资产外，不依赖旧代码与旧配置，完全重写**。保留的资产：QUESTION_ID_MAP 中英映射表、humanize 拟人操作、grid-debug 诊断截图、结构化日志、frame 失效防护、siteKeyExclude 排除机制。旧的 `integrations/yescaptcha.ts`、`automation/recaptcha-grid.ts` 整体删除，无兼容层。

## 目标架构

依赖方向（不可反向）：

```
tasks → engine/TaskContext → automation/captcha（自研人机验证模块）
                              → integrations/captcha（打码平台适配器）→ infrastructure/http
```

### 1. `integrations/captcha/` 打码平台适配层（新增，旧 yescaptcha.ts 删除）

```
integrations/captcha/
  provider.ts              # CaptchaProvider 接口 + 共享类型（CaptchaKind/GridResult/CaptchaFailure/成本估算表）
  index.ts                 # createCaptchaProvider(cfg) 工厂：按 cfg.captcha.provider 装配
  yescaptcha/
    provider.ts            # 实现 CaptchaProvider：串行排队链（平台每账号 1 并发硬限制）、余额校验、超时轮询编排
    client.ts              # 原始 API 封装：/createTask、/getTaskResult、/getBalance（30s 超时、errorId 判错）
    task-types.ts          # kind → 平台任务类型名映射（RecaptchaV2Classification、NoCaptchaTaskProxyless…）
```

- `CaptchaProvider` 接口（平台无关契约）：
  - `readonly platform: string`（如 'yescaptcha'）
  - `solveToken(kind, sitekey, pageUrl, extra?): Promise<string>`（token 类解题）
  - `classifyGrid(imageB64, questionId, confidence?): Promise<GridResult>`（九宫格分类）
  - `getBalance(): Promise<number>`
- `CaptchaFailure` 异常迁至 provider.ts（打码业务失败语义；window-runner 继续靠它判 `captcha_failed` 终态）
- `GridResult`、`CaptchaKind`、`ESTIMATED_COST_POINTS` 迁至 provider.ts
- 平台间 API 差异由各平台子目录自行消化（client 实现、任务类型名、认证方式均平台私有），对外统一实现 provider.ts
- 未来接入 capsolver/2captcha 等 = 新增一个平台子目录 + config 切换 provider 名，automation 与 tasks 层零改动

### 2. `automation/captcha/` 自研人机验证模块（独立封装，只依赖 provider.ts 接口）

```
automation/captcha/
  detect.ts          # detectCaptcha：从旧 yescaptcha.ts 迁来，补 enterprise 检测分支
  token-solve.ts     # 旧 CaptchaService.autoSolve 迁移：检测 → solveToken → applyToken → 记账
  grid.ts            # 九宫格求解器重写（见下节），旧 automation/recaptcha-grid.ts 删除
  turnstile.ts       # 从 automation/ 根迁入（内容不变，interaction-only 一点即过）
  question-map.ts    # QUESTION_ID_MAP 中英映射独立成模块（保留，真机扩充过）
```

- `detect.ts` 检测分支补齐 enterprise：
  - `recaptcha/api2/anchor` 之外增加 `recaptcha/enterprise/anchor` 识别为 recaptcha_v2
  - v3 检测补 `enterprise.js`（enterprise v3 的脚本入口）
- `token-solve.ts` 保持 autoSolve 语义：检测 → 余额校验 → solveToken → applyToken（主世界写入 + input 事件）→ onLog 记账
- `grid.ts` 依赖注入 `CaptchaProvider`（不再是 CaptchaService），onLog 记账带 platform 字段

### 3. engine 层接线（TaskContext API 不变或微调）

- `app.ts`：`createCaptchaProvider(cfg)` 工厂创建 provider → 注入 window-runner → TaskContext
- `ctx.solveCaptcha()`：API 不变，内部走 automation/captcha/token-solve
- `ctx.solveRecaptchaGrid(opts)`：增加 `maxRounds` 参数；**读取 `meta.captcha.auto`**（与 solveCaptcha 口径统一，修复 rev2 死字段）；未注入 provider 返回 'none'
- 错误分类语义定死：
  - 平台服务异常/余额不足（CaptchaFailure）→ `captcha_failed` 终态，不重试
  - 九宫格多轮未过（普通 Error）→ `retry_wait`（换新窗口新会话，v3 直过是真实收益路径）

### 4. 九宫格求解器重写（grid.ts，目标 ~300 行，旧 637 行删除）

流程骨架（对齐官方 DEMO `verify_entire_captcha` + `verify_single_captcha`）：

```
solveRecaptchaGrid(deps: { page; provider; logger; human }, opts: { maxRounds?; siteKeyExclude?; onLog? })
 1. findAnchorFrame(siteKeyExclude) → 无 → 'none'
 2. 点 anchor（#recaptcha-anchor）→ 等 bframe 出现（期间 aria-checked=true = 一键通过 → 'solved'）
 3. 循环（同窗口上限 maxRounds，默认 3）：
    a. 每轮重新取 challenge frame（防 Google 换图后 frame 失效）
    b. 读提示语（.rc-imageselect-desc-wrapper strong）→ mapQuestionId（未覆盖抛错）
    c. 取整图：div.rc-image-tile-wrapper > img 的 src + naturalWidth（300=3x3/450=4x4）
       → 原图 resize 到 naturalWidth → base64（img 缺失才回退容器截图，warn）
    d. provider.classifyGrid(b64, qid)【不传 confidence】→ objects（空数组：warn 跳本轮）
    e. 逐格：locator.click(td[i])【官方原生元素点击】→ 等 ~3s → 查 class：
       - 含 selected → 下一格
       - 无 → 取该格 img src → 100x100 → classifyGrid single（hasObject）→ true 再点该格（官方递归）
       - 点击未注册（src 未变且无 selected）→ human 坐标点击重试一次 → 仍无效 warn 放弃该格
    f. 等动画收尾（2.5-3.5s 随机）→ 点 #recaptcha-verify-button → 查 aria-checked：true → 'solved'
    g. 未过 → 读错误提示（incorrect/select-more，诊断日志）→ 下一轮
 4. 轮数耗尽 → 'failed'（任务层抛错 → retry 换新窗口）
```

关键修复对应：

| 真机证据 | 根因 | 修复 |
|---|---|---|
| 窗口 93/100 分类乱跳、空数组 | 容器截图 CSS 缩放裁剪污染 | 原生整图 img + naturalWidth 定尺寸 |
| 窗口 92 点击从未注册 | 坐标计算漂移/frame 失效 | 原生 locator.click 为主 + 每轮重取 frame + 未注册才坐标兜底 |
| 同窗口死磕全挂 | 同会话风控 | maxRounds 默认 3，失败交任务 retry 换新窗口 |

同窗口风控（用户要点 1）：不在同一窗口无限死磕——maxRounds 轮未过即 'failed' → 任务抛错 → window-runner retry（120s 退避）→ 新窗口新会话。maxRounds 可配置，arc 用 3。

删除的过度设计（官方 DEMO 均无、真机无收益证据）：confidence 0.3 补选机制、RELOAD 换图重试、补点未选中格循环、全体 dynamic-selected 预检、VERIFY_VISIBLE 补点。

保留资产：QUESTION_ID_MAP（question-map.ts）、siteKeyExclude、grid-debug 诊断截图、grid-round-state/grid-click-diag 结构化日志、frame 失效防护、拟人随机等待。

### 5. arc 任务流程重设计（tasks/arc-faucet.ts 验证码部分重写）

```
1. 填表部分不变（真机验证过：地址/网络/币种/防 hydration 重填/按钮等待）
2. 点 Send → 竞速：成功文案 / v2 挑战检测（谁先出现）
3. 挑战 → ctx.solveRecaptchaGrid({ siteKeyExclude: V3_SITEKEY, maxRounds: 3 })
   - 'solved' → 等提交按钮恢复（widget 完成回调）→ 再点 Send → 竞速成功文案
   - 'none'/'failed' → 抛错 → window-runner retry（换新窗口）
4. 成功截图
```

- `detectV2Challenge` 删除任务层 ctx.js 序列化内联 sitekey 的做法 → 改调 automation/captcha 导出的 `findAnchorFrame(page, siteKeyExclude)`（V3_SITEKEY 单点维护在任务常量）
- `meta.captcha.auto` 口径统一后 arc 的 `captcha: { auto: true }` 恢复真实语义
- `meta.note` 精简重写（保留面板可见关键事实）

### 6. 配置重写

`config.ts` 的 `CaptchaConfig` 与 `config.json` 的 captcha 段重写：

```json
"captcha": {
  "provider": "yescaptcha",
  "solveTimeoutMs": 120000,
  "pollIntervalMs": 3000,
  "maxCostPerTask": 1500,
  "yescaptcha": { "apiBase": "https://api.yescaptcha.com", "clientKey": "" }
}
```

- 删 `taskTypes` 段（移进代码 yescaptcha/task-types.ts，平台内部拼写不进用户配置）
- `CAPTCHA_CLIENT_KEY` 环境变量覆盖改写到 `captcha.yescaptcha.clientKey`
- config.local.json 同构覆盖；未来平台加 `"provider": "capsolver", "capsolver": {...}`

### 7. DB 变更

- `captcha_logs` 加 `platform` 列（migrate 补列，缺省 'yescaptcha' 兼容老数据）
- `addCaptchaLog` 接口增加 platform 参数

## 测试计划（旧 captcha 测试整体重写）

- provider 接口契约 + yescaptcha client（创建任务/轮询/超时/errorId 判错/串行链）
- 新 grid.ts（fake provider + fake page/frame）：一键通过、多轮循环、点击未注册兜底、maxRounds 耗尽、提示语未覆盖抛错、空数组跳轮、single 确认递归
- arc-faucet 挑战分支走新路径；config 解析（provider 切换、clientKey 环境变量覆盖）

## 文档同步

- API-GUIDE：第 3 章 solveRecaptchaGrid（maxRounds、auto 口径）；第 5 章验证码整章重写（平台抽象、enterprise 检测、错误分类语义）；9.1 配置表 captcha 段重写
- TASK-DEVELOPMENT-LESSONS：追加同窗口风控经验、点击未注册根因（坐标漂移）、原生大图路线
- 本 spec 文档

## 真机验证（遵守窗口规范）

- 实施完成后单窗口 `task:run` 验证一次；复用同一会话观察多轮（不反复开关窗口）
- 观察点：挑战出现 → grid-debug 截图确认原生大图分类质量 → grid-click-diag 确认点击命中 → aria-checked 变绿 → 按钮恢复 → 再点 Send → 成功文案
- 若挑战未出现（v3 直过），等冷却后再验或换未请求窗口；连续 2 次失败 → 人工介入（带日志+截图）

## 实施顺序

1. integrations/captcha 平台抽象层（provider.ts + yescaptcha/ + 工厂），删旧 yescaptcha.ts
2. automation/captcha 模块（detect/token-solve/grid/turnstile/question-map），删旧 recaptcha-grid.ts
3. engine 接线（TaskContext/window-runner/app.ts）+ config/DB 改造
4. arc 任务重写
5. 测试重写，`npm run typecheck` + `npm test` 全绿
6. 文档同步
7. 真机验证一次

## 风险与边界

- 原生整图 img 路线在 Google 改版（img 结构变化）时失效 → 回退容器截图 + warn（诊断可见，不静默）
- 平台 4x4 识别能力本身有限：分类准确率受平台限制，3 轮未过即换窗口，不烧点数死磕
- blob: 型 img src 需 frame 内 fetch，实施时处理
- 每轮分类记账（6 点/次 + 单格 2 点/次）在 maxCostPerTask（1500 点）内：3 轮 + 补确认足够

## rev3.1 修订（2026-09-10 真机批量驱动，用户确认）

批量 90 窗口真机验证（76+/90 成功）后，用户确认以下设计变更：

### 变更 1：截图文件日期清理

- `storage` 新增 `screenshotRetainDays: 90`（默认；与 dbRetainDays 同档）
- 启动时与 DB 历史清理同批执行：删除 `data/screenshots/<日期>/` 早于截止日的目录
- grid-debug 诊断目录 40 文件上限逻辑不动

### 变更 2：九宫格求解无限递归到成功（对齐官方 DEMO）

- **删除 maxRounds 概念**：`MAX_ROUNDS_DEFAULT`、`ctx.solveRecaptchaGrid()` 的 maxRounds 参数、arc 任务 `maxRounds: 3` 全部移除
- 主循环无轮次上限，唯一正常出口 = aria-checked=true → solved
- 失败分流（按 Google 错误提示）：
  - 「未选全」(select-more)：先判点击过快——本轮目标格中仍有 class 不含 selected 的 → 补点 → 短等待 → 再点 verify；已点格子全部 selected（平台确实没找全）→ 点刷新换图下一轮
  - 「选错」(incorrect) → 刷新换图下一轮
  - 「请重试」(try-again，新增识别：全文案匹配 请重试/Please try again 等) → 刷新换图下一轮
  - 无提示且未过 → 刷新换图下一轮
- 换图操作：优先 `#recaptcha-reload-button`（官方换图入口，同题换一批图）；reload 无效（图未变）→ 点「跳过」（aria-label/title 中英双匹配）换题；都失败只 warn 不阻塞
- 分类前置条件：空数组或 objects < 3 → 直接刷新换图（少选必失败，不硬点）；平台图片质量拒收 → 刷新换图
- 未覆盖提示语 → 点「跳过」换题（不再抛错退出；reload 不换题，必须 skip）
- 工程护栏（无限递归的终止条件）：余额不足 → CaptchaFailure 终态；任务超时 timeoutSec=420s 兜底；挑战收回且重点锚点 3 次无法恢复挑战 → 抛「九宫格挑战无法恢复」交任务重试换窗口
- 返回值语义：`'none'`（无锚点）、`'solved'`（成功）、`'failed'` 仅剩「挑战无法恢复」路径
