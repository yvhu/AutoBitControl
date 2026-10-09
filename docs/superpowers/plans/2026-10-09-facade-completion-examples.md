# 门面补全与示例任务重写 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 P1 薄门面遗漏的两处能力（`ctx.safeScreenshot`、`ctx.captcha` 命名空间）并去掉钱包动作对 `Humanizer` 的最后依赖；再用新骨架重写 3 个示例任务，确立「SiteTask 模板 + LoginSpec + patchright 直调」的范式。

**Architecture:** 全部为**增量改动**：旧方法（`clickTurnstileBox`/`autoClickTurnstile`/`screenshot`/`humanize` 等）保留，新能力叠加。示例任务改为 `SiteTask` 的 `action(ctx)`，页面操作直调 `ctx.page`（patchright），登录用 `login: LoginSpec` 声明。为后续「真实任务重写 → 清理 → 文档」计划铺路。

**Tech Stack:** TypeScript（严格模式）、patchright 1.62.1、vitest 3.2（fake page + `as never`）。

## Global Constraints

- 依赖方向：`tasks → engine → automation/integrations → infrastructure`，不可反向；跨层引用用 `import type`。
- **每个 automation 子目录必须有 `index.ts` 统一出口**；目录外引用只从 `index.ts` 导入。
- 代码风格：无分号、单引号、2 空格缩进；文件头中文注释块；命名 camelCase，文件 kebab-case。
- 日志：`logger.info({ step, window, ... }, '中文消息')`。
- 任务里 DOM 操作**直调 `ctx.page`**（patchright），不再用旧扁平 DSL（`ctx.clickCheckin`/`ctx.typeInto`/`ctx.visible`…）；登录用 `ctx.wallet.ensureLoggedIn`。
- 提交风格：conventional + 中文，单行。
- 验证命令：`npx vitest run <file>`、`npm run typecheck`、`npm test`。
- 运行环境：Windows PowerShell 5.1；分支 `feat/task-thin-facade`。
- 示例任务 `url` 为空、`enabled:false`：无真机验证，靠 typecheck + 全量单测。

---

### Task 1: `ctx.safeScreenshot` 容错截图

**Files:**
- Modify: `src/engine/task-context.ts`（新增 `safeScreenshot` 方法）
- Test: `tests/task-context-namespaces.test.ts`

**Interfaces:**
- Produces: `TaskContext.safeScreenshot(name: string): Promise<string>` —— 截图存产物目录，失败只告警返回空串，绝不抛错。

- [ ] **Step 1: 写失败测试**（在 `tests/task-context-namespaces.test.ts` 追加 describe）

```ts
describe('TaskContext.safeScreenshot', () => {
  it('截图失败只告警不抛错，返回空串', async () => {
    const ctx = makeCtx()
    ctx.screenshot = vi.fn().mockRejectedValue(new Error('CDP 超时'))
    await expect(ctx.safeScreenshot('x')).resolves.toBe('')
  })

  it('截图成功返回路径', async () => {
    const ctx = makeCtx()
    ctx.screenshot = vi.fn().mockResolvedValue('/tmp/x.png')
    await expect(ctx.safeScreenshot('x')).resolves.toBe('/tmp/x.png')
  })
})
```

