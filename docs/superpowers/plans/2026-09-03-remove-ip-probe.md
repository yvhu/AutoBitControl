# 删除 IP 探活实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除窗口会话中的 IP 探活步骤（开窗→连接后直接跑任务），连 `execution.probeUrl` 配置与相关展示一起移除。

**Architecture:** 删除 `WindowRunner.probeWithRetry` 及其调用分支；配置层删 `ExecutionConfig.probeUrl`；settings API 与设置页删「探活 URL」；冒烟脚本改用固定地址验证 CDP 链路；测试与文档同步。窗口熔断兜底机制保留不变。

**Tech Stack:** TypeScript（严格模式）、vitest、React 18 + antd 5、patchright。验证命令：`npm run typecheck`（src/tests/scripts）、`npm test`、`npm run test:web`、`npm --prefix web exec tsc -b`。

**Spec:** `docs/superpowers/specs/2026-09-03-remove-ip-probe-design.md`

## Global Constraints

- 无分号、单引号、2 空格缩进、TS 严格模式；注释/commit 用中文
- commit 风格 conventional：`refactor:`/`chore:`/`docs:` + 中文描述
- `npm run typecheck` 与 `npm test` 必须全绿才算完成
- 历史 spec/plan 文档（`docs/superpowers/specs/`、`docs/superpowers/plans/` 下的旧文件）一律不改，只改 `AGENTS.md` 与 `docs/API-GUIDE.md`

---

### Task 1: 删除 window-runner 探活逻辑与探活测试

**Files:**
- Modify: `src/engine/window-runner.ts:1-8, 96-102, 129, 146-155, 215-229`
- Modify: `tests/windowRunner.test.ts:51, 217-223, 225-250, 252-270, 286`

**Interfaces:**
- Produces: `WindowRunner` 不再有 `probeWithRetry` 方法；`runWindowTasks` 会话流程变为「开窗→连接→逐个跑任务→关窗」，`settleWindowSkip`（窗口级 skipped/failed 落库）与窗口熔断、窗口超时路径不变

- [ ] **Step 1: 删除 window-runner.ts 中的探活实现**

`src/engine/window-runner.ts` 改 5 处：

1. 第 2 行文件头注释：

```
- * 窗口执行器（engine 层）：一次完整窗口会话的编排——开窗→连接→探活→逐个跑任务→关窗
+ * 窗口执行器（engine 层）：一次完整窗口会话的编排——开窗→连接→逐个跑任务→关窗
```

2. 第 96-102 行 `runWindowTasks` 方法注释：

```
-   * 异常分区（见文件头注释）：开窗失败全部 skipped；连接失败全部 failed；
-   * IP 探活失败全部 skipped；熔断中的任务逐个 skipped；其余逐任务执行
+   * 异常分区（见文件头注释）：开窗失败全部 skipped；连接失败全部 failed；
+   * 熔断中的任务逐个 skipped；其余逐任务执行
```

3. 第 129 行注释：

```
-    // 第二段 try：连接/探活/执行——finally 保证无论成败都关连接、关窗口
+    // 第二段 try：连接/执行——finally 保证无论成败都关连接、关窗口
```

4. 删除第 146-155 行整段（探活调用与失败分支）：

```
-      // IP 探活：代理 IP 未生效时整窗口跳过，避免用错误 IP 跑任务触发风控
-      const probeOk = await this.probeWithRetry(page)
-      if (!probeOk) {
-        for (const key of taskKeys) {
-          const row = await this.settleWindowSkip(profile, key, date, 'skipped', 'IP 探活失败')
-          results.set(key, row)
-        }
-        logger.warn({ profile: profile.name }, 'IP 探活失败，本轮跳过')
-        return results
-      }
```

5. 删除第 215-229 行 `probeWithRetry` 方法整块（含其文档注释）：

