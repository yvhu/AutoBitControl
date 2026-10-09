# AI 答题能力 与 熔断每日重置 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 AI 调用能力（`askAi`/`answerQuiz`，OpenAI 兼容默认 DeepSeek），以及熔断每日 23:59 定时重置。

**Architecture:** AI 走 `integrations/ai`（OpenAI 兼容客户端）+ `config.ai` + `api/ai.ts`（对外函数）+ `TaskContext.ai` 运行时字段。熔断重置走 `config.execution.circuitBreakerResetAt` + `db.resetMeltedCircuitBreakers` + `engine/maintenance.ts` 每日定时器。

**Tech Stack:** TypeScript（严格）、Node fetch（`httpJson`）、libsql/SQLite、vitest。

## Global Constraints

- 依赖方向：`tasks → api → engine → {automation, integrations} → infrastructure`。
- 密钥只进 `config/.env`（gitignore）；`config.json` 的 `ai.apiKey` 留空；示例写 `config/.env.example`；日志不打印 key。
- 代码风格：无分号、单引号、2 空格缩进；文件头中文注释块；每个子目录一个 `index.ts` 出口。
- 验证：`npm run typecheck`、`npm test`；涉及 web 时 `npm run test:web`。
- 提交风格：conventional + 中文。
- 分支：在 `develop` 上直接做（或另开 `feat/ai-breaker`）。

---

### Task 1: 配置新增 `ai` 段

**Files:**
- Modify: `src/infrastructure/config.ts`、`config/.env.example`、`config/config.json`
- Test: `tests/config.test.ts`

**Interfaces:**
- `interface AiConfig { provider: string; apiBase: string; model: string; apiKey: string; timeoutMs: number }`
- `AppConfig.ai: AiConfig`

- [ ] **Step 1: 写失败测试**（`tests/config.test.ts` 追加）
```ts
it('ai 段默认值正确', () => {
  const cfg = loadConfig()
  expect(cfg.ai.provider).toBe('openai-compatible')
  expect(cfg.ai.apiBase).toBe('https://api.deepseek.com')
  expect(cfg.ai.model).toBe('deepseek-flash')
  expect(cfg.ai.apiKey).toBe('')
  expect(cfg.ai.timeoutMs).toBe(30000)
})
it('环境变量覆盖 ai', () => {
  const cfg = loadConfig({ env: { AI_API_KEY: 'k', AI_MODEL: 'm', AI_API_BASE: 'https://x' } })
  expect(cfg.ai.apiKey).toBe('k')
  expect(cfg.ai.model).toBe('m')
  expect(cfg.ai.apiBase).toBe('https://x')
})
```
（按 `tests/config.test.ts` 既有 `loadConfig` 用法调整签名。）

- [ ] **Step 2: 运行验证失败** `npx vitest run tests/config.test.ts` → FAIL
- [ ] **Step 3: 实现**

`src/infrastructure/config.ts`：加接口 + `AppConfig.ai` + defaults：
```ts
export interface AiConfig {
  /** provider 标识（当前仅 OpenAI 兼容） */
  provider: string
  /** OpenAI 兼容 API 根地址（如 https://api.deepseek.com） */
  apiBase: string
  /** 模型 id（如 deepseek-flash） */
  model: string
  /** API Key（来自 AI_API_KEY，仅本机 .env） */
  apiKey: string
  /** 请求超时毫秒 */
  timeoutMs: number
}
```
defaults：`ai: { provider: 'openai-compatible', apiBase: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '', timeoutMs: 30000 }`。
env 覆盖：`AI_API_KEY`→apiKey、`AI_API_BASE`→apiBase、`AI_MODEL`→model。

