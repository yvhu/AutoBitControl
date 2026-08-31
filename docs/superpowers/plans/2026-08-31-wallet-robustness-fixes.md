# 钱包弹窗与运行健壮性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复生产全量运行暴露的 5 类问题：MetaMask 弹窗解锁竞态（主因）、流程超时偏短、IP 探活无重试、面板状态不同步、sourceUrl 单地址限制；附带 Enter Inception 刷新加强。

**Architecture:** 钱包适配器从「单次 count 判断」改为「轮询三态等待」（解锁框/连接按钮/弹窗关闭），成功判定不依赖 close 事件（事件不可靠时用「先存在后消失」）；waitForPopup 扫描浏览器全部 context；探活加重试；面板测试连接后失效状态查询；sourceUrl 支持数组。

**Tech Stack:** TypeScript / patchright / vitest / React Query / antd

## Global Constraints

- Node 20.x；后端 `npm test` + `npm run typecheck` 全绿；前端 `npm --prefix web run test` + `npm --prefix web run build` 全绿
- 代码注释一律中文，风格跟随现有文件（JSDoc + 设计思路说明）
- 不新增依赖
- 不要动 config/config.json（用户本地修改）；不要动「暂停/停止」相关功能（用户明确排除）
- 提交信息 conventional commits

---

### Task A: MetaMask 适配器轮询三态重做（解锁竞态主因）

**Files:**
- Modify: `src/automation/wallet/types.ts`（PopupPage 加可选 `isClosed?(): boolean`）
- Modify: `src/automation/wallet/metamask.ts`（unlock/ensureConnected 重写）
- Test: `tests/wallet.test.ts`（适配新行为）、`tests/login-by-wallet.test.ts`（mock 补 isClosed）

**Interfaces:**
- Consumes: PopupLocator.count?/waitFor?（已有，Task 2 时代加入）
- Produces:
  - `unlock(popup, password)`：轮询 20s 等三态——unlock-password 出现 → 填密码提交、等 unlock-page detached；confirm-btn 出现 → 已解锁直接返回；弹窗关闭 → 返回。20s 无任何状态 → 抛 `MetaMask 弹窗状态未出现（解锁框/连接确认 20s 均未渲染）`
  - `ensureConnected(popup)`：每轮先等确认按钮出现（testid 候选 → 角色名回退，10s 轮询，500ms 步进），点到后成功判定 = close 事件 **或** connect-page「先存在后消失」（detached 对从未出现的元素立即成功，必须 count>0 确认过才用）；最多 3 轮；失败抛 `MetaMask 连接确认未完成（弹窗未关闭）`

- [ ] **Step 1: 写失败测试**

`tests/wallet.test.ts` makeLocator/makePopup 补 `isClosed: () => false` 与可控 `count` 序列，新增/改写用例：