（`makeCtx` 已在 `tests/task-context-namespaces.test.ts` 内定义；本步骤需在文件顶部 `import { describe, it, expect, vi } from 'vitest'` 已含 `vi`。）

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/task-context-namespaces.test.ts`
Expected: FAIL（`ctx.safeScreenshot is not a function`）

- [ ] **Step 3: 最小实现**（`src/engine/task-context.ts`，`screenshot` 方法之后新增）

```ts
  /**
   * 容错截图：截图失败只告警不判任务失败（站点持续动画时 CDP 截图偶发挂起，真机教训）
   * @returns 成功返回路径；失败返回空串
   */
  async safeScreenshot(name: string): Promise<string> {
    try {
      return await this.screenshot(name)
    } catch (e) {
      this.log.warn({ step: 'screenshot', window: this.deps.profile.name, err: (e as Error).message }, '截图失败（不影响任务结果）')
      return ''
    }
  }
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/task-context-namespaces.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/task-context.ts tests/task-context-namespaces.test.ts
git commit -m "feat: TaskContext.safeScreenshot 容错截图"
```

---

### Task 2: `ctx.captcha` 命名空间

**Files:**
- Modify: `src/engine/task-context.ts`（新增 `get captcha()` 命名空间）
- Test: `tests/task-context-namespaces.test.ts`

**Interfaces:**
- Consumes: 既有 `clickTurnstileBox`/`turnstileVisible`/`autoClickTurnstile`/`waitCaptchaPassed`
- Produces: `ctx.captcha.turnstile(opts?)`、`ctx.captcha.visible(selectors?)`、`ctx.captcha.autoClick(budgetMs?)`、`ctx.captcha.waitPlugin(opts?)`

- [ ] **Step 1: 写失败测试**（追加）

```ts
describe('ctx.captcha 命名空间', () => {
  it('暴露 turnstile/visible/autoClick/waitPlugin', () => {
    const ctx = makeCtx()
    expect(typeof ctx.captcha.turnstile).toBe('function')
    expect(typeof ctx.captcha.visible).toBe('function')
    expect(typeof ctx.captcha.autoClick).toBe('function')
    expect(typeof ctx.captcha.waitPlugin).toBe('function')
  })
})
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/task-context-namespaces.test.ts`
Expected: FAIL（`ctx.captcha` 不存在）

- [ ] **Step 3: 最小实现**（`src/engine/task-context.ts`，`steps()` 之后新增）

```ts
  /** 验证码能力命名空间（Turnstile 方框 + 打码插件；旧扁平方法保留兼容） */
  get captcha() {
    return {
      turnstile: (opts?: { selectors?: string[]; maxAttempts?: number }) => this.clickTurnstileBox(opts),
      visible: (selectors?: string[]) => this.turnstileVisible(selectors),
      autoClick: (budgetMs?: number) => this.autoClickTurnstile(budgetMs),
      waitPlugin: (opts?: { timeoutMs?: number; siteKeyExclude?: string }) => this.waitCaptchaPassed(opts),
    }
  }
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/task-context-namespaces.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/task-context.ts tests/task-context-namespaces.test.ts
git commit -m "feat: ctx.captcha 命名空间（Turnstile/插件）"
```

---

### Task 3: 钱包动作点击改用 patchright（去掉 `Humanizer` 依赖）

**Files:**
- Modify: `src/automation/wallet/actions.ts`（`WalletActionsDeps.human` → `click(page, selector)` 或直接用 `page.locator`）
- Modify: `src/automation/wallet/login-flow.ts`（连接入口点击改用新方式）
- Modify: `src/engine/task-context.ts`（`ctx.wallet` 接线去掉 `human`）
- Test: `tests/wallet-login-flow.test.ts`（fake deps 去掉 `human`）

**Interfaces:**
- 变更：`WalletActionsDeps` 删除 `human: { click }` 字段；连接入口点击改为 `page.locator(selector).click({ timeout })`（patchright 原生）。
- 消费 `login-flow.ts` 的 `deps.human.click(spec.connect)`/`deps.human.click(entry.confirm)` → 改为 `deps.page.locator(sel).click().catch(() => {})`。

- [ ] **Step 1: 写失败测试**（`tests/wallet-login-flow.test.ts`：把 fake deps 的 `human` 换成记录点击的 page.locator）

```ts
// 在 deps() 工厂里：删除 human 字段；page.locator(sel).first().click 记录到 clicks
// page.locator: (sel: string) => ({ first() { return this }, click: async () => { clicks.push(sel) }, count: async () => 0, isVisible: async () => false, waitFor: async () => {} })
```

并把「未登录 → 点连接」用例断言改为：`expect(clicks).toContain(SPEC.connect)`。

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/wallet-login-flow.test.ts`
Expected: FAIL（`deps.human` 已删除，代码仍引用）

- [ ] **Step 3: 最小实现**

`src/automation/wallet/actions.ts`：从 `WalletActionsDeps` 删除 `human` 字段；`runIntent` 的补点改为：

```ts
      if (!appeared && opts.reclick) {
        await this.deps.page.locator(opts.reclick.selector).first().click({ timeout: 5000 }).catch(() => {})
      }
```

（注意：`opts.reclick` 已保证存在；原 `if (!appeared) await this.deps.human.click(...)`。）

`src/automation/wallet/login-flow.ts`：把两处 `await deps.human.click(sel).catch(() => {})` 改为：

```ts
    const clickSoft = async (sel: string): Promise<void> => {
      await deps.page.locator(sel).first().click({ timeout: 5000 }).catch(() => {})
    }
```

并分别调用 `clickSoft(spec.connect)`、`clickSoft(entry.confirm)`。

`src/engine/task-context.ts`：`ctx.wallet` 构造去掉 `human: {...}` 字段。

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/wallet-login-flow.test.ts tests/wallet.test.ts tests/login-by-wallet.test.ts`；`npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/automation/wallet/actions.ts src/automation/wallet/login-flow.ts src/engine/task-context.ts tests/wallet-login-flow.test.ts
git commit -m "refactor: 钱包动作点击改用 patchright，去掉 WalletActions 对 Humanizer 的依赖"
```

---

### Task 4: 示例任务重写（example-checkin）

**Files:**
- Modify: `src/tasks/example-checkin.ts`
- 无独立测试（`url` 为空，靠 typecheck + 全量回归）

**Interfaces:**
- Consumes: `SiteTask`（`login?: LoginSpec` + `action?`）、`ctx.page`、`ctx.safeScreenshot`
- Produces: `ExampleCheckinTask` 使用 `login` 声明 + `action`

- [ ] **Step 1: 重写文件**（完整替换 `src/tasks/example-checkin.ts`）

```ts
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