`config/config.json` 加 `"ai": { "provider": "openai-compatible", "apiBase": "https://api.deepseek.com", "model": "deepseek-flash", "apiKey": "", "timeoutMs": 30000 }`。
`config/.env.example` 加 `AI_API_KEY=` 与注释。

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/config.test.ts`；`npm run typecheck` → PASS
- [ ] **Step 5: 提交** `feat: 配置新增 ai 段（OpenAI 兼容，默认 DeepSeek）`

---

### Task 2: `integrations/ai` 客户端

**Files:** Create `src/integrations/ai/{types.ts,openai-compatible.ts,index.ts}`；Test `tests/ai-client.test.ts`

**Interfaces:**
```ts
export type ChatRole = 'system' | 'user'
export interface ChatMessage { role: ChatRole; content: string }
export interface ChatOptions { maxTokens?: number; temperature?: number; json?: boolean; timeoutMs?: number }
export interface AiClient { chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> }
export function createAiClient(cfg: { apiBase: string; model: string; apiKey: string; timeoutMs: number }): AiClient
```

- [ ] **Step 1: 写失败测试** `tests/ai-client.test.ts`
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAiClient } from '../src/integrations/ai'
vi.mock('../src/infrastructure/http', () => ({ httpJson: vi.fn() }))
import { httpJson } from '../src/infrastructure/http'

describe('ai client', () => {
  beforeEach(() => vi.mocked(httpJson).mockReset())
  it('无 key 抛错', async () => {
    const c = createAiClient({ apiBase: 'https://x', model: 'm', apiKey: '', timeoutMs: 1000 })
    await expect(c.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('AI 未配置')
  })
  it('正常返回 content', async () => {
    vi.mocked(httpJson).mockResolvedValue({ choices: [{ message: { content: ' B ' } }] } as never)
    const c = createAiClient({ apiBase: 'https://x', model: 'm', apiKey: 'k', timeoutMs: 1000 })
    expect(await c.chat([{ role: 'user', content: 'q' }])).toBe('B')
    expect(vi.mocked(httpJson).mock.calls[0][0]).toMatchObject({ path: '/chat/completions', method: 'POST' })
  })
})
```

- [ ] **Step 2: 运行验证失败** → FAIL
- [ ] **Step 3: 实现**

`types.ts`（上述接口）。`openai-compatible.ts`：
```ts
import { httpJson } from '../../infrastructure/http'
import type { AiClient, ChatMessage, ChatOptions } from './types'

interface ChatResp { choices?: Array<{ message?: { content?: string } }> }

export function createAiClient(cfg: { apiBase: string; model: string; apiKey: string; timeoutMs: number }): AiClient {
  return {
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
      if (!cfg.apiKey) throw new Error('AI 未配置（AI_API_KEY）')
      const body: Record<string, unknown> = { model: cfg.model, messages, max_tokens: opts.maxTokens ?? 300 }
      if (opts.temperature !== undefined) body.temperature = opts.temperature
      if (opts.json) body.response_format = { type: 'json_object' }
      const res = await httpJson<ChatResp>({
        baseUrl: cfg.apiBase, path: '/chat/completions', method: 'POST',
        timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
        headers: { Authorization: `Bearer ${cfg.apiKey}` }, body,
      })
      return (res.choices?.[0]?.message?.content ?? '').trim()
    },
  }
}
```
`index.ts` 出口 re-export。

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/ai-client.test.ts`；`npm run typecheck` → PASS
- [ ] **Step 5: 提交** `feat: AI 客户端（OpenAI 兼容）`

---

### Task 3: `api/ai.ts`（`askAi`/`answerQuiz`）+ `TaskContext.ai` + 接线

**Files:** Create `src/api/ai.ts`；Modify `src/api/index.ts`、`src/engine/task-context.ts`、`src/engine/window-runner.ts`、`scripts/run-task.ts`；Test `tests/api-ai.test.ts`

**Interfaces:**
```ts
askAi(ctx, prompt, options?: { system?: string; maxTokens?: number; timeoutMs?: number }): Promise<string>
answerQuiz(ctx, spec: { question: string | { selector: string }; options: { selector: string }; match?: 'letter' | 'index' | 'text' }): Promise<{ answer: string; clicked: boolean; fallback: boolean }>
```

- [ ] **Step 1: 写失败测试** `tests/api-ai.test.ts`
（fake ctx：`ai.chat` mock 返回字母；`page.locator().count()/nth(i).textContent()/nth(i).click`）
断言：AI 答 'B' → 点第 1 个选项（0 基）→ `{ fallback:false }`；AI 返回乱码 → 兜底点击 → `fallback:true`；无选项元素 → 抛错。

- [ ] **Step 2: 运行验证失败** → FAIL
- [ ] **Step 3: 实现**

`src/api/ai.ts`：
```ts
/**
 * AI 能力函数（api 层）：任意提问 / 页面问答
 * 依赖方向：engine TaskContext 类型、api/find 的 getText
 */