```
-  /**
-   * 访问探活地址校验 IP 生效：3 次尝试、每次 30s 超时、间隔 5s——
-   * S5 代理连接建立初期常失败，单次判定会把整窗口误跳过
-   */
-  async probeWithRetry(page: Page): Promise<boolean> {
-    for (let attempt = 1; attempt <= 3; attempt++) {
-      try {
-        await page.goto(this.deps.cfg.execution.probeUrl, { timeout: 30000, waitUntil: 'domcontentloaded' })
-        return true
-      } catch {
-        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000))
-      }
-    }
-    return false
-  }
-
```

注意：`Page` 类型仍被 `BrowserDriver` 接口与 `runTask` 签名使用，import 保留不动。

- [ ] **Step 2: 运行测试验证探活相关用例失败**

Run: `npm test`
Expected: 5 个用例 FAIL——「IP 探活失败熔断所有任务」（statuses 变为 running/success 而非 skipped）、「IP 探活前两次失败第三次成功仍算通过」与「IP 探活三次全失败返回 false」（`runner.probeWithRetry is not a function`）、「窗口级跳过结算待重试行：retry_wait 行沿用原 slot 落终态（不新开轮次）」与「窗口级跳过无待重试行时仍新开轮次」（原靠 page.goto 失败触发探活失败进 skipped，现任务成功）。其余用例 PASS。

- [ ] **Step 3: 更新 tests/windowRunner.test.ts**

1. 第 51 行 cfg fixture 删 probeUrl 字段：

```
-  execution: { probeUrl: 'https://probe.io', taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 60000 },
+  execution: { taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 60000 },
```

2. 删除第 217-223 行「IP 探活失败熔断所有任务」用例整块：

```
-  it('IP 探活失败熔断所有任务', async () => {
-    const db = makeDb()
-    const page = { ...okPage, goto: vi.fn().mockRejectedValue(new Error('网络错误')) }
-    const runner = makeRunner({ db, driver: makeDriver({ connect: vi.fn().mockResolvedValue({ page, close: vi.fn().mockResolvedValue(undefined) }) }) })
-    await runner.runWindowTasks(makeProfile(), ['ok-task'])
-    expect(statuses(db)).toEqual(['skipped'])
-  })
-
```

3. 将第 225-237 行「窗口级跳过结算待重试行」用例改为开窗失败路径（settleWindowSkip 的唯一其他整轮触发点）：

```ts
  it('窗口级跳过结算待重试行：retry_wait 行沿用原 slot 落终态（不新开轮次）', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'retry_wait', attempts: 1, slot: 3 } as Partial<RunRow>),
    })
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][3]).toBe(3) // 沿用 retry_wait 行的 slot，而非 nextRunSlot 新开轮
    expect(calls[0][4]).toBe('skipped')
    expect(db.nextRunSlot).not.toHaveBeenCalled()
  })
```

4. 将第 239-250 行「窗口级跳过无待重试行时仍新开轮次」用例同样改为开窗失败路径：

```ts
  it('窗口级跳过无待重试行时仍新开轮次（终态行为不变）', async () => {
    const db = makeDb({
      getLatestRun: vi.fn().mockResolvedValue({ status: 'success', attempts: 1, slot: 1 } as Partial<RunRow>),
      nextRunSlot: vi.fn().mockResolvedValue(2),
    })
    const bb = { ...bitbrowser, openBrowser: vi.fn().mockRejectedValue(new Error('开窗失败')) }
    const runner = new WindowRunner({ cfg, db, bitbrowser: bb as never, driver: makeDriver(), tasks: new Map([['ok-task', new OkTask()]]), wallets: null as never, captcha: null as never, logger, artifactsDir, walletPasswords, scheduleRetry })
    await runner.runWindowTasks(makeProfile(), ['ok-task'])
    const calls = (db.upsertRun as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][3]).toBe(2)
    expect(calls[0][4]).toBe('skipped')
  })
```

5. 删除第 252-270 行两个 probeWithRetry 用例整块：

