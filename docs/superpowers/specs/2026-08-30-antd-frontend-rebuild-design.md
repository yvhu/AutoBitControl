# AutoBitControl 前端 antd 重做 设计文档

日期：2026-08-30
状态：已与用户确认技术栈与交互

## 0. 目标

用 Ant Design 重做面板前端（原为手写 HTML/CSS/JS），达到：

- 浅色/暗黑双主题，**默认跟随系统**，顶栏可切换（亮/暗/跟随系统），选择本地持久化
- 文档页配色随主题（antd token 自动一致），文档目录树、代码块、交叉链接、示例源码视图等既有能力全部保留
- 代码规范：目录清晰、命名一致、组件职责单一；**不启用 ESLint**（不要 lint 门槛）
- 开发一条命令前后端同启；生产构建后后端单进程托管（保持 3000 端口与 pm2 现状）

## 1. 技术栈

| 项 | 选型 |
|---|---|
| 框架 | React 18 + TypeScript |
| 构建 | Vite 5 |
| UI | antd 5（ConfigProvider + defaultAlgorithm/darkAlgorithm） |
| 数据请求 | @tanstack/react-query（服务端状态缓存、轮询） |
| 路由 | react-router 6（5 页面） |
| 文档渲染 | react-markdown + remark-gfm + antd Tree（目录树）+ react-syntax-highlighter（代码高亮） |
| 规范 | 无 ESLint；目录/命名人工约定（见 4） |

## 2. 主题设计

- `theme` 模块：三态 `'light' | 'dark' | 'system'`，存 localStorage（缺省 system）
- system 态用 `window.matchMedia('(prefers-color-scheme: dark)')` 实时监听
- antd `ConfigProvider` 按生效态选择 `theme.defaultAlgorithm` / `darkAlgorithm`
- 品牌色：主色 #1677FF（AntD 默认，用户已选定 Ant Design 色板），面板组件全部用 antd token（文档页 markdown 样式通过 antd 的 `Typography` 组件渲染 + 自定义 className 的少量 CSS 变量映射，保证随主题变色）

## 3. 页面与既有功能对照（能力不丢失）

| 页面 | 组件方案 | 保留能力 |
|---|---|---|
| 布局 | Layout+Sider（5 导航）+Header（主题切换、连接状态、余额）+Content | 顶栏状态芯片、15s 看板轮询、全局错误 toast（antd message） |
| 看板 | 统计卡（Card+Statistic/Progress）、筛选（Select/Input/Segmented）、表格（Table，行内操作） | 完成率/结果分布/验证码/并发卡、状态筛选、任务/窗口筛选、行级执行/重跑、重跑失败、全部窗口执行 |
| 窗口 | Table（搜索、开关 Switch、操作列）+ Drawer 详情 | 同步按钮、复制ID、详情弹窗（时间线+密码提示+重置熔断） |
| 任务 | List/Card 网格 | 分类徽章、来源页链接、备注、云端开关（Switch）、立即触发 |
| 文档 | Tree + react-markdown + 折叠代码块 + 源码视图 | 目录树、展开收起、scrollspy 高亮、吸顶跟随、锚点跳转、src:// 源码跳转 |
| 设置 | Descriptions/表单行 + 按钮 | 数据源状态+重载、连接测试、余额、执行参数、主题切换入口 |

## 4. 目录结构与命名约定

```
web/
├── index.html
├── vite.config.ts          # dev 代理 /api → http://127.0.0.1:3000
├── tsconfig.json
├── src/
│   ├── main.tsx            # 入口：QueryClientProvider + Router + ConfigProvider
│   ├── api/
│   │   ├── client.ts       # 类型化 fetch 封装（envelope 解包、错误抛 HttpError）
│   │   └── endpoints.ts    # 每个 REST 接口一个类型化函数
│   ├── theme/
│   │   ├── useThemeMode.ts # 三态 hook（localStorage + matchMedia）
│   │   └── antdTheme.ts    # token 定制
│   ├── layouts/AppLayout.tsx
│   ├── components/         # 通用：StatusPill、WindowCell、TaskCard、DocTree…
│   ├── pages/
│   │   ├── dashboard/
│   │   ├── profiles/
│   │   ├── tasks/
│   │   ├── docs/
│   │   └── settings/
│   └── types.ts            # 与后端一致的领域类型（RunRow/ProfileRow/TaskMeta/...）
└── package.json
```

约定：页面目录内 `index.tsx` 为页面入口，`hooks.ts` 放该页 query/mutation hooks；组件 Props 显式 interface；API 函数名 = `fetchXxx`/`mutateXxx`；错误统一经 message 提示。

## 5. 前后端联调

- dev：`concurrently` 一条命令——后端 `tsx src/index.ts`(3000) + `vite`(5173，proxy /api)；文档写明开发面板地址 5173
- prod：`npm run build` → `web/dist`；后端静态托管改为优先 web/dist（存在则用之，回退旧 public）；`npm start` 单进程 3000
- 后端 REST 全部不动；仅调整静态目录逻辑

## 6. 实施顺序（SDD 任务）

1. 脚手架（Vite+React+TS+antd+react-query+router+文档组件依赖）+ 主题系统 + AppLayout 骨架 + concurrently 联调
2. API 层（client+endpoints+types）+ 看板页
3. 窗口页（含 Drawer 详情、复制ID、同步）
4. 任务页（开关/徽章/触发）
5. 文档页（Tree 目录 + markdown 渲染 + 代码折叠 + 源码视图 + 锚点/src:// 跳转 + scrollspy 吸顶）
6. 设置页（数据源/连接/余额/主题切换入口）+ 全局 message
7. 构建接入后端 + 删除旧前端 + README/手册同步

每步：`npm test`（后端 164 用例不回归）+ 前端 `vite build` 成功 + 手工浏览器验证（patchright 冒烟脚本）后提交。