import type { TaskContext } from '../engine/task-context'
import { getText } from './find'

/** 低层：问 AI 要一段文本（system 可选） */
export async function askAi(ctx: TaskContext, prompt: string, options: { system?: string; maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
  if (!ctx.ai) throw new Error('AI 未配置（AI_API_KEY）')
  const messages = [
    ...(options.system ? [{ role: 'system' as const, content: options.system }] : []),
    { role: 'user' as const, content: prompt },
  ]
  return ctx.ai.chat(messages, { maxTokens: options.maxTokens, timeoutMs: options.timeoutMs })
}

/** 解析 AI 答案为选项序号（越界/解析不出返回 null） */
function parseIndex(answer: string, match: 'letter' | 'index' | 'text', optionTexts: string[], n: number): number | null {
  const a = answer.trim()
  if (match === 'letter') {
    const m = a.match(/[A-Za-z]/)
    if (!m) return null
    const idx = m[0].toUpperCase().charCodeAt(0) - 65
    return idx >= 0 && idx < n ? idx : null
  }
  if (match === 'index') {
    const m = a.match(/\d+/)
    if (!m) return null
    const idx = Number(m[0]) - 1
    return idx >= 0 && idx < n ? idx : null
  }
  // text：找与答案文本最匹配的选项
  const idx = optionTexts.findIndex((t) => t && a.includes(t))
  return idx >= 0 ? idx : null
}

/** 页面问答：读题干+选项 → 问 AI → 选并点击；解析失败兜底随机点一项（答了就算成功） */
export async function answerQuiz(ctx: TaskContext, spec: { question: string | { selector: string }; options: { selector: string }; match?: 'letter' | 'index' | 'text' }): Promise<{ answer: string; clicked: boolean; fallback: boolean }> {
  const question = typeof spec.question === 'string' ? spec.question : await getText(ctx, spec.question.selector)
  const loc = ctx.page.locator(spec.options.selector)
  const n = await loc.count()
  if (n === 0) throw new Error(`未找到选项元素: ${spec.options.selector}`)
  const texts: string[] = []
  for (let i = 0; i < n; i++) texts.push(((await loc.nth(i).textContent()) ?? '').trim())
  const list = texts.map((t, i) => `${String.fromCharCode(65 + i)}. ${t}`).join('\n')
  const answer = await askAi(ctx, `${question}\n\n${list}`, { system: '你是答题助手，只输出一个选项字母（如 A），不要解释。' })
  const idx = parseIndex(answer, spec.match ?? 'letter', texts, n)
  if (idx === null) {
    const rand = Math.floor(Math.random() * n)
    await loc.nth(rand).click()
    ctx.log.warn({ step: 'quiz', window: ctx.profile.name, answer, n }, 'AI 答案无法解析，兜底随机作答')
    return { answer, clicked: true, fallback: true }
  }
  await loc.nth(idx).click()
  ctx.log.info({ step: 'quiz', window: ctx.profile.name, answer, idx }, 'AI 作答并点击选项')
  return { answer, clicked: true, fallback: false }
}
```
`src/api/index.ts` 追加 `export { askAi, answerQuiz } from './ai'`。

`TaskContext`：`TaskContextDeps` 加 `ai?: AiClient`；加 getter `get ai(): AiClient | undefined { return this.deps.ai }`（import type AiClient）。

`window-runner.ts` 与 `scripts/run-task.ts`：构建 `const ai = createAiClient(cfg.ai)` 并传入 TaskContext（`ai`）。`createAiClient` 从 `../integrations/ai` / `../../integrations/ai` import。

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/api-ai.test.ts`；`npm run typecheck` → PASS
- [ ] **Step 5: 提交** `feat: api AI 函数（askAi/answerQuiz）+ TaskContext.ai 接线`

---

### Task 4: 熔断重置配置 + DB

**Files:** Modify `src/infrastructure/config.ts`、`src/infrastructure/db.ts`；Test `tests/config.test.ts`、`tests/db.test.ts`

**Interfaces:**
- `ExecutionConfig.circuitBreakerResetAt: string`（默认 `"23:59"`，`""` 关闭）
- `AppDb.resetMeltedCircuitBreakers(): Promise<number>`

- [ ] **Step 1: 写失败测试**
```ts
// config.test.ts
it('circuitBreakerResetAt 默认 23:59', () => { expect(loadConfig().execution.circuitBreakerResetAt).toBe('23:59') })
// db.test.ts
it('resetMeltedCircuitBreakers 归零所有 count>0 并返回数量', async () => {
  const p = await db.upsertProfile({ bitbrowserId: 'b1', name: 'w1' })
  await db.incrCircuitBreaker(p.id); await db.incrCircuitBreaker(p.id)
  const n = await db.resetMeltedCircuitBreakers()
  expect(n).toBeGreaterThanOrEqual(1)
  const after = (await db.listProfiles()).find((x) => x.id === p.id)
  expect(after?.circuitBreakerCount).toBe(0)
})
```
（按既有 db 测试的 profile 创建方式调整。）

- [ ] **Step 2: 运行验证失败** → FAIL
- [ ] **Step 3: 实现**
  - config：`ExecutionConfig` 加 `circuitBreakerResetAt: string`；defaults `circuitBreakerResetAt: '23:59'`；env 可覆盖（可选 `CIRCUIT_BREAKER_RESET_AT`）。
  - db：
```ts
/** 重置所有熔断计数 > 0 的窗口，返回被重置的行数 */
async resetMeltedCircuitBreakers(): Promise<number> {
  const rs = await this.client.execute('UPDATE profiles SET circuit_breaker_count = 0 WHERE circuit_breaker_count > 0')
  return Number(rs.rowsAffected ?? 0)
}
```
- [ ] **Step 4: 运行验证通过** `npx vitest run tests/config.test.ts tests/db.test.ts`；`npm run typecheck` → PASS
- [ ] **Step 5: 提交** `feat: 熔断重置配置 circuitBreakerResetAt + db.resetMeltedCircuitBreakers`

---

### Task 5: 每日定时重置（`engine/maintenance.ts`）+ app 接线

**Files:** Create `src/engine/maintenance.ts`；Modify `src/app.ts`；Test `tests/maintenance.test.ts`

**Interfaces:**
```ts
startCircuitBreakerResetSchedule(cfg: AppConfig, db: AppDb, logger: Logger): { stop(): void }
```

- [ ] **Step 1: 写失败测试** `tests/maintenance.test.ts`
```ts
import { describe, it, expect, vi } from 'vitest'
import { startCircuitBreakerResetSchedule } from '../src/engine/maintenance'

describe('maintenance 熔断每日重置', () => {
  it('关闭配置时不排程', () => {
    const db = { resetMeltedCircuitBreakers: vi.fn() } as never
    const cfg = { execution: { circuitBreakerResetAt: '' }, scheduler: { timezone: 'Asia/Shanghai' } } as never
    const h = startCircuitBreakerResetSchedule(cfg, db, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never)
    expect(typeof h.stop).toBe('function')
    h.stop()
  })
  it('到点执行并重置（注入 now + fake timers）', async () => { /* 见实现：运行一次 tick 断言 db 被调 */ })
})
```
（因时区/定时，测试注入 `now()` 与小时间；或导出内部 `msUntilNextReset` 纯函数单独测。）

- [ ] **Step 2: 运行验证失败** → FAIL
- [ ] **Step 3: 实现**

`src/engine/maintenance.ts`：
```ts
/**
 * 后台维护（engine 层）：熔断每日定时重置
 * 依赖方向：仅依赖 infrastructure（config/db/logger 类型）
 * 设计思路：算下一次到点（按 tz）→ setTimeout → 执行重置 → 重排次日；同分钟幂等
 */
import type { AppConfig } from '../infrastructure/config'
import type { Logger } from '../infrastructure/logger'
import type { AppDb } from '../infrastructure/db'

/** 计算从 now 到下一次 hh:mm（按 tz 墙上时间）的毫秒；hh:mm 非法返回 -1 */
export function msUntilNext(hhmm: string, tz: string, now = Date.now()): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return -1
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return -1
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]))
  const curSec = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second)
  const targetSec = h * 3600 + min * 60
  let delta = targetSec - curSec
  if (delta <= 0) delta += 86400
  return delta * 1000
}

/** 启动每日熔断重置（circuitBreakerResetAt 为空则不排程） */
export function startCircuitBreakerResetSchedule(cfg: AppConfig, db: AppDb, logger: Logger): { stop(): void } {
  const at = cfg.execution.circuitBreakerResetAt
  const tz = cfg.scheduler.timezone
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  const scheduleNext = (): void => {
    if (stopped || !at) return
    const ms = msUntilNext(at, tz)
    if (ms < 0) { logger.warn({ at }, 'circuitBreakerResetAt 非法，跳过一次重置排程'); return }
    timer = setTimeout(() => {
      void (async () => {
        try {
          const reset = await db.resetMeltedCircuitBreakers()
          logger.info({ reset }, '熔断每日重置完成')
        } catch (e) {
          logger.warn({ err: (e as Error).message }, '熔断每日重置失败')
        } finally {
          scheduleNext()
        }
      })()
    }, ms)
  }
  scheduleNext()
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer) } }
}
```

`src/app.ts`：在服务就绪后 `const maintenance = startCircuitBreakerResetSchedule(cfg, db, logger)`；返回/暴露以便 `index.ts` 退出时 `maintenance.stop()`（若现有退出钩子；否则可省略）。

- [ ] **Step 4: 运行验证通过** `npx vitest run tests/maintenance.test.ts`；`npm run typecheck`；`npm test` → PASS
- [ ] **Step 5: 提交** `feat: 熔断每日 23:59 定时重置（engine/maintenance）`

---

### Task 6: 文档同步与回归

**Files:** Modify `AGENTS.md`、`docs/API-GUIDE.md`、`config/.env.example`

- [ ] **Step 1: 文档同步**
  - `docs/API-GUIDE.md`：函数参考加 `askAi`/`answerQuiz`（用途/参数表/示例/注意，含「答了就算成功」「未配 key 抛错」）；配置章节加 `ai` 段 + `execution.circuitBreakerResetAt`；熔断说明改「每日 23:59 自动重置」；`api-docs-drift` 守卫需含新函数（自动覆盖，只要出口导出）。
  - `AGENTS.md`：分层 `automation/` 旁补 `integrations/ai`；踩坑提醒里「当日熔断」改「每日 23:59 重置」。
  - `config/.env.example`：`AI_API_KEY=`。
- [ ] **Step 2: 全量回归** `npm run typecheck`；`npm test`；`npm run test:web` → PASS
- [ ] **Step 3: 提交** `docs: AI 函数与熔断重置文档同步`

---

## Self-Review

- **Spec coverage**：Task1/2/3 = AI（配置/集成/对外函数+接线）；Task4/5 = 熔断（配置/DB/定时）；Task6 = 文档+回归。
- **Placeholder scan**：核心模块给完整代码；测试给关键用例（maintenance 的到点用例建议导纯函数 `msUntilNext` 单测）。
- **Type consistency**：`AiConfig`/`AiClient`/`ChatMessage` 贯穿 config→integrations→api；`circuitBreakerResetAt`/`resetMeltedCircuitBreakers` 贯穿 config→db→maintenance。
- **风险**：推理模型 content 空 → answerQuiz 兜底随机（符合「答了就算成功」）；密钥仅 .env；定时依赖进程常驻。