```
-  it('IP 探活前两次失败第三次成功仍算通过', async () => {
-    const runner = makeRunner({})
-    let attempts = 0
-    const page = {
-      goto: vi.fn().mockImplementation(async () => {
-        attempts++
-        if (attempts < 3) throw new Error('SOCKS 失败')
-      }),
-    } as never
-    const ok = await runner.probeWithRetry(page)
-    expect(ok).toBe(true)
-    expect(attempts).toBe(3)
-  })
-
-  it('IP 探活三次全失败返回 false', async () => {
-    const runner = makeRunner({})
-    const page = { goto: vi.fn().mockRejectedValue(new Error('失败')) } as never
-    expect(await runner.probeWithRetry(page)).toBe(false)
-  })
-
```

6. 第 286 行 cfgZero fixture 删 probeUrl 字段：

```
-      execution: { probeUrl: 'https://probe.io', taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 0 },
+      execution: { taskTimeoutMs: 5000, retryMax: 2, retryBackoffSec: 0, circuitBreakerThreshold: 2, windowTimeoutMs: 0 },
```

- [ ] **Step 4: 运行测试验证全绿**

Run: `npm test`
Expected: 全部 PASS（含改写的两个开窗失败路径用例）。

- [ ] **Step 5: Commit**

```bash
git add src/engine/window-runner.ts tests/windowRunner.test.ts
git commit -m "refactor: 删除窗口会话 IP 探活步骤"
```

---

### Task 2: 删除 probeUrl 配置、settings API 字段与冒烟脚本引用

**Files:**
- Modify: `config/config.json:15`
- Modify: `src/infrastructure/config.ts:32, 110, 119-120`
- Modify: `src/server/routes/settings.ts:17, 51, 104`
- Modify: `scripts/smoke-open-window.ts:1-5, 24-25`
- Modify: `tests/config.test.ts:24, 32`
- Modify: `tests/web.test.ts:31, 70`

**Interfaces:**
- Consumes: Task 1 已移除 `cfg.execution.probeUrl` 的运行时使用
- Produces: `ExecutionConfig` 无 `probeUrl` 字段；`PublicSettings`（/api/settings 响应 data）无 `probeUrl` 字段；冒烟脚本打开 `https://example.com` 验证 CDP 连接

- [ ] **Step 1: 删除 config.json 与 config.ts 中的 probeUrl**

1. `config/config.json` 删第 15 行：

```
-    "probeUrl": "https://api.ipify.org",
```

2. `src/infrastructure/config.ts` 删 3 处：

第 32 行接口字段：

```
-  probeUrl: string
```

第 110 行默认值注释：

```
-    // 单窗口会话超时 15 分钟（开窗+探活+全部任务），防止异常卡死占用并发槽位
+    // 单窗口会话超时 15 分钟（开窗+全部任务），防止异常卡死占用并发槽位
```

第 119-120 行默认值：

```
-    // 开窗后的 IP 探活地址：校验代理 IP 已生效才跑任务，避免用错误 IP 触发风控
-    probeUrl: 'https://api.ipify.org',
```

- [ ] **Step 2: 运行 typecheck 确认引用点报错**

Run: `npm run typecheck`
Expected: 报错 `Property 'probeUrl' does not exist`——位置为 `src/server/routes/settings.ts:104`、`tests/config.test.ts:32` 与 `scripts/smoke-open-window.ts:25`（TS 静态检查暴露全部残留引用，作为删除清单）。

- [ ] **Step 3: 删除 settings.ts、smoke-open-window.ts、config.test.ts、web.test.ts 中的引用**

1. `src/server/routes/settings.ts` 删 3 处：

第 17 行接口字段：

```
-  probeUrl: string
```

第 51 行 swagger 注解：

```
-                     probeUrl: { type: string }
```

第 104 行返回值：

```
-      probeUrl: deps.cfg.execution.probeUrl,
```

2. `tests/config.test.ts` 删 2 处：

第 24 行 fixture：

```
-      execution: { concurrency: 3, probeUrl: 'https://base.example' },
+      execution: { concurrency: 3 },
```

