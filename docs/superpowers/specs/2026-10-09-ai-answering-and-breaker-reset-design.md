# AI 答题能力 与 熔断每日重置 设计

日期：2026-10-09
状态：设计已确认，待写实施计划

## 背景与目标

1. **AI 答题**：部分签到/任务站点会有问答（QUIZ）。需要提供 AI 调用能力，任务直接在页面问答环节调用 AI 回答（**答了就算成功**，不要求答对）。
2. **熔断每日重置**：现熔断 `profiles.circuit_breaker_count` 只增不减（仅「成功/手动」清零），窗口熔断后次日仍熔断。需**每日 23:59 定时检查并重置所有 count>0 的窗口**。

## 一、AI 答题能力

### 配置

`config/config.json` 新增段（OpenAI 兼容，默认 DeepSeek）：
```json
"ai": {
  "provider": "openai-compatible",
  "apiBase": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "apiKey": "",
  "timeoutMs": 30000
}
```
`config/.env`（gitignore）：`AI_API_KEY`（真实密钥，**只进 .env，绝不提交**）、可选 `AI_API_BASE`、`AI_MODEL`。

> 真机验证：DeepSeek `deepseek-flash` / `deepseek-v4-pro` 均可用；flash 为推理模型，需给足 `max_tokens`（默认 300）否则 `content` 为空。

### 集成层（`src/integrations/ai/`）

```
src/integrations/ai/
  index.ts               # 出口
  types.ts               # ChatMessage / ChatOptions / AiClient 接口
  openai-compatible.ts   # createAiClient(cfg)：走 httpJson 的 /chat/completions
```

```ts
interface ChatMessage { role: 'system' | 'user'; content: string }
interface ChatOptions { maxTokens?: number; temperature?: number; json?: boolean; timeoutMs?: number }
interface AiClient { chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> }
function createAiClient(cfg: { apiBase: string; model: string; apiKey: string; timeoutMs: number }): AiClient
```
`chat` 发 `POST {apiBase}/chat/completions`，body `{ model, messages, max_tokens, temperature?, response_format?:{type:'json_object'} }`，返回 `choices[0].message.content`（截断/空 → 抛错或返回空串，由上层判定）。未配 `apiKey` 时 `createAiClient` 仍创建，但 `chat` 抛「AI 未配置（AI_API_KEY）」。

### 对外函数（`src/api/ai.ts`，经 `src/api/index.ts` 出口）

```ts
/** 低层：问 AI 要一段文本 */
askAi(ctx, prompt: string, options?: { system?: string; maxTokens?: number; timeoutMs?: number }): Promise<string>

/** 高层：页面问答——读题干+选项 → 问 AI → 选项字母 → 点击对应选项 */
answerQuiz(ctx, spec: {
  question: string | { selector: string }          // 题干（原样文本或从选择器取）
  options: { selector: string }                    // 选项元素选择器（匹配多个 = 多选项）
  match?: 'letter' | 'index' | 'text'              // 默认 letter：AI 回 A/B/C… 按字母选
}): Promise<{ answer: string; clicked: boolean; fallback: boolean }>
```

`answerQuiz` 流程：
1. 取题干（`{selector}` → `getText`）与选项文本数组（`locator(sel)` 全部）。
2. 未配 `AI_API_KEY` → **抛「AI 未配置（AI_API_KEY）」**。
3. 组 prompt：system「只输出一个选项字母，不要解释」；user「题干 + 逐行 `A. xxx`」。
4. `askAi` → 解析（按 `match`）出选项序号；点击 `locator(options.selector).nth(idx)`。
5. **解析失败** → 兜底点击随机一个选项（`fallback:true`）——保证「答了」。
6. 返回 `{ answer, clicked, fallback }`；日志记题干/选项/AI 答案/选中项/是否兜底。

### 运行时

