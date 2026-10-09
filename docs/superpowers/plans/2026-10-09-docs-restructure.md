# 文档重构（Plan 5）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `docs/API-GUIDE.md` **整份重写**为与新架构一致、条目清晰的权威手册（0–13 章 + 附录 A/B），并入 `TASK-DEVELOPMENT-LESSONS.md`（删除独立文件），删除全部过时内容，并加**文档漂移守卫测试**。

**Architecture:** 手册是面板「文档」页渲染的唯一用户手册；结构来自 markdown 标题（面板 `useDocTree` 自动构建章节树），故重排标题即安全。内容以仓库源码为唯一真值（TaskContext/`LoginSpec`/TaskMeta/config/routes）。

**Tech Stack:** Markdown、React/Vite（面板文档页仅渲染，不改）、vitest（漂移守卫）。

## Global Constraints

- 内容以源码为准：`src/engine/task-context.ts`、`src/automation/wallet/login-flow.ts`、`src/engine/task.ts`、`src/tasks/base.ts`、`src/infrastructure/config.ts`、`src/server/routes/*`。
- 文档语言：中文；示例代码用现行新范式。
- **删除过时内容**：`ctx.human`/Humanizer/拟人、`execution.humanize`、`captcha` 配置/插件路线/`waitCaptchaPassed`、所有已删扁平方法、旧「方法对比速查」中过时项。
- 提交风格：`docs:` + 中文；文档改动与代码同批。
- 验证：`npm run typecheck`、`npm test`（含新漂移守卫）、`npm run test:web`。
- 分支 `feat/task-thin-facade`。

---

### Task 1: 整份重写 `docs/API-GUIDE.md`

**Files:**
- Modify（整份替换）: `docs/API-GUIDE.md`
- Delete: `docs/TASK-DEVELOPMENT-LESSONS.md`（内容并入第 12 章）

**目标结构（标题层级）**

```
# AutoBitControl API 使用手册
## 0. 五分钟上手
## 1. 架构与分层
## 2. TaskMeta 字段全解
## 3. 任务范式（SiteTask）
## 4. TaskContext 能力地图
### 4.1 ctx.page
### 4.2 ctx.wallet（钱包四动作 + ensureLoggedIn + LoginSpec）
### 4.3 ctx.captcha（仅 Turnstile 方框）
### 4.4 ctx.recover 与 ctx.race
### 4.5 数据源与文件上传（account / accountRow / uploadFile）
### 4.6 ctx.js（主世界求值）
### 4.7 诊断与截图（step / steps / screenshot / safeScreenshot）
### 4.8 日志与窗口（log / profile）
## 5. 手动触发与守卫
## 6. 定时任务
## 7. 上传前文件自动随机分配
## 8. 配置（config.json / .env）
## 9. 面板使用
## 10. REST 接口总表
## 11. 实战配方
## 12. 排错与真机经验
## 13. 工具中心
## 附录 A：AI 帮写任务模板（元素清单式）
## 附录 B：示例任务源码
```

**必须覆盖的准确内容（以源码为准）**

- **第 2 章 TaskMeta**（`src/engine/task.ts`）：`key`/`name`/`url`/`sourceUrl`/`note`/`category`/`group`/`lastUpdated`/`deprecated`/`enabled`/`wallet`/`timeoutSec`（默认 180）/`retry`（默认 `{max:2,backoffSec:600}`）/`concurrency`（默认 4）/`requiresFileAssign`。
- **第 3 章任务范式**：`SiteTask` = `meta` + 可选 `login: LoginSpec` + 可选 `action(ctx)`；默认 `run` 骨架（清理标签页 → `goto`(3 次重试) → `ensureLoggedIn` → `action`）；可覆盖 `run`（多页等）。
- **第 4 章能力地图**（`src/engine/task-context.ts`）：
  - `ctx.page`（patchright `Page`，直用）：`locator/getByText/click/fill/type/press/waitFor/waitForResponse/waitForURL/waitForLoadState/evaluate/keyboard/mouse/screenshot` 等（点明「DOM 操作直调 patchright」）。
  - `ctx.wallet`：`ready()` `login(opts?)` `sign(opts?)` `confirmTx(opts?)` `ensureLoggedIn(spec)`；`LoginSpec` 字段：`loggedIn`/`loggedOut`（`Probe = {text}|{selector}`，或字符串=文案）、`connect?`、`walletEntry?`、`entry?`（`{kind:'direct'}` | `{kind:'dialog';confirm?}` | `{kind:'appkit';open;entryTestId;modalTestId?}`）、`intents?`（默认 `['connect']`）、`waitLoggedInMs?`（默认 90000）、`recoverTexts?`、`refreshEveryMs?`（默认 25000）、`attempts?`（默认 2）、`reclickAfterMs?`（默认 8000）；钱包适配器四动作（`unlock?`/`connect`/`sign`/`confirmTx`）；静默连接容忍语义。
  - `ctx.captcha`：`turnstile(opts?)`/`visible(selectors?)`/`autoClick(budgetMs?)`（仅 Turnstile 方框；点方框即过，ISP IP 决定）。
  - `ctx.recover(probe, opts)`：`budgetMs`/`refreshEveryMs?`/`recoverTexts?`（默认 `RECOVER_TEXTS`）/`settleMs?`/`heartbeatMs?`；`ctx.race(entries, ms)`。
  - 数据源：`account(key)`（严格）/`accountRow`（宽松）/`uploadFile(sel, value)`（URL 或本地路径）。
  - `ctx.js(fn)`（主世界）；`ctx.step(name, fn)`/`steps()`/`screenshot(name)`/`safeScreenshot(name)`；`ctx.log`/`ctx.profile`。
  - 明确「旧扁平方法已删除，统一用上述命名空间」。
