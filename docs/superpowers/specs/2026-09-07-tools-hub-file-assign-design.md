# 工具中心与「文件随机分配」工具设计（tools-hub-file-assign）

日期：2026-09-07
状态：设计已确认（UI 设计稿 v2 用户已确认）

## 目标

面板新增「工具」栏目：侧边栏菜单加「工具」项，页面为工具卡片中心（未来随需扩展多个工具）。第一个工具为「文件随机分配」：

1. 用户指定本机源文件夹（面板输入绝对路径，后端直接读目录，无文件上传）
2. 按「名称生成组件 + 插入位置」模板重命名文件夹内的文件（原地重命名，源文件夹即最终目录）
3. 随机分配：每个账号行分到一个不重复的文件（Fisher-Yates 洗牌），把重命名后的文件绝对路径写回 `config/accounts.xlsx` 的目标列（运行时可选「图片地址」或「文件地址」）
4. 先预览后执行：preview 返回分配计划表 → 用户确认 → apply 按回传计划执行
5. 执行成功后自动重载数据源（复用现有 datasource reload 逻辑）

## 需求要点（已与用户确认）

- 源文件夹：面板输入本机绝对路径，不做浏览器上传（单机部署，文件就在后端本机）
- 名称生成组件（可勾选组合，各组件各自配置长度）：
  - 英文（随机）：个数可配 + 大小写可选（小写 a-z / 大写 A-Z / 大小写混合）
  - 数字（随机）：位数可配
  - 特殊字符：个数可配 + 字符集可配（默认 `!@$%^`）
- 插入位置（单选，作用于原文件名 stem，扩展名始终保留）：
  - 替换文件名：新 stem = 生成串
  - 文件名前：生成串 + 原 stem
  - 文件名后：原 stem + 生成串
  - 指定位置后：原 stem 第 N 个字符后插入生成串（N 超长则放末尾）
  - 指定文本后：原 stem 中该文本第一次出现处后插入；未找到 → 该行预览报错
- 文件数 < 账号行数：报错不执行；文件数 ≥ 账号行数：随机取 N 个分配（每行一个、不重复），其余文件保持原名不动
- 重命名目标：仅被分配到的 N 个文件被改名，源文件夹内其他文件不动
- 目标列：运行时下拉选「图片地址」/「文件地址」（accounts.xlsx 现有两列，「文件地址」当前存完整路径、「图片地址」为空）

## 架构

### 分层定位（新增 tools 域）

```
server → tools → infrastructure
```

新增顶层域 `src/tools/`（独立于 engine/tasks，工具能力不属于任务运行链路）：

- 依赖方向：`src/server/routes/tools.ts` → `src/tools/*` → `node:fs` / `exceljs` / `src/infrastructure/config`
- `src/tools/index.ts`：工具注册表 `TOOLS = [{ key, name, description }]`，工具中心页从此渲染卡片，未来新增工具只登记一个 key

### 后端模块

| 文件 | 职责 |
|---|---|
| `src/tools/file-assign/types.ts` | 参数/模板/计划类型定义（NameTemplate、Position、AssignPlan、AssignRow 等） |
| `src/tools/file-assign/name-template.ts` | 纯函数：生成串生成（英文/数字/特殊字符各组件）、插入位置应用、同批去重 |
| `src/tools/file-assign/planner.ts` | 读目录文件列表、校验（目录/列/数量）、Fisher-Yates 洗牌、生成分配计划 |
| `src/tools/file-assign/applier.ts` | 校验回传计划 → renameSync 逐个重命名 → exceljs 写回 xlsx → 触发 datasource reload；模块级执行锁防并发 |
| `src/tools/file-assign/xlsx.ts` | xlsx 读写封装（列定位、行读写、写回），复用 exceljs（与 datasource 一致） |
| `src/server/routes/tools.ts` | express 路由工厂 `toolsRouter(deps)`，带 `@swagger` 注解，统一 `ok/fail` 响应 |

`src/server/app.ts`：`api.use(toolsRouter(...))` 挂载；`src/server/openapi.ts` 自动聚合。

### API 设计

- `GET /api/tools` → `data: { tools: [{ key, name, description }] }`（工具中心页数据源）
- `POST /api/tools/file-assign/preview`
  - body：`{ sourceDir, column, template }`
  - `template: { components: { english: { count, case: 'lower'|'upper'|'mixed' }, digits: { count }, special: { count, charset } }, position: { type: 'replace'|'before'|'after'|'after-position'|'after-text', value?: string|number } }`（组件不勾选时对应子对象为 null）
  - 返回 `data: { accountsCount, filesCount, plan: [{ rowNumber, window, oldName, newName, newPath }] }`；校验失败统一走 `fail`（错误码 40001-40004），不设 errors 字段
- `POST /api/tools/file-assign/apply`
  - body：`{ sourceDir, column, plan }`（plan 为 preview 回传的计划；apply 不重收模板，以计划为准）
  - 返回 `data: { renamedCount, updatedRows, reloadedRows }`

