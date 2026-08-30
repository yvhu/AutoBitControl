# AutoBitControl 前端 antd 重做 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 React 18 + antd 5 + Vite 重做面板前端：双主题默认跟随系统、5 页面组件化、文档页完整能力保留、一条命令前后端同启、生产构建后端单进程托管。

**Architecture:** `web/` 独立 Vite 工程；dev 由 concurrently 同启后端(3000)+Vite(5173 代理 /api)；生产 `vite build` → `web/dist` 由后端静态托管。数据层 @tanstack/react-query + 类型化 API 层（复用现有 REST envelope）。文档页 = react-markdown + antd Tree + react-syntax-highlighter。

**Tech Stack:** React 18、TypeScript、Vite 5、antd 5、@tanstack/react-query、react-router 6、react-markdown、remark-gfm、react-syntax-highlighter、concurrently、vitest + @testing-library/react + jsdom（前端单测）。

**Spec:** `docs/superpowers/specs/2026-08-30-antd-frontend-rebuild-design.md`

## Global Constraints

- 仓库 `D:\StudySpace\AutoBitControl`，分支 develop，Windows，PowerShell 5.1
- 无 ESLint；代码规范靠约定：页面目录 `index.tsx` 入口 + `hooks.ts` 查询 hooks；Props 显式 interface；API 函数名 `fetchXxx`/`mutateXxx`；错误统一 antd message
- 后端 REST 接口一律不动（除 Task 7 静态托管调整）；后端 164 测试必须持续全绿
- 面板能力不丢失：对照 spec 第 3 节表格逐项实现
- 主题三态 `light|dark|system`，默认 system，localStorage 持久化；文档页配色随主题
- 每任务结束：后端 `npm test` 全绿 + `npm run build:web` 成功（Task 1 建立后）+ 提交
- 中文 UI 文案

## 前端目录（最终形态）

```
web/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── src/
    ├── main.tsx
    ├── api/client.ts
    ├── api/endpoints.ts
    ├── theme/useThemeMode.ts
    ├── theme/antdTheme.ts
    ├── types.ts
    ├── layouts/AppLayout.tsx
    ├── components/StatusPill.tsx
    ├── pages/dashboard/{index.tsx,hooks.ts}
    ├── pages/profiles/{index.tsx,hooks.ts}
    ├── pages/tasks/{index.tsx,hooks.ts}
    ├── pages/docs/{index.tsx,markdown.tsx,slug.ts,useDocTree.ts}
    └── pages/settings/{index.tsx,hooks.ts}
```

---

### Task 1: 脚手架 + 主题系统 + 布局骨架 + 联调