- **第 5 章触发守卫**：未注册 404 / 停用 409 / 在途 409 / 单窗口触发；入队合并、双闸门（任务级 `concurrency` + 全局 `maxConcurrentWindows`）、错峰。
- **第 6 章定时任务**：四种频率、时区 `scheduler.timezone`、`fileAssign`、纯分配计划。
- **第 7 章文件随机分配**：工具页参数 + 计划固化。
- **第 8 章配置**（`src/infrastructure/config.ts`，**无 captcha/humanize**）：`bitbrowser`/`execution`（`staggerMaxSec`/`maxConcurrentWindows`/`windowTimeoutMs`/`taskTimeoutMs`/`retryMax`/`retryBackoffSec`/`circuitBreakerThreshold`）/`web`/`wallet.passwords`/`storage`/`dataSource`/`scheduler`；环境变量 `WALLET_PASSWORDS`/`WEB_PORT`/`VITE_PORT`/`BITBROWSER_API_BASE`。
- **第 9 章面板使用**：八个页面（去掉打码余额相关）。
- **第 10 章 REST 总表**：以 `src/server/routes/*` 的 `@swagger` 为准，**不含 `/api/captcha/balance`**。
- **第 11 章配方**：签到一条龙、领水（含 Turnstile 方框）、钱包登录（direct/dialog/appkit）、多签上传、已领取/限频收敛、数据源+faker。
- **第 12 章排错与真机经验**：并入原 `TASK-DEVELOPMENT-LESSONS.md` 全部 9 条（真机核实/登录态判定/钱包弹窗坑/文件上传坑/卡死定位/运维/性能/开窗异步/状态判定三连坑），并更新为现状（无拟人、captcha 仅方框、插件路线已移除）。
- **附录 A**：AI 帮写任务模板（元素清单式），硬约束：「DOM 直调 patchright；登录用 `wallet.ensureLoggedIn`；只用封装，禁止手写 reload/等待循环；不够就地扩封装」。
- **附录 B**：示例任务说明（链接面板示例视图）+ 最小任务示例。

**写法要求**：每个方法/字段按「是什么 / 何时用 / 怎么用（代码块）/ 注意什么」；顶部保留「先读我」；删除所有指向已删方法的锚点链接（如 `#closeothertabs`）。整份文档不出现 `ctx.human`/`Humanizer`/`waitCaptchaPassed`/`execution.humanize`/`captcha` 配置等过时词。

- [ ] **Step 1: 通读现状与源码真值**

Run: `Get-Content docs/API-GUIDE.md | Measure-Object -Line`；并阅读 `src/engine/task-context.ts`、`src/automation/wallet/login-flow.ts`、`src/engine/task.ts`、`src/tasks/base.ts`、`src/infrastructure/config.ts`、`src/server/routes/*.ts`。列举旧文档中需删除的章节（Humanizer 章、`waitCaptchaPassed` 节、旧方法节、captcha 配置行）。

- [ ] **Step 2: 整份重写 `docs/API-GUIDE.md`**

按上述结构与准确内容写入完整手册。

- [ ] **Step 3: 删除独立 LESSONS 文件**

```bash
git rm docs/TASK-DEVELOPMENT-LESSONS.md
```

- [ ] **Step 4: 自检**

Run: `Select-String -Path docs/API-GUIDE.md -Pattern 'human|Humanizer|拟人|waitCaptchaPassed|execution\.humanize|/api/captcha|captcha:|plugin-wait|detectPageState|clickCheckin|typeInto|closeModal'`
Expected: 仅命中「已移除/历史」说明性文字（若仍有直接宣传旧 API 的句子，修正）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "docs: 手册整份重写（新范式/能力地图/并入真机经验，去拟人与打码插件）"
```

---

### Task 2: 文档漂移守卫测试

**Files:**
- Create: `tests/docs-drift.test.ts`

**Interfaces:**
- 读 `docs/API-GUIDE.md` 文本，断言 `TaskContext` 的公开门面成员都在手册中出现。

- [ ] **Step 1: 写测试** `tests/docs-drift.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TaskContext } from '../src/engine/task-context'