第 32 行断言：

```
-    expect(cfg.execution.probeUrl).toBe('https://base.example')
```

3. `tests/web.test.ts` 删 2 处：

第 31 行 MockDeps 类型：

```
-    execution: { timezone: string; concurrency: number; circuitBreakerThreshold: number; probeUrl: string }
+    execution: { timezone: string; concurrency: number; circuitBreakerThreshold: number }
```

第 70 行 mock 数据：

```
-      execution: { timezone: 'Asia/Shanghai', concurrency: 6, circuitBreakerThreshold: 2, probeUrl: 'https://probe.io' },
+      execution: { timezone: 'Asia/Shanghai', concurrency: 6, circuitBreakerThreshold: 2 },
```

4. `scripts/smoke-open-window.ts` 改头注释与 goto 目标：

文件头：

```
- * 冒烟脚本（scripts）：开窗链路验证——开窗 → CDP 连接 → 打开探活页 → 关窗
+ * 冒烟脚本（scripts）：开窗链路验证——开窗 → CDP 连接 → 打开页面 → 关窗
  * 用法：BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window
- * 用途：部署后快速验证比特浏览器 API、patchright 驱动与代理 IP 是否可用
+ * 用途：部署后快速验证比特浏览器 API 与 patchright 驱动是否可用
```

第 24-25 行：

```
-    // 打开探活页（失败不中断：验证目的只是确认 CDP 连接可用）
-    await conn.page.goto(cfg.execution.probeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
+    // 打开一个轻量页面（失败不中断：验证目的只是确认 CDP 连接可用）
+    await conn.page.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => {})
```

- [ ] **Step 4: 运行 typecheck 与后端测试**

Run: `npm run typecheck` 与 `npm test`
Expected: typecheck 无错误；测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add config/config.json src/infrastructure/config.ts src/server/routes/settings.ts scripts/smoke-open-window.ts tests/config.test.ts tests/web.test.ts
git commit -m "refactor: 删除 execution.probeUrl 配置与 settings 字段"
```

---

### Task 3: 删除前端探活 URL 展示

**Files:**
- Modify: `web/src/api/schema.d.ts:247`
- Modify: `web/src/pages/settings/index.tsx:69`

**Interfaces:**
- Consumes: Task 2 已从 /api/settings 响应移除 `probeUrl`
- Produces: 设置页「执行参数」卡片只展示并发/时区/熔断阈值/版本；`EnvelopeData<'/api/settings'>` 无 probeUrl

- [ ] **Step 1: 删除 schema.d.ts 与设置页中的 probeUrl**

1. `web/src/api/schema.d.ts` 删第 247 行：

```
-                                probeUrl?: string;
```

2. `web/src/pages/settings/index.tsx` 删第 69 行（Descriptions items 中的探活项）：

```
-            { key: 'probe', label: '探活 URL', children: s.probeUrl },
```

- [ ] **Step 2: 运行前端类型检查与前端测试**

Run: `npm --prefix web exec tsc -b` 与 `npm run test:web`
Expected: 类型检查无错误；前端单测全部 PASS。

- [ ] **Step 3: Commit**

```bash
git add web/src/api/schema.d.ts web/src/pages/settings/index.tsx
git commit -m "refactor: 设置页删除探活 URL 展示"
```

---

### Task 4: 同步 queue.ts 与 portal-rhuna.ts 注释

**Files:**
- Modify: `src/engine/queue.ts:41`
- Modify: `src/tasks/portal-rhuna.ts:56`

**Interfaces:**
- Consumes: Task 1 已删除 IP 探活流程
- Produces: 相关注释不再提及 IP 探活

- [ ] **Step 1: 修改 queue.ts 与 portal-rhuna.ts 注释**

1. `src/engine/queue.ts` 第 41 行：

```
- * 目标：同一窗口的多个任务合并进一次开窗会话（开窗/连接/IP 探活只做一遍，关一次窗）
+ * 目标：同一窗口的多个任务合并进一次开窗会话（开窗/连接只做一遍，关一次窗）
```

2. `src/tasks/portal-rhuna.ts` 第 56 行 note 末尾：

```
- 登录态不跨浏览器重启（sessionStorage），每次新会话都走登录；个别窗口代理不稳 IP 探活会失败，属窗口环境问题',
+ 登录态不跨浏览器重启（sessionStorage），每次新会话都走登录；个别窗口代理不稳，属窗口环境问题',
```

- [ ] **Step 2: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/engine/queue.ts src/tasks/portal-rhuna.ts
git commit -m "chore: 同步 IP 探活相关注释"
```

