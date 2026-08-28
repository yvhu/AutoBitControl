# AutoBitControl 代码文档化与项目标准化 设计文档

日期：2026-08-28
状态：已与用户确认四大模块方案

## 0. 目标

在已交付可用的 AutoBitControl 基础上做四件事（按实施顺序）：

1. **D 全项目分层重构**：模块划分、统一封装、分层依赖，前后端分离
2. **B 任务元信息扩展**：TaskMeta 增加管理字段并联动调度器/面板/API
3. **C 使用手册与文档型示例**：docs/API-GUIDE.md + 三个逐行注释的示例任务
4. **A 全代码中文注释**：覆盖终态代码的每个类/方法/变量

约束：全程测试全绿（vitest 68+ 用例保持通过并随改动更新），tsc 严格模式无错误，每步独立提交。

## 1. D 全项目分层重构

### 1.1 目标目录结构

```
src/
├── infrastructure/        # 基础设施层：无业务依赖，可独立测试
│   ├── config.ts          # 三层配置加载（原 core/config.ts）
│   ├── logger.ts          # pino 日志（原 core/logger.ts）
│   ├── http.ts            # 新增：统一 HTTP 封装
│   └── db.ts              # SQLite 数据层（原 core/db.ts）
├── integrations/          # 外部集成层：只依赖 infrastructure
│   ├── bitbrowser.ts      # 比特浏览器客户端（原 core/bitbrowser.ts，改用 http.ts）
│   └── yescaptcha.ts      # 打码客户端 + 检测器 + CaptchaService（原 core/captcha.ts，改用 http.ts）
├── automation/            # 浏览器行为层：拟人化与钱包交互，无业务规则
│   ├── humanize.ts        # 原 core/humanize.ts
│   └── wallet/            # 原 core/wallet/（types/popup/metamask/petra）
├── engine/                # 执行引擎层：调度与执行的核心业务，依赖上面三层
│   ├── state.ts           # 状态机（原 core/state.ts）
│   ├── queue.ts           # 并发队列 + 合并入队（原 core/queue.ts）
│   ├── scheduler.ts       # 调度器（原 core/scheduler.ts）
│   └── window-runner.ts   # 窗口执行器 + PatchrightDriver（原 core/windowRunner.ts）
├── tasks/                 # 业务任务层：站点任务，只通过 TaskContext 使用引擎能力
│   ├── base.ts            # SiteTask/TaskContext（原 tasks/base.ts）
│   ├── index.ts           # 任务注册表（原 tasks/index.ts）
│   └── *.ts               # 站点任务
├── server/                # API 层：依赖 engine 与 infrastructure，不依赖具体任务
│   ├── app.ts             # Express 装配（原 web/server.ts 拆解后的组装点）
│   ├── http/
│   │   ├── response.ts    # 统一响应封装 + asyncHandler
│   │   └── error.ts       # HttpError + 错误处理中间件
│   ├── routes/            # RESTful 按资源分模块
│   │   ├── dashboard.ts
│   │   ├── tasks.ts
│   │   ├── profiles.ts
│   │   ├── runs.ts
│   │   ├── captcha.ts
│   │   ├── bitbrowser.ts
│   │   └── screenshots.ts
│   └── public/            # 前端（分层分离）
│       ├── index.html     # 纯结构，零内联
│       ├── css/app.css    # 全部样式
│       └── js/
│           ├── api.js     # 统一 fetch 封装（解包 envelope、错误提示）
│           ├── app.js     # 入口：导航切换、顶栏状态、15s 轮询
│           └── views/
│               ├── dashboard.js
│               ├── profiles.js
│               ├── tasks.js
│               └── settings.js
├── app.ts                 # 组装根：创建全部依赖并注入（原 index.ts 主体）
└── index.ts               # 入口：仅调用 app.ts
scripts/                   # 冒烟脚本不变（更新 import 路径）
tests/                     # 测试平铺不变（更新 import 路径），web.test.ts 全面改写
```

### 1.2 依赖方向规则

`tasks → engine → {integrations, automation} → infrastructure`；`server → {engine, infrastructure}`；`app.ts` 组装一切。禁止下层 import 上层。

### 1.3 统一封装

- **infrastructure/http.ts**：`httpJson<T>(baseUrl, path, { method, body, timeoutMs }): Promise<T>`——统一 JSON、`AbortSignal.timeout` 超时、非 2xx 与解析错误抛统一 `HttpError`（含状态码与消息）。bitbrowser 与 yescaptcha 客户端改用之，删除各自手写 fetch
- **server/http/response.ts**：`ok(res, data)` / `fail(res, status, code, message)` 统一包 `{ code, message, data }`；`asyncHandler(fn)` 包装异步路由错误
- **server/http/error.ts**：`HttpError` 类 + 全局错误中间件（未捕获错误 → 500 + 统一格式，日志记录）
- **public/js/api.js**：`request(path, options)` 统一 baseURL、JSON 序列化、envelope 解包（code!==0 时抛错并提示 message）

### 1.4 RESTful 路由表（资源化命名）

| 方法 | 路径 | 说明 | 原路径 |
|---|---|---|---|
| GET | /api/dashboard?date= | 看板聚合 | /api/dashboard |
| GET | /api/tasks | 任务列表（含新 meta 字段） | 内嵌在 dashboard |
| POST | /api/tasks/:key/trigger | 触发任务（可选 body bitbrowserId） | /api/trigger |
| GET | /api/profiles | 窗口列表 | 内嵌在 dashboard |
| PATCH | /api/profiles/:id | 修改窗口（body: enabled / password） | /api/profile/:id/toggle、/password |
| POST | /api/profiles/:id/run | 该窗口跑全部任务 | /api/profile/:id/run |
| POST | /api/profiles/:id/breaker/reset | 重置熔断 | /api/profile/:id/reset-breaker |
| POST | /api/runs/rerun-failed | 重跑失败（body date） | /api/rerun-failed |
| GET | /api/captcha/balance | 打码余额 | 不变 |
| POST | /api/bitbrowser/test | 连接测试 | 不变 |
| GET | /api/screenshots?path= | 截图（目录穿越防护保留） | /api/screenshot |