```ts
describe('MetaMaskAdapter 解锁轮询', () => {
  it('解锁框延迟渲染：轮询等到出现后解锁成功', async () => {
    const adapter = new MetaMaskAdapter()
    const filled: string[] = []
    let renders = 0
    const popup = makePopup({
      getByTestId: (id: string) => {
        if (id === 'unlock-password') {
          // 前 5 次轮询未渲染（count=0），之后出现
          return makeLocator({
            count: async () => { renders++; return renders > 5 ? 1 : 0 },
            fill: async (t: string) => { filled.push(t) },
          })
        }
        if (id === 'unlock-page') return makeLocator({ waitFor: async () => {} })
        return makeLocator({ count: async () => 0 })
      },
    })
    await adapter.unlock!(popup, 'secret123')
    expect(filled).toEqual(['secret123'])
  })

  it('弹窗直接是连接确认页（已解锁）：等 confirm-btn 出现后跳过解锁', async () => {
    const adapter = new MetaMaskAdapter()
    let renders = 0
    const popup = makePopup({
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ count: async () => { renders++; return renders > 3 ? 1 : 0 } })
        : makeLocator({ count: async () => 0 }),
    })
    await adapter.unlock!(popup, 'secret123')
  })

  it('20s 无任何状态抛错', async () => {
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({ getByTestId: () => makeLocator({ count: async () => 0 }) })
    await expect(adapter.unlock!(popup, 'secret123')).rejects.toThrow(/弹窗状态未出现/)
  })
})

describe('MetaMaskAdapter 连接确认', () => {
  it('确认按钮延迟渲染：等到出现点击，弹窗关闭即成功', async () => {
    const adapter = new MetaMaskAdapter()
    let clicks = 0
    let renders = 0
    const popup = makePopup({
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ count: async () => { renders++; return renders > 2 ? 1 : 0 }, click: async () => { clicks++ } })
        : makeLocator({ count: async () => 0 }),
      waitForEvent: async () => {},
    })
    await adapter.ensureConnected(popup)
    expect(clicks).toBe(1)
  })

  it('close 事件不来但连接页消失也判成功（先存在后消失）', async () => {
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({
      getByTestId: (id: string) => id === 'confirm-btn'
        ? makeLocator({ count: async () => 1, click: async () => {} })
        : makeLocator({ count: async () => (id === 'connect-page' ? 1 : 0), waitFor: async () => {} }),
      waitForEvent: async () => { throw new Error('close 事件永不触发') },
    })
    await adapter.ensureConnected(popup)
  })

  it('3 轮无确认按钮抛错', async () => {
    const adapter = new MetaMaskAdapter()
    const popup = makePopup({ getByTestId: () => makeLocator({ count: async () => 0 }) })
    await expect(adapter.ensureConnected(popup)).rejects.toThrow(/连接确认未完成/)
  })
})
```

（旧用例中依赖「getByTestId 全返回可点 locator」的 unlock 用例改为上述轮询语义；ensureConnected 旧重试用例保留但按新语义调整——以最终文件为准，保持行为断言正确）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/wallet.test.ts`
Expected: 新用例 FAIL（当前实现单次 count 即判已解锁）

- [ ] **Step 3: 改 types.ts**

```ts
export interface PopupPage {
  url(): string
  getByRole(role: string, opts: { name: RegExp }): PopupLocator
  getByTestId(id: string): PopupLocator
  locator(selector: string): PopupLocator
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<void>
  /** 弹窗页是否已关闭（真实 Page.isClosed；mock 可不提供） */
  isClosed?(): boolean
}
```

- [ ] **Step 4: 重写 metamask.ts**

```ts
import type { WalletAdapter, PopupPage } from './types'

/** 连接确认按钮 testid 候选（多版本兼容，与 UI 语言无关） */
const CONFIRM_TESTIDS = ['confirm-btn', 'confirm-footer-button', 'permissions-connect-button', 'signature-request-sign-button']