/** TaskContext 公开门面成员名（getter + 方法 + 命名空间方法） */
function publicMembers(ctx: TaskContext): string[] {
  const proto = TaskContext.prototype as unknown as Record<string, unknown>
  const protoMethods = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof (proto as Record<string, unknown>)[n] === 'function')
  const accessors = Object.getOwnPropertyNames(proto).filter((n) => {
    const d = Object.getOwnPropertyDescriptor(proto, n)
    return d && typeof d.get === 'function'
  })
  // 命名空间方法
  const ws = new Set<string>()
  for (const k of ['wallet', 'captcha']) {
    const ns = (ctx as unknown as Record<string, unknown>)[k] as Record<string, unknown> | undefined
    if (ns) for (const m of Object.keys(ns)) ws.add(`${k}.${m}`)
  }
  return [...new Set([...protoMethods, ...accessors, ...ws])].sort()
}

describe('文档漂移守卫', () => {
  it('TaskContext 公开门面成员都在 API-GUIDE 中出现', () => {
    const guide = readFileSync(join(process.cwd(), 'docs', 'API-GUIDE.md'), 'utf8')
    // 构造最小 ctx 取命名空间方法名（不触发副作用）
    const ctx = new TaskContext({
      page: {} as never,
      task: { meta: { key: 'x', name: 'x', url: '' } },
      profile: { id: 1, bitbrowserId: 'b', name: '窗口1', enabled: 1, circuitBreakerCount: 0 },
      cfg: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      artifactsDir: '',
      walletPasswords: {},
    })
    const missing = publicMembers(ctx).filter((m) => {
      const name = m.includes('.') ? m.split('.')[1] : m
      return !guide.includes(name)
    })
    expect(missing, `手册缺少方法: ${missing.join(', ')}`).toEqual([])
  })
})
```

> 若 `TaskContext` 公开还含 `turnstileLogger` 等私有项，测试按 `getOwnPropertyNames` 会取到私有方法（JS 无真私有）——用 `#name` 真私有或过滤 `turnstileLogger`。实现时以实际公开面为准，确保只校验**文档承诺的公开成员**（`page/log/profile/account/accountRow/uploadFile/screenshot/safeScreenshot/js/wallet/captcha/race/recover/step/steps`）。可改为显式白名单数组，避免误伤。

- [ ] **Step 2: 运行验证**

Run: `npx vitest run tests/docs-drift.test.ts`
Expected: PASS（若失败说明手册缺方法，回到 Task 1 补齐）

- [ ] **Step 3: 提交**

```bash
git add tests/docs-drift.test.ts
git commit -m "test: 文档漂移守卫（TaskContext 门面成员须在 API-GUIDE 出现）"
```

---

### Task 3: 面板文档页适配与 schema 重生成

**Files:**
- Modify: `web/src/api/schema.d.ts`（重生成）
- Modify（若需要）: `web/src/pages/docs/*`、`src/server/routes/docs.ts`（示例白名单/标题锚点无需改，除非引用旧章名）

- [ ] **Step 1: 检查面板文档页**

阅读 `web/src/pages/docs/index.tsx`、`useDocTree.ts`、`slug.ts`、`src/server/routes/docs.ts`：确认章节树由 markdown 标题自动生成，无硬编码旧章名/锚点。若有硬编码（如跳转旧章节），改之。

- [ ] **Step 2: 重生成 OpenAPI 类型（若后端起得来）**

Run: `npx openapi-typescript http://127.0.0.1:3000/api/docs/openapi.json -o web/src/api/schema.d.ts`
（需后端运行；若不可用，保持**手补**为既有先例，仅确认无 `/api/captcha/balance` 残留。）

- [ ] **Step 3: 运行验证**

Run: `npm run test:web`；`npm run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: 面板文档页/类型与新手册对齐"
```

---

### Task 4: 全量回归与终审

**Files:** 无

- [ ] **Step 1: 全量回归**

Run: `npm run typecheck`；`npm test`；`npm run test:web`
Expected: 全部 PASS（含漂移守卫）

- [ ] **Step 2: 终审（独立 subagent）**

审查：手册结构与新架构一致；无过时 API 宣传；漂移守卫有效；面板文档页正常；无断链锚点。

- [ ] **Step 3: 提交（如有改动）**

---

## Self-Review

- **Spec coverage**：Task 1 整份重写（新结构 0–13+附录、并入 LESSONS、删过时）；Task 2 漂移守卫；Task 3 面板/类型对齐；Task 4 回归+终审。
- **Placeholder scan**：无 TBD；手册内容要求与准确字段清单已列全；漂移测试给完整代码（含白名单/私有项提示）。
- **Type consistency**：手册引用的方法/字段与 `task-context.ts`/`login-flow.ts`/`task.ts`/`base.ts` 源码一致；漂移守卫断言公开面。
- **风险**：手册为长文，须以源码为准逐章核对；漂移测试避免把私有 `turnstileLogger` 误列为缺项（用显式公开白名单更稳）。