---

### Task 5: 更新 AGENTS.md 与 API-GUIDE.md 文档

**Files:**
- Modify: `AGENTS.md:68`
- Modify: `docs/API-GUIDE.md:78, 144, 919, 934, 971, 983, 995, 1262, 1307`

**Interfaces:**
- 无代码接口；仅文档与代码现状保持一致

- [ ] **Step 1: 修改 AGENTS.md 第 68 行**

```
-- 开窗后先 IP 探活（execution.probeUrl）再跑任务；窗口连续 2 任务失败触发当日熔断
+- 窗口连续 2 任务失败触发当日熔断；代理失效由任务自身失败暴露（已无前置 IP 探活）
```

- [ ] **Step 2: 修改 API-GUIDE.md 9 处**

1. 第 78 行术语表：删整行

```
-| 探活 | Probe | 开窗后先访问一个探活地址，确认代理 IP 已生效再跑任务 |
```

2. 第 144 行冒烟说明：

```
-4. **开窗冒烟（部署后先跑这个）**：`BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window`——验证「开窗 → CDP 接管 → 打开探活页 → 关窗」整条链路（脚本：`scripts/smoke-open-window.ts`），一次确认比特浏览器 API、驱动与代理 IP 都可用。
+4. **开窗冒烟（部署后先跑这个）**：`BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window`——验证「开窗 → CDP 接管 → 打开页面 → 关窗」整条链路（脚本：`scripts/smoke-open-window.ts`），一次确认比特浏览器 API 与驱动可用。
```

3. 第 919 行 execution 参数表：

```
-| `execution` | `concurrency`、`windowTimeoutMs`、`probeUrl`、`timezone`、`taskTimeoutMs`、`retryMax`、`retryBackoffSec`、`circuitBreakerThreshold`、`humanize` | 执行引擎：窗口并发默认 6；单窗口会话超时默认 15 分钟（到点剩余任务标「窗口超时」跳过）；`probeUrl` 是开窗后的探活地址；`timezone` 是 cron 时区；`taskTimeoutMs`/`retryMax`/`retryBackoffSec` 是单任务超时与重试的全局默认（任务 meta 可逐个覆盖）；`circuitBreakerThreshold` 是窗口熔断阈值（连续失败达到即跳过剩余任务）；`humanize.minDelayMs`/`humanize.maxDelayMs` 是拟人动作的随机停顿区间（默认 800/3000 毫秒） |
+| `execution` | `concurrency`、`windowTimeoutMs`、`timezone`、`taskTimeoutMs`、`retryMax`、`retryBackoffSec`、`circuitBreakerThreshold`、`humanize` | 执行引擎：窗口并发默认 6；单窗口会话超时默认 15 分钟（到点剩余任务标「窗口超时」跳过）；`timezone` 是 cron 时区；`taskTimeoutMs`/`retryMax`/`retryBackoffSec` 是单任务超时与重试的全局默认（任务 meta 可逐个覆盖）；`circuitBreakerThreshold` 是窗口熔断阈值（连续失败达到即跳过剩余任务）；`humanize.minDelayMs`/`humanize.maxDelayMs` 是拟人动作的随机停顿区间（默认 800/3000 毫秒） |
```

4. 第 934 行设置页说明：