### 数据流

```
preview: 参数校验（目录存在且为目录、列存在、文件数≥账号行数、模板有效）
       → 洗牌取前 N 文件 → 每个文件生成唯一新名（撞名/与现存文件撞名重新生成）
       → 返回计划表（行号/窗口/旧名/新名/新路径）
apply:   校验回传计划（文件仍在、新名无冲突、账号行数一致、执行锁）
       → renameSync 逐个重命名（全部成功后）→ exceljs 写回 xlsx → datasource reload
```

## 错误码（`src/server/http/errors.ts` 追加）

| code | 含义 |
|---|---|
| 40001 TOOL_DIR_NOT_FOUND | 源文件夹不存在或不是目录 |
| 40002 TOOL_COLUMN_NOT_FOUND | 目标列在 accounts.xlsx 中不存在 |
| 40003 TOOL_FILES_INSUFFICIENT | 文件数少于账号行数 |
| 40004 TOOL_TEMPLATE_INVALID | 模板无效（生成串为空、个数超限等） |
| 40005 TOOL_PLAN_INVALID | apply 回传计划校验失败 |
| 40904 TOOL_BUSY | 上一次执行进行中 |
| 50001 TOOL_IO_FAILED | 磁盘 IO 失败（重命名/写回 xlsx，错误信息附已改名清单） |

## 健壮性与安全

- sourceDir 用 `realpathSync` 解析 + 存在性/目录校验；xlsx 路径取 `config.dataSource.path`
- 重命名冲突：生成串与目标目录现存文件名冲突时重新生成（带次数上限）
- apply 前逐文件校验计划一致性；写 xlsx 失败时已重命名文件不回滚，错误信息附已改名文件清单（无撤销能力，重试需手动恢复，文档明示）
- 执行锁：apply 进行中再次调用返回 409 TOOL_BUSY（模块级布尔锁，单进程足够）
- 写 xlsx 仅改目标列单元格，其他列不动；「指定文本后」未找到文本的行预览报错不执行

## 前端

### 文件清单

| 文件 | 改动 |
|---|---|
| `web/src/layouts/AppLayout.tsx` | menuItems 插入 `{ key: '/tools', icon: <ToolOutlined />, label: '工具' }` |
| `web/src/App.tsx` | 加 `import ToolsPage from './pages/tools'` + `<Route path="tools" element={<ToolsPage />} />` |
| `web/src/pages/tools/index.tsx`（新建） | 工具中心：卡片网格（数据来自 GET /api/tools），第一个卡片「文件随机分配」可进入 |
| `web/src/pages/tools/file-assign.tsx`（新建） | 文件随机分配面板（卡片点击进入或同页展开区块） |
| `web/src/pages/tools/hooks.ts`（新建） | react-query hooks + 可测纯函数（表单状态构建、预览数据处理） |
| `web/src/pages/tools/hooks.test.tsx`（新建） | hooks 单测（`npm run test:web`） |
| `web/src/api/endpoints.ts` | 加 `fetchTools` / `previewFileAssign` / `applyFileAssign` |
| `web/src/types.ts` | 手补类型（先例）：`ToolItem`、`FileAssignTemplate`、`FileAssignPlan` 等 |

### 面板交互（按已确认的 UI 设计稿 v2）

- 表单：源文件夹路径 Input + 「生成预览」按钮（调 preview，展示文件数/账号行数 badge 并填充预览表格）→ 写入目标列 Select → 名称生成组件（英文 checkbox+个数+大小写下拉、数字 checkbox+位数、特殊字符 checkbox+个数+字符集）→ 插入位置 radio（替换文件名/文件名前/文件名后/指定位置后+位置输入/指定文本后+文本输入）→ 实时示例名
- 预览表格（窗口 / 旧名 → 新名 / 目标路径）+ 校验错误提示（校验失败走统一报错）
- 「执行分配」（预览通过才可点）→ 成功后 success 提示（已重命名 N 个文件、写回 M 行、数据源已重载）
- 空勾选校验：前端即时提示「至少勾选一个生成组件或选择替换文件名时生成串不能为空」

## 测试

- 后端（vitest，`tests/`）：
  - `name-template`：各组件生成、大小写三模式、五种插入位置、空模板报错、去重
  - `planner`：临时目录 fixture、文件不足报错、洗牌不重复、行数匹配
  - `applier` + `xlsx`：临时 xlsx 副本写入验证（其他列不动）、计划校验失败路径、执行锁
  - 路由：supertest 测 preview/apply 正常与错误路径（注入临时目录与临时 xlsx）
- 前端：`hooks.test.tsx`

## 不做（YAGNI）

- 浏览器文件上传、文件移动/复制到其他目录（原地重命名）
- 历史记录、撤销/回滚、定时执行
- 工具中心页内的多工具注册 UI 配置化（注册表静态数组即可）