/** 确认按钮角色名回退（英文/中文双覆盖） */
const CONFIRM_ROLE = /connect|next|confirm|approve|sign|unlock|连接|确认|签名|下一步|批准|登录/i

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class MetaMaskAdapter implements WalletAdapter {
  key = 'metamask'
  extensionUrlPatterns = ['chrome-extension://.*/home.html', 'chrome-extension://.*/notification.html', 'metamask://']

  /**
   * 解锁：弹窗 UI 渲染有延迟（尤其多窗口并发时），不能单次 count 判「已解锁」——
   * 轮询 20s 等三态：解锁框出现 → 填密码提交、等解锁页消失；连接按钮出现 → 已解锁直接返回；弹窗关闭 → 返回
   * @throws 20s 无任何状态（解锁框/连接确认均未渲染）
   */
  async unlock(popup: PopupPage, password: string): Promise<void> {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return
      const pw = popup.getByTestId('unlock-password').first()
      try {
        if (pw.count && (await pw.count()) > 0) {
          await pw.fill(password)
          await popup.getByTestId('unlock-submit').first().click()
          // 等解锁页消失（waitFor detached 对从未出现的元素立即成功——解锁框已确认存在，此判定安全）
          try {
            await popup.getByTestId('unlock-page').first().waitFor({ state: 'detached', timeout: 15000 })
          } catch {
            throw new Error('MetaMask 解锁失败（密码错误或解锁页未离开）')
          }
          return
        }
        const confirm = popup.getByTestId('confirm-btn').first()
        if (confirm.count && (await confirm.count()) > 0) return
      } catch {
        if (popup.isClosed?.()) return
      }
      await sleep(500)
    }
    throw new Error('MetaMask 弹窗状态未出现（解锁框/连接确认 20s 均未渲染）')
  }

  /**
   * 连接确认：先等确认按钮渲染（testid 候选 → 角色名回退），点击后成功判定 =
   * 弹窗 close 事件 或 连接页「先存在后消失」（比特浏览器后台/最小化时 close 事件不可靠）；
   * 最多 3 轮（覆盖连接 → 签名等多步授权）
   * @throws 3 轮后仍未完成
   */
  async ensureConnected(popup: PopupPage): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const btn = await this.waitConfirmBtn(popup, 10000)
      if (!btn) break
      await btn.click()
      const closed = await popup.waitForEvent('close', { timeout: 6000 }).then(() => true).catch(() => false)
      if (closed) return
      // close 事件没来：连接页若已消失（先确认过存在）同样视为完成
      try {
        await popup.getByTestId('connect-page').first().waitFor({ state: 'detached', timeout: 6000 })
        return
      } catch {
        // 连接页仍在（可能进入下一步确认），继续下一轮
      }
    }
    throw new Error('MetaMask 连接确认未完成（弹窗未关闭）')
  }

  /** 轮询等确认按钮出现（testid 候选优先，角色名兜底；弹窗关闭或超时返回 null） */
  private async waitConfirmBtn(popup: PopupPage, timeoutMs: number): Promise<ReturnType<PopupPage['getByTestId']> | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (popup.isClosed?.()) return null
      try {
        for (const tid of CONFIRM_TESTIDS) {
          const loc = popup.getByTestId(tid).first()
          if (loc.count && (await loc.count()) > 0) return loc
        }
        const role = popup.getByRole('button', { name: CONFIRM_ROLE }).first()
        if (role.count && (await role.count()) > 0) return role
      } catch {
        if (popup.isClosed?.()) return null
      }
      await sleep(500)
    }
    return null
  }
}
```

- [ ] **Step 5: 适配 login-by-wallet.test.ts**

makePopup 补 `isClosed: () => false`（现有 unlock 用例断言「填密码即成功」在新轮询语义下仍成立：unlock-password count 返回 1 立即走解锁分支）

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/wallet.test.ts tests/login-by-wallet.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/automation/wallet/types.ts src/automation/wallet/metamask.ts tests/wallet.test.ts tests/login-by-wallet.test.ts
git commit -m "fix: MetaMask unlock/connect polling for slow popup render and unreliable close events"
```

---

### Task B: 流程超时放宽 + Enter Inception 刷新加强

**Files:**
- Modify: `src/automation/wallet/popup.ts`（waitForPopup 扫描全部 context）
- Modify: `src/engine/task-context.ts`（loginByWallet 传 30000）
- Modify: `src/tasks/inception-dachain.ts`（断言放宽、刷新 10 次/10s、timeoutSec 900）
- Test: `tests/wallet.test.ts`（waitForPopup 多 context 用例）、`tests/login-by-wallet.test.ts`（断言 30000 传入）

**Interfaces:**
- Consumes: 无新依赖
- Produces: waitForPopup 保持签名 `(context, patterns, timeoutMs)`，内部经 `context.browser()` 扫全部 context 的 pages

- [ ] **Step 1: 写失败测试**

`tests/wallet.test.ts` waitForPopup describe 追加：