// 标准每日签到参考实现（新范式）：登录声明 login → 站点动作 action，页面操作直调 patchright。
// 新增任务从这里复制改起：先跑通流程，再逐步替换选择器。
export class ExampleCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'example-checkin',
    name: '示例签到',
    group: { key: 'example', name: '示例' },
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭；调试时在面板任务页打开开关，或用 task:run 脚本直接跑（不受开关限制）',
    category: 'checkin',
    lastUpdated: '2026-10-09',
    enabled: false,
    wallet: 'metamask',
    timeoutSec: 180,
    retry: { max: 2, backoffSec: 600 },
    concurrency: 4,
  }

  // 登录声明：默认 run 会先跑 ensureLoggedIn（竞速判登录态 → 点连接 → 签名/确认 → 等登录完成）
  login: LoginSpec = {
    loggedIn: { text: '连接钱包' },   // 占位：换成站点已登录标志（文案或 { selector }）
    loggedOut: '连接钱包',            // 占位：换成站点未登录标志
    connect: 'button:has-text("连接钱包")', // 占位：换成站点连接入口
    entry: { kind: 'direct' },
  }

  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page // ← patchright；点击/填写/等待都用原生 API
    // 已签到直接成功返回
    if (await page.getByText('已签到').count() > 0) return
    // 点签到按钮并断言成功标志（宁严勿松）
    await page.locator('#checkin-btn').click()
    await page.locator('#checked-badge').waitFor({ state: 'visible', timeout: 10000 })
  }
}
```

- [ ] **Step 2: 运行验证**

Run: `npm run typecheck`；`npx vitest run tests/task-base.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/tasks/example-checkin.ts
git commit -m "refactor: 示例签到任务改用 SiteTask 模板 + patchright 直调"
```

---

### Task 5: 示例任务重写（faucet-example）

**Files:**
- Modify: `src/tasks/faucet-example.ts`

**Interfaces:**
- Consumes: `ctx.page`、`ctx.accountRow`、`ctx.safeScreenshot`

- [ ] **Step 1: 重写文件**（完整替换）

```ts
import { faker } from '@faker-js/faker'
import { SiteTask, type TaskContext, type TaskMeta } from './base'

// 测试网水龙头领水参考实现（新范式）：状态判断 → 数据源邮箱（faker 兜底）→ 领取 → 断言成功。
// 不连钱包：无 login 声明。
export class FaucetExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'faucet-example',
    name: '示例领水',
    group: { key: 'example', name: '示例' },
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭，调试时打开面板开关或用 task:run；水龙头一般每 24h 限领一次；邮箱优先取数据源「邮箱」列（config/accounts.xlsx，无则 faker 随机）',
    category: 'faucet',
    lastUpdated: '2026-10-09',
    enabled: false,
    wallet: 'metamask',
    timeoutSec: 240,
    retry: { max: 1, backoffSec: 300 },
    concurrency: 4,
  }

  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page
    // 已领过 → 直接成功
    if (await page.getByText('已领取').count() > 0) return
    // 维护中 → 抛错进失败流程（面板可看截图/日志）
    if (await page.getByText('维护中').count() > 0) throw new Error('水龙头维护中')
    // 邮箱：数据源优先、faker 兜底
    const email = ctx.accountRow?.['邮箱'] || faker.internet.email()
    await page.locator('input[name="email"]').fill(email)
    // 领取 + 断言成功文案
    await page.locator('#claim-btn').click()
    await page.locator('.success-toast').waitFor({ state: 'visible', timeout: 10000 })
    await ctx.safeScreenshot('faucet-success')
  }
}
```

- [ ] **Step 2: 运行验证**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/tasks/faucet-example.ts
git commit -m "refactor: 示例领水任务改用 SiteTask 模板 + patchright 直调"
```

---

### Task 6: 示例任务重写（mint-example）

**Files:**
- Modify: `src/tasks/mint-example.ts`

**Interfaces:**
- Consumes: `ctx.page`、`ctx.wallet.confirmTx`、`ctx.safeScreenshot`、`LoginSpec`

- [ ] **Step 1: 重写文件**（完整替换）