**Files:** web/ 全部基建 + src/theme/* + src/layouts/AppLayout.tsx + src/main.tsx + src/types.ts；根 package.json scripts 增 dev:web/build:web

**Interfaces:**
- Produces: `useThemeMode(): { mode, effective, setMode }`；`antdTheme(effective)`；`AppLayout`（Sider 5 导航 + Header：主题 Segmented + 连接/余额 chip 占位 + Outlet）；`types.ts` 领域类型（与后端 JSON 一致，Task 2-6 依赖）；`npm run dev` 同启前后端

- [ ] **Step 1: 初始化 web 工程**

```powershell
npm create vite@latest web -- --template react-ts
cd web
npm i antd @tanstack/react-query react-router-dom react-markdown remark-gfm react-syntax-highlighter @types/react-syntax-highlighter
npm i -D vitest @testing-library/react @testing-library/jest-dom jsdom concurrently
```

- [ ] **Step 2: vite.config.ts（代理 /api）**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/screenshots': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
})
```

- [ ] **Step 3: 根 package.json 联调脚本**

```json
"dev": "concurrently -k \"npm:dev:server\" \"npm:dev:web\"",
"dev:server": "tsx src/index.ts",
"dev:web": "npm --prefix web run dev",
"build:web": "npm --prefix web run build",
"test:web": "npm --prefix web run test"
```

- [ ] **Step 4: web/src/types.ts（后端领域类型，逐字段对照后端 JSON）**

```ts
export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'captcha_failed' | 'retry_wait' | 'skipped'

export interface ProfileRow {
  id: number
  bitbrowserId: string
  name: string
  enabled: number
  circuitBreakerCount: number
}

export interface RunRow {
  id: number
  profileId: number
  taskKey: string
  date: string
  status: RunStatus
  attempts: number
  error: string | null
  screenshot: string | null
  startedAt: string | null
  finishedAt: string | null
  profileName: string
}

export interface TaskMetaView {
  key: string
  name: string
  url: string
  sourceUrl: string | null
  note: string | null
  category: 'checkin' | 'faucet' | 'mint' | 'other' | null
  lastUpdated: string | null
  deprecated: boolean
  enabled: boolean
  wallet: string | null
  schedule: string | { stagger: [string, string] } | null
  timeoutSec: number | null
  retry: { max: number; backoffSec: number } | null
  captcha: { auto?: boolean; maxCost?: number } | null
}

export interface DashboardData {
  date: string
  stats: { total: number; success: number; failed: number; captchaFailed: number; skipped: number; running: number; pending: number }
  runs: RunRow[]
  profiles: ProfileRow[]
  captcha: { count: number; totalCost: number }
  profilesTotal: number
  profilesEnabled: number
}

export interface PublicSettings {
  bitbrowserApiBase: string
  webPort: number
  timezone: string
  concurrency: number
  circuitBreakerThreshold: number
  probeUrl: string
  version: string
}

export interface DatasourceInfo {
  available: boolean
  error: string
  path: string
  rows: number
  columns: string[]
}

export interface SettingsData extends PublicSettings {
  datasource: DatasourceInfo
}
```

- [ ] **Step 5: 主题 hook（先写测试）**

`web/src/theme/useThemeMode.test.ts`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useThemeMode } from './useThemeMode'

describe('useThemeMode', () => {
  it('缺省为 system', () => {
    const { result } = renderHook(() => useThemeMode())
    expect(result.current.mode).toBe('system')
  })

  it('localStorage 持久化选择', () => {
    localStorage.setItem('abc-theme', 'dark')
    const { result } = renderHook(() => useThemeMode())
    expect(result.current.mode).toBe('dark')
  })

  it('setMode 写入 localStorage', () => {
    const { result } = renderHook(() => useThemeMode())
    act(() => result.current.setMode('light'))
    expect(localStorage.getItem('abc-theme')).toBe('light')
  })

  it('system 态跟随 prefers-color-scheme', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((q: string) => ({
        matches: q.includes('dark'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      })),
    })
    const { result } = renderHook(() => useThemeMode())
    expect(result.current.effective).toBe('dark')
  })
})
```

`web/src/theme/useThemeMode.ts`：

```ts
import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

const KEY = 'abc-theme'

function systemDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode>(() => (localStorage.getItem(KEY) as ThemeMode) || 'system')
  const [system, setSystem] = useState<boolean>(() => systemDark())

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m)
    localStorage.setItem(KEY, m)
  }, [])

  return { mode, setMode, effective: mode === 'system' ? (system ? 'dark' : 'light') : mode }
}
```

- [ ] **Step 6: antdTheme + main.tsx + AppLayout**

`web/src/theme/antdTheme.ts`：

```ts
import { theme as antdTheme } from 'antd'

export function antdTheme(effective: 'light' | 'dark') {
  return {
    algorithm: effective === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: { colorPrimary: '#1677FF' },
  }
}
```

`web/src/main.tsx`：

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
```

（App.tsx：useThemeMode → ConfigProvider theme={antdTheme(effective)} locale=zhCN → AntApp（message 上下文）→ Routes：/ → AppLayout 内嵌套 5 路由，占位页面。具体结构：

`web/src/App.tsx`：

```tsx
import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { Route, Routes } from 'react-router-dom'
import { useThemeMode } from './theme/useThemeMode'
import { antdTheme } from './theme/antdTheme'
import AppLayout from './layouts/AppLayout'
import DashboardPage from './pages/dashboard'
import ProfilesPage from './pages/profiles'
import TasksPage from './pages/tasks'
import DocsPage from './pages/docs'
import SettingsPage from './pages/settings'

export default function App() {
  const { effective } = useThemeMode()
  return (
    <ConfigProvider theme={antdTheme(effective)} locale={zhCN}>
      <AntApp>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="docs" element={<DocsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AntApp>
    </ConfigProvider>
  )
}
```

`web/src/layouts/AppLayout.tsx`：Layout+Sider（Menu 5 项：看板/窗口/任务/文档/设置，图标用 antd icons DashboardOutlined/DesktopOutlined/UnorderedListOutlined/ReadOutlined/SettingOutlined，选中随路由，点击 navigate）+ Header（右侧：主题 Segmented【浅色/深色/跟随系统】绑定 useThemeMode、连接状态 Tag 占位、余额 chip 占位）+ Content（Outlet）。5 个页面先建占位 `index.tsx`（标题+待实现文案），保证路由与联调可跑。

- [ ] **Step 7: 前端测试与联调验证**

```powershell
npm run test:web          # 主题 hook 4 用例绿
npm run build:web         # 构建成功
npm test                  # 后端 164 用例不回归
npm run dev               # 手动：浏览器 5173 看到 antd 布局骨架 + 切换三态主题颜色变化 + 跟随系统
```

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "feat: antd frontend scaffold with theme system, layout and dev proxy"
```

---

### Task 2: API 层 + 看板页

**Files:** web/src/api/client.ts、api/endpoints.ts、pages/dashboard/{index.tsx,hooks.ts}、components/StatusPill.tsx

**Interfaces:**
- Produces: `get<T>(path)` / `post<T>(path, body?)` / `patch<T>(path, body?)`（envelope 解包，code!==0 抛 Error(message)）；`fetchDashboard(date)`、`fetchTasks()`、`fetchProfiles()`、`triggerTask(key, bitbrowserId?)`、`rerunFailed(date)`、`runProfile(id)`、`patchProfile(id, body)`、`resetBreaker(id)`、`testBitbrowser()`、`fetchBalance()`、`fetchSettings()`、`reloadDatasource()`、`fetchGuide()`、`fetchExamples()`、`fetchExampleSource(name)`（Task 3-6 依赖）

- [ ] **Step 1: client.ts**

```ts
export class HttpError extends Error {
  constructor(public code: number, message: string) { super(message) }
}

interface Envelope<T> { code: number; message: string; data: T }

export async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const json = (await res.json().catch(() => null)) as Envelope<T> | null
  if (!json || json.code !== 0) throw new HttpError(json?.code ?? res.status, json?.message ?? '请求失败')
  return json.data
}

export const get = <T>(path: string) => request<T>(path)
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body })
export const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body })
```

- [ ] **Step 2: endpoints.ts**（函数签名 + 后端路由对照，类型来自 types.ts）

```ts
import { get, post, patch } from './client'
import type { DashboardData, TaskMetaView, ProfileRow, SettingsData, DatasourceInfo } from '../types'

export const fetchDashboard = (date: string) => get<DashboardData>(`/api/dashboard?date=${date}`)
export const fetchTasks = () => get<TaskMetaView[]>('/api/tasks')
export const fetchProfiles = () => get<ProfileRow[]>('/api/profiles')
export const triggerTask = (key: string, bitbrowserId?: string) => post<{ scope: string }>(`/api/tasks/${encodeURIComponent(key)}/trigger`, bitbrowserId ? { bitbrowserId } : {})
export const setTaskEnabled = (key: string, enabled: boolean) => patch<{ key: string; enabled: boolean }>(`/api/tasks/${encodeURIComponent(key)}`, { enabled })
export const rerunFailed = (date: string) => post<{ count: number }>('/api/runs/rerun-failed', { date })
export const runProfile = (id: number) => post<{ count: number }>(`/api/profiles/${id}/run`, {})
export const patchProfile = (id: number, body: { enabled?: boolean }) => patch<ProfileRow>(`/api/profiles/${id}`, body)
export const resetBreaker = (id: number) => post<null>(`/api/profiles/${id}/breaker/reset`, {})
export const testBitbrowser = () => post<{ ok: boolean }>('/api/bitbrowser/test', {})
export const syncProfiles = () => post<{ count: number }>('/api/bitbrowser/sync', {})
export const fetchBalance = () => get<{ configured: boolean; points: number; yuan: number }>('/api/captcha/balance')
export const fetchSettings = () => get<SettingsData>('/api/settings')
export const reloadDatasource = () => post<DatasourceInfo>('/api/datasource/reload', {})
export const fetchGuide = () => get<{ content: string }>('/api/docs/guide')
export const fetchExamples = () => get<{ name: string; label: string }[]>('/api/docs/examples')
export const fetchExampleSource = (name: string) => get<{ content: string }>(`/api/docs/examples/${name}`)
```

- [ ] **Step 3: StatusPill 组件（Tag 封装，状态→色映射与旧版一致）**

```tsx
import { Tag } from 'antd'
import type { RunStatus } from '../types'

const MAP: Record<RunStatus, { color: string; label: string }> = {
  success: { color: 'success', label: '成功' },
  failed: { color: 'error', label: '失败' },
  captcha_failed: { color: 'cyan', label: '验证码失败' },
  running: { color: 'gold', label: '执行中' },
  retry_wait: { color: 'gold', label: '重试中' },
  skipped: { color: 'default', label: '跳过' },
  pending: { color: 'default', label: '待执行' },
}

export default function StatusPill({ status }: { status: RunStatus }) {
  const m = MAP[status]
  return <Tag color={m.color}>{m.label}</Tag>
}
```

- [ ] **Step 4: 看板页（功能对照 spec 第 3 节，逐项实现）**

`pages/dashboard/hooks.ts`：`useDashboard(date)`（useQuery fetchDashboard，refetchInterval 15000）、`useTriggerTask`/`useRerunFailed`（useMutation，成功 message.success + invalidate dashboard）。
`pages/dashboard/index.tsx` 结构：
- 顶部 4 张统计卡（Row+Col+Card）：完成率（Progress circle）、结果分布（各状态 Tag + 验证码消费金额/次数）、验证码卡、实时运行（running 数 + 窗口总数）
- 工具行：日期 DatePicker（默认今天）、任务 Select（数据 fetchTasks）、状态 Segmented（全部/失败/成功/进行中）、窗口搜索 Input、`重跑今日失败` Button、`全部窗口执行` Button（未选任务时 message.warning('请先选择一个任务')）
- Table（dataSource 过滤后 runs）：列 = 窗口（profileName + bitbrowserId 前缀）、任务、状态（StatusPill）、尝试、错误（Tooltip 完整 + 截断）、截图（有则链接新窗打开 `/api/screenshots?path=`）、操作（执行/重跑 → triggerTask with bitbrowserId）
- 空态 Empty；加载态骨架

- [ ] **Step 5: 验证 + Commit**

`npm run test:web`（client envelope 单测补 3 条：正常解包/非 0 抛错/响应解析失败）、`npm run build:web`、`npm test`、浏览器手测（统计/筛选/行级执行调用后端成功 toast）。

```powershell
git add -A
git commit -m "feat: typed api layer and antd dashboard page"
```

---

### Task 3: 窗口页

**Files:** web/src/pages/profiles/{index.tsx,hooks.ts}

**Interfaces:**
- Consumes: fetchProfiles/patchProfile/runProfile/resetBreaker/syncProfiles/fetchDashboard（Task 2）
- Produces: 窗口页（搜索、同步按钮+数量 toast、Table：窗口名+ID 前缀、今日结果、熔断 Tag+Progress、启用 Switch、操作列【立即跑/详情/复制ID】）、Drawer 详情（今日时间线 Timeline + 钱包密码 env 提示 + 重置熔断）

- [ ] **Step 1: hooks.ts**（useProfiles 轮询可选、mutation：useRunProfile/usePatchProfile/useResetBreaker/useSyncProfiles 均 message 反馈 + invalidate）
- [ ] **Step 2: index.tsx**
  - Table columns 对照旧版 profiles.js 功能逐项
  - 复制ID：`navigator.clipboard.writeText(id)` + message.success('已复制窗口ID')
  - Drawer：open 状态管理；Timeline items 来自 fetchDashboard(date).runs 过滤该窗口；密码行文案：`钱包解锁密码：由环境变量 WALLET_PASSWORDS 配置（重启生效）`
  - 同步按钮：mutation syncProfiles → message.success(`已同步 ${count} 个窗口`)
- [ ] **Step 3: 验证 + Commit**

```powershell
npm run test:web; npm run build:web; npm test
git add -A
git commit -m "feat: antd profiles page with drawer detail and sync"
```

---

### Task 4: 任务页

**Files:** web/src/pages/tasks/{index.tsx,hooks.ts}

**Interfaces:**
- Consumes: fetchTasks/setTaskEnabled/triggerTask（Task 2）
- Produces: 任务卡片列表（List/Card 网格）：钱包图标、名称+key、分类 Tag（checkin 绿/faucet 蓝/mint 金/other 灰）、deprecated 灰 Tag、enabled 开关（Switch，mutation setTaskEnabled，云端 task_states 覆盖）、note 文案、sourceUrl 链接（新窗）、调度描述（cron/错峰/手动）、立即触发按钮（停用隐藏）

- [ ] **Step 1: hooks.ts**（useTasks、useSetTaskEnabled、useTriggerTask）
- [ ] **Step 2: index.tsx**（对照旧 tasks.js 功能逐项；卡片用 Card + 自定义布局，不用 List 也行——保持视觉接近旧版）
- [ ] **Step 3: 验证 + Commit**

```powershell
npm run test:web; npm run build:web; npm test
git add -A
git commit -m "feat: antd tasks page with cloud switches"
```

---

### Task 5: 文档页（能力最重，逐项对照旧 docs.js）

**Files:** web/src/pages/docs/{index.tsx,slug.ts,useDocTree.ts,markdown.tsx}

**Interfaces:**
- Consumes: fetchGuide/fetchExamples/fetchExampleSource（Task 2）
- Produces: 文档页（左 antd Tree 目录 + 右内容；markdown 渲染；代码块折叠默认收起+语言标签；标题锚点注入+章节交叉链接跳转；src:// 链接切源码视图；源码行号视图；scrollspy 树高亮+跟随滚动；Tree 节点展开收起）

- [ ] **Step 1: slug.ts + 测试**（标题→锚点 slug，规则与旧 docs.js 一致：小写、去非中文/字母数字/空格连字符、空格→'-'）

```ts
export function slugify(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
}
```

测试：`'9. 常用模式' → '9-常用模式'`、`'6. 拟人接口（Humanizer）' → '6-拟人接口humanizer'`、`'任务开发与测试'` 等 4 条。

- [ ] **Step 2: markdown.tsx**（react-markdown + remark-gfm，components 覆盖）

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Typography } from 'antd'

export default function MarkdownView({ content }: { content: string }) {
  return (
    <Typography>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <Typography.Title level={2} id={slugify(String(p.children))} style={{ marginTop: 8 }}>{p.children}</Typography.Title>,
          h2: (p) => <Typography.Title level={3} id={slugify(String(p.children))} style={{ marginTop: 16 }}>{p.children}</Typography.Title>,
          h3: (p) => <Typography.Title level={4} id={slugify(String(p.children))} style={{ marginTop: 12 }}>{p.children}</Typography.Title>,
          a: (p) => <Typography.Link href={p.href} target={p.href?.startsWith('http') ? '_blank' : undefined}>{p.children}</Typography.Link>,
          code: ({ className, children, ...rest }) => {
            const match = /language-(\w+)/.exec(className ?? '')
            if (match) {
              return (
                <SyntaxHighlighter language={match[1]} style={oneDark} customStyle={{ borderRadius: 8 }}>
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              )
            }
            return <Typography.Text code>{children}</Typography.Text>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </Typography>
  )
}
```

注意：代码块默认折叠 + 语言标签 = 外层包 Collapse 或自定义（在 ReactMarkdown 的 pre 组件里包 antd Collapse ghost，header 显示语言名）——实现时用 `pre: (p) => ...` 拿不到语言（language 在 code 上），改为 code 组件里 match 到语言时渲染 `<Collapse ghost items={[{ key:'1', label:`▸ ${lang}`, children:<SyntaxHighlighter...> }]} />`，未匹配语言的行内 code 用 Typography.Text code。

- [ ] **Step 3: useDocTree.ts + 测试**（从标题提取树：h2 章/h3 节嵌套 + 示例文件节点；返回 antd Tree treeData）

```ts
export interface DocNode { key: string; title: string; children?: DocNode[] }
export function extractChapterTree(htmlLikeText: string): DocNode[]  // 输入 markdown 源文本，按行解析 ## / ### 标题
```

测试：3 个用例（章嵌套节/无节章/示例节点拼接）。

- [ ] **Step 4: index.tsx**
  - 左：Tree（treeData = 章节树 + 「任务示例」节点(children=3 示例文件，key=`src://<name>`)；defaultExpandAll；onSelect：key 为 `src://` 前缀 → 渲染源码视图；否则渲染 markdown 视图并 scrollIntoView（document.getElementById(key)）；selectedKeys 受控）
  - 右：内容区（markdown 视图 / 源码视图切换：源码 = 逐行行号渲染 `<pre>` 风格 Div）；锚点链接点击（内容区 onClick 拦截 a[href^="#"] → preventDefault + scrollIntoView；a[href^="src://"] → 切源码视图）
  - scrollspy：IntersectionObserver 监听内容区 h1/h2/h3 → 更新 Tree selectedKeys + 树节点 scrollIntoView（block:'nearest'）
  - 代码折叠/高亮、交叉链接、跟随主题：代码块高亮风格固定 oneDark 但外层包 antd Collapse；正文 Typography 自动随主题
- [ ] **Step 5: 验证 + Commit**

```powershell
npm run test:web; npm run build:web; npm test
# patchright 冒烟：树点击/锚点/src:// 跳转/折叠/scrollspy（沿用旧验证脚本思路，5173 端口）
git add -A
git commit -m "feat: antd docs page with tree, markdown, folding code and cross-links"
```

---

### Task 6: 设置页 + 全局 message

**Files:** web/src/pages/settings/{index.tsx,hooks.ts}

**Interfaces:**
- Consumes: fetchSettings/reloadDatasource/testBitbrowser/fetchBalance（Task 2）；useThemeMode（Task 1）
- Produces: 设置页（Descriptions 只读参数：比特浏览器地址/并发/探活/时区/版本；数据源状态行+重载按钮；测试连接按钮+状态 Tag；余额查询+展示；主题三态 Segmented——与顶栏一致共用 hook）

- [ ] **Step 1: hooks.ts**（useSettings、useReloadDatasource、useTestBitbrowser、useBalance——mutation 均 message 反馈）
- [ ] **Step 2: index.tsx**（Descriptions + Space 布局；数据源 error 时 Alert 展示）
- [ ] **Step 3: 验证 + Commit**

```powershell
npm run test:web; npm run build:web; npm test
git add -A
git commit -m "feat: antd settings page with datasource reload and balance"
```

---

### Task 7: 构建接入后端 + 删除旧前端 + 文档同步

**Files:** src/server/app.ts（静态托管优先 web/dist）、删除 src/server/public 旧前端、README/API-GUIDE 面板章节更新、根 package.json start 说明

- [ ] **Step 1: app.ts 静态托管调整**

```ts
// 静态托管顺序：优先 web/dist（antd 构建产物），回退旧 public（兼容未构建场景——旧 public 删除后此回退可留作空目录占位）
const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')
const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public')
app.use(express.static(distDir))
app.use(express.static(publicDir))
```

- [ ] **Step 2: 删除旧前端**（src/server/public 整个目录；确认 docs.js/css 无引用残留）
- [ ] **Step 3: 生产验证**

```powershell
npm run build:web
npm test
npm run dev   # 后端 3000 打开面板 = antd 版（生产形态验证）；dev 形态 5173 亦验
```

- [ ] **Step 4: 文档同步**（README：开发/生产两种启动与端口说明（5173/3000）、build:web 说明；API-GUIDE 第 8 章面板使用说明按 antd 版更新交互描述：主题切换入口、窗口详情 Drawer 等）
- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "feat: serve antd frontend from backend and remove legacy panel"
```

---

## Self-Review 记录

- 规格覆盖：spec 第 1/2/3/4/5/6 节 → Task 1-7 一一对应；能力不丢失对照表逐项落在 Task 2-6；主题三态 → Task 1+6；联调/生产 → Task 1+7
- 类型一致性：`RunStatus/ProfileRow/RunRow/TaskMetaView/DashboardData/SettingsData/DatasourceInfo`（Task 1 types.ts）在 Task 2-6 的 endpoints/hooks/组件中引用一致；`useThemeMode` 返回 `{mode,setMode,effective}` 在 App.tsx 与 settings 页共用
- 后端接口零改动（Task 7 仅静态目录顺序调整），164 后端测试全程回归门槛
- 占位无：每页功能对照旧版逐项实现清单已列；文档页能力（树/折叠/锚点/src:///scrollspy）在 Task 5 明确