### 1.5 前端模块化

- `index.html` 只含 DOM 结构与 `<script type="module">` 入口；样式全部进 `css/app.css`；四个视图各一个 JS 模块，导出渲染函数，由 `app.js` 统一调度；`api.js` 是唯一发请求的地方
- 视觉与交互与现有 4 页面板完全一致（不变）
- 视图模块之间不互相 import，通过 `app.js` 暴露的最小接口协作

## 2. B 任务元信息扩展

```ts
export interface TaskMeta {
  key: string
  name: string
  url: string
  sourceUrl?: string    // 信息来源页：选择器从哪个页面抄的，失效时回溯重查
  note?: string         // 备注：站点坑、特殊逻辑、注意事项
  category?: 'checkin' | 'faucet' | 'mint' | 'other'
  lastUpdated?: string  // 最后更新日期 YYYY-MM-DD
  deprecated?: boolean  // 已失效标记；true 时调度器不注册 cron，面板显示"已失效"徽章
  schedule?: string | { stagger: [string, string] }
  wallet?: string
  timeoutSec?: number
  retry?: { max: number; backoffSec: number }
  captcha?: { auto?: boolean; maxCost?: number }
}
```

联动：

- `engine/scheduler.ts`：`start()` 跳过 `meta.deprecated === true` 的任务（连同空 url 跳过一起）
- `server/routes/dashboard.ts`：tasks 数组返回全部新字段
- 面板任务页：分类徽章（签到/领水/铸币/其他四色）、备注（可折叠/悬浮）、sourceUrl（新窗口打开链接）、lastUpdated、deprecated 灰色标记
- API-GUIDE 手册同步收录字段全解

## 3. C 使用手册与文档型示例

### 3.1 docs/API-GUIDE.md（手册九章）

1. 快速开始：新增一个签到任务的 5 步（建文件 → 写 meta → 写 run → 注册 → 重启/面板验证）
2. TaskMeta 字段全解：每个字段含义、取值、示例
3. TaskContext 方法全解：goto/clickCheckin/assertVisible/typeInto/solveCaptcha/screenshot/loginByWallet/textPresent/urlIncludes——每个方法含参数、返回值、典型用法、**选择器怎么找**（DevTools 定位技巧、等待策略、断言写法）
4. 钱包弹窗：钱包类型是任务级配置；解锁密码按窗口配置流程；新增一个钱包适配器的完整步骤；弹窗识别机制（URL 正则）
5. 验证码：auto 模式配置、手动 `ctx.solveCaptcha()` 时机、费用上限（点数）、各类型支持范围与 sitekey 提取说明
6. 拟人接口：Humanizer 全方法（click/type/moveTo/scroll/sleep）与延迟参数含义、何时不要拟人（可选）
7. 调度配置：cron 语法、错峰窗口、手动触发、deprecated 跳过
8. 常用模式：签到成功/频率限制/维护中的状态判断写法、faker 填表单、多步骤流程、条件分支重试
9. 排错：选择器失效怎么办（sourceUrl 回溯）、钱包弹窗不出现、打码失败/余额、熔断与重跑

### 3.2 示例任务（每个都是逐行中文注释的文档）

- `tasks/example-checkin.ts` 重写：标准签到闭环参考实现，注释写明每一步为什么这么写、选择器怎么找、断言怎么配
- `tasks/faucet-example.ts` 新增：领水流程——goto → 状态判断 → faker 生成邮箱 → 拟人填写 → 验证码处理 → 点击领取 → 断言余额/成功文案
- `tasks/mint-example.ts` 新增：铸币流程——钱包登录（弹窗+密码）→ faker 生成代币名称/符号/描述 → 多步骤表单 → 钱包确认 → 断言链上结果提示

三个示例在 `index.ts` 注册（deprecated 示例不注册或标注），供面板查看与手动触发验证。

## 4. A 全代码中文注释（最后实施，覆盖终态）

- **文件头**：模块职责、所在分层、依赖方向、设计思路（2-5 行）
- **类级 JSDoc**：解决什么问题、关键设计决策与权衡（如 CoalescingEnqueuer 的 running/followUp 机制、yescaptcha 串行队列、CDP 派发鼠标的原因）
- **方法级 JSDoc**：`@param`、`@returns`、用途、设计权衡、抛错条件
- **关键变量行内注释**：含义、取值范围、为什么这个默认值
- **覆盖范围**：`src/` 全部 .ts 与 `scripts/*.ts`；`tests/` 不注释（中文测试名自解释）；前端 JS/CSS 关键段加注释
- 只加注释，不改任何逻辑与行为

## 5. 实施顺序与验证

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | D 分层重构（移动+import 更新+http.ts+envelope+前端拆分） | 原测试改写路径后全绿 + 新路由/封装测试 + tsc |
| 2 | B TaskMeta 扩展 | 新增字段测试 + 面板手测 |
| 3 | C 手册+示例 | 示例任务集成测试（fixture 页模拟）+ 手册链接自检 |
| 4 | A 全代码注释 | tsc + 全量测试不回归 |

每步一个提交（可含多个 commit），最终跑一次全量 `npm test` + `npm run typecheck`。