```ts
  it('弹窗开在其它 browser context 也能被发现', async () => {
    const popupPage = { url: () => 'chrome-extension://abc/notification.html' }
    let handler: ((p: unknown) => void) | null = null
    const otherCtx = {
      pages: () => [popupPage],
      on: () => {},
      off: () => {},
    }
    const context = {
      pages: () => [] as Array<{ url(): string }>,
      on: (event: string, fn: (p: unknown) => void) => { if (event === 'page') handler = fn },
      off: () => {},
      browser: () => ({ contexts: () => [context, otherCtx] }),
    } as never
    const popup = await waitForPopup(context, ['chrome-extension://.*/notification.html'], 2000)
    expect(popup).not.toBeNull()
  })
```

`tests/login-by-wallet.test.ts` 现有「密码按钱包类型取用」用例的 waitForPopup mock 断言加：第二个用例验证调用参数 timeoutMs 为 30000：

```ts
  it('钱包弹窗等待 30s 且扫描全部 context', async () => {
    vi.mocked(waitForPopup).mockResolvedValue(makePopup({ url: () => 'chrome-extension://abc/home.html' }) as never)
    const ctx = makeCtx({ metamask: 'pw' })
    await ctx.loginByWallet()
    expect(vi.mocked(waitForPopup).mock.calls[0][2]).toBe(30000)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/wallet.test.ts tests/login-by-wallet.test.ts`
Expected: 新用例 FAIL（当前实现只扫单 context；loginByWallet 传 15000）

- [ ] **Step 3: 改 popup.ts**

```ts
/**
 * 等待钱包弹窗出现（扫描浏览器全部 context——比特浏览器部分弹窗开在别的 context）
 * 先查已打开的页面，再同时用事件监听 + 100ms 轮询兜底；超时返回 null
 */
export async function waitForPopup(context: BrowserContext, patterns: string[], timeoutMs: number): Promise<Page | null> {
  const find = (): Page | undefined => {
    const browser = context.browser()
    const contexts = browser ? browser.contexts() : [context]
    for (const c of contexts) {
      for (const p of c.pages()) {
        if (matchesWalletUrl(p.url(), patterns)) return p
      }
    }
    return undefined
  }
  const existing = find()
  if (existing) return existing
  return new Promise(resolve => {
    // ……事件监听与轮询逻辑不变，find 换成上面的全 context 版本
  })
}
```

（保留 settled 防重复 resolve 与 100ms 轮询实现，仅替换 find 与新增 browser 兜底——`context.browser()` 可能为 null（独立 context），null 时回退 [context]）

- [ ] **Step 4: 改 task-context.ts loginByWallet**

```ts
    const popup = (await waitForPopup(this.page.context(), adapter.extensionUrlPatterns, 30000)) as PopupPage | null
```

- [ ] **Step 5: 改 inception-dachain.ts**

- `assertTimeoutMs` Get Started：15000 → 30000
- wallet-selector 断言 15000 → 30000，点击后加一次重试（若 10s 内入口仍不可见则再点 WALLET 重进）
- 刷新循环：`for (let i = 0; i < 6; i++)` → `for (let i = 0; i < 10; i++)`，`waitForTimeout(4000)` → `waitForTimeout(10000)`，错误文案同步改「多次刷新后仍未出现 Enter Inception（网络异常）」（不变）
- `timeoutSec: 600` → `timeoutSec: 900`

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/wallet.test.ts tests/login-by-wallet.test.ts`；再 `npm run typecheck`
Expected: PASS + typecheck 干净

- [ ] **Step 7: 提交**

```bash
git add src/automation/wallet/popup.ts src/engine/task-context.ts src/tasks/inception-dachain.ts tests/wallet.test.ts tests/login-by-wallet.test.ts
git commit -m "fix: longer wallet-flow waits, all-context popup scan, 10x Enter Inception refresh"
```

---

### Task C: IP 探活重试

**Files:**
- Modify: `src/engine/window-runner.ts`（probe 方法）
- Test: `tests/windowRunner.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: probe 语义变为「3 次尝试、每次 30s 超时、间隔 5s，任一成功即 true」