- `TaskContextDeps` 加 `ai?: AiClient`；`TaskContext` 暴露只读 `ai` getter。
- `window-runner` 与 `scripts/run-task.ts` 从 `cfg.ai` 构建 `AiClient`（`apiKey` 为空则仍创建，行为同上述）。
- 任务用法：
```ts
import { answerQuiz, waitFor } from '../api'
if (await hasText(ctx, 'QUIZ')) {
  await answerQuiz(ctx, { question: { selector: '.quiz-question' }, options: { selector: '.quiz-option' } })
}
await waitFor(ctx, { text: '答题完成' }, { budgetMs: 15000 })
```

### 安全

- API Key 仅存 `config/.env`（gitignore）；`config.json` 的 `ai.apiKey` 留空；示例值写 `config/.env.example`（`AI_API_KEY=`）。
- 不在日志中打印 key；聊天/文档出现过的 key 建议轮换。

## 二、熔断每日重置

### 配置

`execution.circuitBreakerResetAt: string`（默认 `"23:59"`；空串 `""` 关闭）。时区沿用 `scheduler.timezone`。

### DB

```ts
/** 重置所有熔断计数 > 0 的窗口；返回被重置的窗口数 */
resetMeltedCircuitBreakers(): Promise<number>   // UPDATE profiles SET circuit_breaker_count = 0 WHERE circuit_breaker_count > 0
```

### 触发（`src/engine/maintenance.ts`）

```ts
/** 启动每日熔断重置定时器：算下一次 hh:mm（按 tz）→ 到点执行 db.resetMeltedCircuitBreakers() → 记日志 → 再排次日 */
startCircuitBreakerResetSchedule(cfg, db, logger): { stop(): void }
```
- 在 `src/app.ts` 装配时启动；`index.ts` 退出时可选 `stop()`。
- 时间到点：`reset > 0` 记 `logger.info({ reset }, '熔断每日重置完成')`；`=0` 记 debug/info。
- 幂等：同一天同一分钟只执行一次（按本地日期去重）；进程重启后按当前时间自然重排。
- 时区：复用现有 `scheduler` 的时区处理（若无通用工具，用 `Intl.DateTimeFormat(..., { timeZone })` 取 tz 墙上时间算下次触发毫秒）。

### 文档

- `AGENTS.md` 与 `docs/API-GUIDE.md`：熔断说明由「当日熔断」改为「连续失败达阈值即熔断（剩余任务 skipped）；**每日 23:59 自动重置**；任一任务成功清零；面板可手动重置」。
- `docs/API-GUIDE.md` 配置表 `execution` 行加 `circuitBreakerResetAt`；新增 `ai` 段说明（apiBase/model/apiKey+env）。

## 非目标

- 不要求 AI 答案正确性（「答了就算成功」）；不做答案缓存/学习。
- 不改熔断阈值逻辑（仍是连续失败计数 + 阈值判定），只加「每日重置」。
- 不引入多 AI provider 抽象（就一个 OpenAI 兼容客户端 + 配置）。

## 迁移计划（分阶段）

- **P1 AI 集成**：`integrations/ai` + `config.ai` + env 覆盖 + 单测。
- **P2 AI 对外函数**：`api/ai.ts`（`askAi`/`answerQuiz`）+ TaskContext.ai + window-runner/run-task 接线 + 单测。
- **P3 熔断重置**：`config.execution.circuitBreakerResetAt` + `db.resetMeltedCircuitBreakers` + `engine/maintenance.ts` + app 接线 + 单测。
- **P4 文档 + 回归**：AGENTS/API-GUIDE 同步；`typecheck`+`test`+`test:web`；真机抽验（用户）。

## 风险

- 推理模型延迟高（比 flash 慢）：`answerQuiz` 设超时（默认 30s），AI 慢不阻塞过久；`max_tokens` 需足够（默认 300）否则 content 空 → 触发兜底随机。
- 兜底随机可能答错——符合「答了就算成功」；若某站要求答对，任务侧可改用 `askAi` 自组逻辑或对该站 `answerQuiz` 加校验。
- 每日定时依赖进程常驻；进程停摆则当天不重置（下次启动自然重排，属可接受）。
- 密钥安全：仅 .env；泄露需轮换。