```ts
import { faker } from '@faker-js/faker'
import { SiteTask, type LoginSpec, type TaskContext, type TaskMeta } from './base'

// 铸币参考实现（新范式）：钱包登录声明 → 多步骤表单 → 提交后等钱包确认 → 断言链上结果。
export class MintExampleTask extends SiteTask {
  meta: TaskMeta = {
    key: 'mint-example',
    name: '示例铸币',
    group: { key: 'example', name: '示例' },
    url: '',
    sourceUrl: '',
    note: '示例任务：url 为空且开关默认关闭；多步骤表单站点常见"下一步"按钮无 loading 提示',
    category: 'mint',
    lastUpdated: '2026-10-09',
    enabled: false,
    wallet: 'petra',
    timeoutSec: 300,
    retry: { max: 1, backoffSec: 600 },
    concurrency: 4,
  }

  login: LoginSpec = {
    loggedIn: { text: '连接钱包' },
    loggedOut: '连接钱包',
    connect: 'button:has-text("连接钱包")',
    entry: { kind: 'direct' },
  }

  async action(ctx: TaskContext): Promise<void> {
    const page = ctx.page
    const tokenName = faker.word.words(2)
    const tokenSymbol = tokenName.replace(/[aeiou]/gi, '').slice(0, 4).toUpperCase()
    // 第一步：代币名称与符号
    await page.locator('input[name="name"]').fill(tokenName)
    await page.locator('input[name="symbol"]').fill(tokenSymbol)
    // 多步骤：点"下一步"后等第二步元素出现（用等待代替固定 sleep）
    await page.locator('#step-next').click()
    await page.locator('#step-2').waitFor({ state: 'visible', timeout: 10000 })
    // 第二步：描述与数量
    await page.locator('textarea[name="description"]').fill(faker.lorem.sentence())
    await page.locator('input[name="amount"]').fill(String(faker.number.int({ min: 1, max: 100 })))
    // 提交（站点随后唤起钱包交易确认弹窗）
    await page.locator('#mint-submit').click()
    await ctx.wallet.confirmTx({ reclick: { selector: '#mint-submit', afterMs: 8000 } })
    // 断言链上结果提示
    await page.locator('.tx-success').waitFor({ state: 'visible', timeout: 30000 })
    await ctx.safeScreenshot('mint-success')
  }
}
```

- [ ] **Step 2: 运行验证**

Run: `npm run typecheck`；`npx vitest run tests/task-base.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add src/tasks/mint-example.ts
git commit -m "refactor: 示例铸币任务改用 SiteTask 模板 + patchright 直调"
```

---

### Task 7: 全量回归与收尾

**Files:** 无（仅验证）

- [ ] **Step 1: 全量回归**

Run: `npm run typecheck`；`npm test`
Expected: 全部 PASS（旧方法仍在，真实任务未迁移，行为不变）

- [ ] **Step 2: 确认新能力可用（聚焦）**

Run: `npx vitest run tests/task-context-namespaces.test.ts tests/wallet-login-flow.test.ts tests/task-base.test.ts`
Expected: PASS

- [ ] **Step 3: 提交（如有改动）**

无改动则跳过。

---

## Self-Review

- **Spec coverage**：本计划补齐 `ctx.safeScreenshot`（Task 1）、`ctx.captcha` 命名空间（Task 2）、钱包点击去 Humanizer（Task 3），并以示例任务确立新范式（Task 4–6）。真实任务重写、清理（删旧方法/humanize/ghost-cursor）、文档重排与漂移守卫、诊断面板在本计划范围外（见「后续计划」）。
- **Placeholder scan**：无 TBD/TODO；新增/重写文件均含完整代码。
- **Type consistency**：`safeScreenshot` 在 Task 1 定义、Task 4–6 消费；`ctx.captcha.*` 签名与既有方法一致；`WalletActionsDeps` 删除 `human` 后 Task 3 同步更新 login-flow/接线/测试。

## 后续计划（依赖本计划的产出）

1. **真实任务重写（P2）**：按簇迁移 8 个真实任务到新骨架（DOM 直调 patchright、登录改 `login` 声明、`ctx.recover`/`ctx.race`/`ctx.step`/`ctx.safeScreenshot`、`ctx.captcha.*`），逐簇真机验证：
   - 簇 A 无钱包地址类：`arc-faucet` / `shelby-faucet` / `auralaunch-faucet`
   - 簇 B 直接登录：`portal-rhuna` / `konnex-checkin`
   - 簇 C AppKit/多签：`inception-dachain` / `shelby-explorer`
2. **清理（P3）**：全部迁移后删除旧扁平方法（`humanize`/`find`/`wait.*`/`clickCheckin`/`typeInto`/`closeModal`/`detectPageState`…）、移除 `ghost-cursor` 依赖、`task-context.ts` 与 `window-runner.ts` 收口到 barrel。
3. **文档（P3）**：`docs/API-GUIDE.md` 第 3/4/9 章按新范式重排；AI 帮写模板加硬约束；`tests/docs-drift.test.ts` 漂移守卫。
4. **诊断面板（P4）**：`runs.diag_path` migrate、`window-runner` 失败采集诊断包、`GET /api/diagnostics`、看板失败行诊断视图。