- [ ] **Step 1: 写失败测试**

`tests/windowRunner.test.ts` 追加：

```ts
  it('IP 探活前两次失败第三次成功仍算通过', async () => {
    const deps = makeDeps()
    const runner = new WindowRunner(deps as never)
    let attempts = 0
    const page = {
      goto: vi.fn().mockImplementation(async () => {
        attempts++
        if (attempts < 3) throw new Error('SOCKS 失败')
      }),
    } as never
    const ok = await runner.probeForTest(page)
    expect(ok).toBe(true)
    expect(attempts).toBe(3)
  })

  it('IP 探活三次全失败返回 false', async () => {
    const deps = makeDeps()
    const runner = new WindowRunner(deps as never)
    const page = { goto: vi.fn().mockRejectedValue(new Error('失败')) } as never
    expect(await runner.probeForTest(page)).toBe(false)
  })
```

（probe 为 private——改为 public 方法 `probeForTest` 或暴露为 public `probe`；以最终文件为准，测试通过 WindowRunner 实例调用）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/windowRunner.test.ts`
Expected: 新用例 FAIL（probeForTest 不存在）

- [ ] **Step 3: 改 window-runner.ts probe**

```ts
  /**
   * 访问探活地址校验 IP 生效：3 次尝试、每次 30s 超时、间隔 5s——
   * S5 代理连接建立初期常失败，单次判定会把整窗口误跳过
   */
  async probeForTest(page: Page): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(this.deps.cfg.execution.probeUrl, { timeout: 30000, waitUntil: 'domcontentloaded' })
        return true
      } catch {
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5000))
      }
    }
    return false
  }
```

调用处 `const probeOk = await this.probe(page)` 改为 `await this.probeForTest(page)`（方法名以实现为准，保持一处调用点同步）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/windowRunner.test.ts`；再 `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/engine/window-runner.ts tests/windowRunner.test.ts
git commit -m "fix: retry IP probe 3 times before skipping a window session"
```

---

### Task D: 面板测试连接状态同步

**Files:**
- Modify: `web/src/pages/settings/hooks.ts`（useTestBitbrowser）
- Test: `web/src/pages/settings/hooks.test.ts`（存在则扩展，不存在则新建——按现有测试结构）

**Interfaces:**
- Consumes: 无
- Produces: 测试连接成功后失效 `['bitbrowser-status']` 查询

- [ ] **Step 1: 写失败测试**

`web/src/pages/settings/hooks.test.ts`（若不存在，仿 `web/src/pages/tasks/hooks.test.ts` 结构新建，用 @testing-library/react 的 renderHook + QueryClientProvider）：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { useTestBitbrowser } from './hooks'

vi.mock('../../api/endpoints', () => ({ testBitbrowser: vi.fn().mockResolvedValue({ ok: true }) }))

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <App>
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    </App>
  )
}

describe('useTestBitbrowser', () => {
  it('成功后失效顶栏 bitbrowser-status 查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useTestBitbrowser(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate()
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bitbrowser-status'] }))
  })
})
```

（antd App/message mock 细节以现有测试文件惯例为准，必要时 vi.mock('antd') 的 message）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix web run test`
Expected: 新用例 FAIL（无 invalidation）

- [ ] **Step 3: 改 hooks.ts**

```ts
export function useTestBitbrowser() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => testBitbrowser(),
    onSuccess: (res) => {
      // 同步顶栏状态：测试连接结果要立刻反映到布局栏的「比特浏览器已连接/未连接」
      queryClient.invalidateQueries({ queryKey: ['bitbrowser-status'] })
      if (res.ok) message.success('比特浏览器已连接')
      else message.warning('比特浏览器连接失败')
    },
    onError: (e) => message.error(errMsg(e)),
  })
}
```