```
-- **设置页**：比特浏览器卡（API 地址 ＋「测试连接」按钮与结果 Tag）；执行参数 Descriptions 只读展示（并发/探活 URL/时区/熔断阈值/版本）；yescaptcha 卡（「查询余额」按钮展示剩余点数）；数据源卡（账号表加载状态：路径 ＋ N 行 + 列名，不可用时 Alert 报错，改完 xlsx 点「重载」即时生效，无需重启）；主题卡（三态 Segmented，与顶栏一致）。
+- **设置页**：比特浏览器卡（API 地址 ＋「测试连接」按钮与结果 Tag）；执行参数 Descriptions 只读展示（并发/时区/熔断阈值/版本）；yescaptcha 卡（「查询余额」按钮展示剩余点数）；数据源卡（账号表加载状态：路径 ＋ N 行 + 列名，不可用时 Alert 报错，改完 xlsx 点「重载」即时生效，无需重启）；主题卡（三态 Segmented，与顶栏一致）。
```

5. 第 971 行状态流转图：

```
-   │ 窗口轮到这个任务：开窗 → CDP 接管 → 探活通过
+   │ 窗口轮到这个任务：开窗 → CDP 接管
```

6. 第 983 行 skipped 支线：

```
-另外还有一条「没开跑就结束」的支线——`skipped`（跳过）不经过 `running`，直接终态：**开窗失败 / IP 探活失败**（整轮任务全部跳过）、**窗口熔断 / 窗口超时**（剩余任务逐个跳过）。skipped 行里会记具体原因，面板上点开就能看到。
+另外还有一条「没开跑就结束」的支线——`skipped`（跳过）不经过 `running`，直接终态：**开窗失败**（整轮任务全部跳过）、**窗口熔断 / 窗口超时**（剩余任务逐个跳过）。skipped 行里会记具体原因，面板上点开就能看到。
```

7. 第 995 行状态表：

```
-| `skipped` | 跳过：根本没跑就终态，原因记在行内 | 开窗失败/IP 探活失败/窗口熔断/窗口超时 | 灰色「跳过」 |
+| `skipped` | 跳过：根本没跑就终态，原因记在行内 | 开窗失败/窗口熔断/窗口超时 | 灰色「跳过」 |
```

8. 第 1262 行排错表：删整行

```
-| `IP 探活失败` | 代理 IP 没生效，整轮任务全跳过 | 代理过期/未配置；探活地址（`execution.probeUrl`）访问失败（30 秒超时） | 检查窗口代理配置；看日志确认网络；核对探活地址 |
```

9. 第 1307 行状态速查：

```
-- **运行状态速查**：`pending → running → success | failed | captcha_failed | retry_wait → …`，`skipped` 表示开窗失败/探活失败/窗口超时/熔断跳过。各状态含义、进入条件与面板颜色见[第 9 章「任务的一生（状态流转）」](#任务的一生状态流转)。
+- **运行状态速查**：`pending → running → success | failed | captcha_failed | retry_wait → …`，`skipped` 表示开窗失败/窗口超时/熔断跳过。各状态含义、进入条件与面板颜色见[第 9 章「任务的一生（状态流转）」](#任务的一生状态流转)。
```

- [ ] **Step 3: 全文复查无残留**

Run: `rg -n "IP 探活|探活页|probeUrl" AGENTS.md docs/API-GUIDE.md src tests config web scripts`（工作目录 D:\StudySpace\AutoBitControl）
Expected: 除 `docs/superpowers/` 下历史 spec/plan 文档外无其他匹配（历史文档按 Global Constraints 不改）。

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/API-GUIDE.md
git commit -m "docs: 移除 IP 探活相关文档描述"
```

---

## 完成验收

全部任务完成后运行：

```
npm run typecheck && npm test && npm run test:web
```

预期：全部通过。可选真机冒烟：`BITBROWSER_PROFILE_ID=<窗口ID> npm run smoke:window`（需真实比特浏览器环境）。