（import 补 `useQueryClient`）

- [ ] **Step 4: 跑测试确认通过**

Run: `npm --prefix web run test`；再 `npm --prefix web run build`
Expected: PASS + build 成功

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/settings/hooks.ts web/src/pages/settings/hooks.test.ts
git commit -m "fix: invalidate header bitbrowser status after connection test"
```

---

### Task E: sourceUrl 支持多个地址

**Files:**
- Modify: `src/engine/task.ts`（sourceUrl 类型）
- Modify: `src/server/routes/tasks.ts`（swagger 注解）
- Modify: `web/src/api/schema.d.ts`（手改类型）
- Modify: `web/src/pages/tasks/index.tsx`（渲染多个链接）
- Modify: `docs/API-GUIDE.md`（TaskMeta 表格）
- Test: 现有 web.test.ts 的 tasks 序列化若断言 sourceUrl 为字符串需适配（数组同构透传）

**Interfaces:**
- Consumes: 无
- Produces: `TaskMeta.sourceUrl?: string | string[]`；面板任务卡渲染全部来源页链接

- [ ] **Step 1: 改 engine/task.ts**

```ts
  /** 信息来源页：选择器是从哪个页面确认的，站点改版时回这里重查；可多个（多个页面分别核实不同步骤） */
  sourceUrl?: string | string[]
```

- [ ] **Step 2: 改 server 注解与序列化**

`src/server/routes/tasks.ts` sourceUrl 注解：

```
 *                       sourceUrl: { type: string, nullable: true, description: '信息来源页（string 或 string[]，多个页面分别核实不同步骤）' }
```

序列化 `sourceUrl: m.sourceUrl ?? null` 不变（数组直接透传）。

- [ ] **Step 3: 改 web 面板渲染**

`web/src/pages/tasks/index.tsx`：

```tsx
          {task.sourceUrl && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              {(Array.isArray(task.sourceUrl) ? task.sourceUrl : [task.sourceUrl]).map((u, i) => (
                <Typography.Link key={u} href={u} target="_blank" rel="noreferrer">
                  🔗 来源页{i > 0 ? i + 1 : ''}
                </Typography.Link>
              ))}
            </div>
          )}
```

（多个链接间用 Space size=small 包一层或直接并排，视觉自定；保持 🔗 前缀）

- [ ] **Step 4: 改 schema.d.ts 与文档**

`web/src/api/schema.d.ts` sourceUrl 类型改：

```ts
sourceUrl?: (string | string[]) | null;
```

`docs/API-GUIDE.md` TaskMeta 表格 sourceUrl 行：

```markdown
| `sourceUrl` | `string \| string[]` | `undefined` | 信息来源页：选择器从哪个页面确认的，站点改版时回这里重查；多步骤分别核实时可给多个地址 |
```

- [ ] **Step 5: 验证**

Run: `npm run typecheck` + `npm test` + `npm --prefix web run build`
Expected: 全绿（schema.d.ts 手改后前端类型推导通过）

- [ ] **Step 6: 提交**

```bash
git add src/engine/task.ts src/server/routes/tasks.ts web/src/api/schema.d.ts web/src/pages/tasks/index.tsx docs/API-GUIDE.md
git commit -m "feat: sourceUrl supports multiple source pages"
```

---

## 最终验证（所有任务完成后，controller 执行）

1. `npm run typecheck` + `npm test` + `npm --prefix web run test` + `npm --prefix web run build` 全绿
2. 真机复跑：用 `scripts/diag-popup.ts`（诊断脚本，跑完即删）在钱包仍锁定的窗口验证：解锁轮询 → 连接确认 → 站点左侧目录出现
3. 清理临时脚本 `scripts/db-inspect.ts`、`scripts/diag-popup.ts`（若已建）
4. 台账追加记录
