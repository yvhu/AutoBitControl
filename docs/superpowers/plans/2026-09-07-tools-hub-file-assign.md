# 工具中心与文件随机分配工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面板新增「工具」栏目（工具卡片中心），并实现第一个工具「文件随机分配」：按名称模板重命名本机源文件夹内文件、随机分配给 accounts.xlsx 各账号行并写回目标列，先预览后执行。

**Architecture:** 新增顶层域 `src/tools/`（分层 `server → tools → infrastructure`，tools 用 exceljs 直接读写 xlsx、node:fs 操作文件）；`src/server/routes/tools.ts` 提供 3 个 REST 接口（工具清单 / 预览 / 执行），预览计划由纯函数生成、执行按回传计划校验后落盘；前端 `web/src/pages/tools/` 工具中心页 + 文件分配面板。

**Tech Stack:** TypeScript strict（无分号/单引号/2 空格缩进）、express 5 + @swagger 注解、exceljs、vitest + supertest（后端）、React 18 + antd 5 + react-query（前端）。

## Global Constraints

- 所有注释/UI 文案/commit message 用中文；无分号、单引号、2 空格缩进、TS 严格模式
- 分层依赖方向：`server → tools → infrastructure`；tools 不得 import server 层代码（tools 抛 `ToolError`，路由映射为统一响应）
- 错误码约定：code = status*100 + 序号；工具错误码见任务 1 的 `TOOL_ERROR_CODES`
- 后端统一响应 `{code, message, data}`（`ok`/`fail` + `asyncHandler`）；未知异常由 errorHandler 兜底
- 每次改完跑：`npm run typecheck` + `npm test`（后端）；前端改完另跑 `npm run test:web`
- 前端单测仅测 hooks 纯函数与 mutation（vitest + @testing-library/react，参考 `web/src/pages/settings/hooks.test.tsx`）
- 前端类型一律手补进 `web/src/types.ts`（项目先例），不重新生成 schema.d.ts
- commit 风格 conventional：`feat:`/`fix:`/`chore:`/`docs:` + 中文描述；每个任务结束单独 commit
- 真实账号文件 `config/accounts.xlsx` 绝不提交、测试只操作临时目录/临时 xlsx

---

### Task 1: 工具域类型、错误与名称模板纯函数

**Files:**
- Create: `src/tools/errors.ts`
- Create: `src/tools/file-assign/types.ts`
- Create: `src/tools/file-assign/name-template.ts`
- Test: `tests/file-assign-name-template.test.ts`

**Interfaces:**
- Consumes: 无（全新模块）
- Produces:
  - `TOOL_ERROR_CODES`（40001 TOOL_DIR_NOT_FOUND / 40002 TOOL_COLUMN_NOT_FOUND / 40003 TOOL_FILES_INSUFFICIENT / 40004 TOOL_TEMPLATE_INVALID / 40005 TOOL_PLAN_INVALID / 40904 TOOL_BUSY / 50001 TOOL_IO_FAILED）与 `ToolError extends Error { status: number; code: number }`（任务 3/4/5 使用）
  - 类型 `FileAssignTemplate`、`PositionType`、`AssignRow`、`AssignPlan`、`ApplyParams`、`ApplyResult`（任务 3/4/5/6 使用）
  - 函数 `validateTemplate(t): string | null`、`generateRandomString(t, rand?): string`、`splitExt(name): {stem, ext}`、`applyPosition(oldName, gen, position): string`、`generateUniqueNames(oldNames, t, exists, rand?): string[]`（任务 3/4 使用）

- [ ] **Step 1: 写失败测试**

创建 `tests/file-assign-name-template.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import {
  applyPosition,
  generateRandomString,
  generateUniqueNames,
  splitExt,
  validateTemplate,
} from '../src/tools/file-assign/name-template'
import type { FileAssignTemplate } from '../src/tools/file-assign/types'

const base: FileAssignTemplate = {
  english: { count: 2, caseMode: 'lower' },
  digits: null,
  special: null,
  position: { type: 'replace' },
}

const rand0 = () => 0
const randSeq = (vals: number[]) => {
  let i = 0
  return () => vals[i++ % vals.length]
}

describe('validateTemplate', () => {
  it('组件全空 → 报错', () => {
    const t: FileAssignTemplate = { english: null, digits: null, special: null, position: { type: 'replace' } }
    expect(validateTemplate(t)).toMatch(/至少勾选一个生成组件/)
  })

  it('个数越界 → 报错', () => {
    expect(validateTemplate({ ...base, english: { count: 21, caseMode: 'lower' } })).toMatch(/1-20/)
    expect(validateTemplate({ ...base, digits: { count: 0 } })).toMatch(/1-20/)
  })

  it('特殊字符集为空 → 报错', () => {
    expect(validateTemplate({ ...base, special: { count: 2, charset: '  ' } })).toMatch(/字符集不能为空/)
  })

  it('after-position 无合法位置 → 报错', () => {
    expect(validateTemplate({ ...base, position: { type: 'after-position', value: 0 } })).toMatch(/指定位置/)
    expect(validateTemplate({ ...base, position: { type: 'after-position' } })).toMatch(/指定位置/)
  })

  it('after-text 无文本 → 报错', () => {
    expect(validateTemplate({ ...base, position: { type: 'after-text' } })).toMatch(/指定文本/)
  })

  it('合法模板 → null', () => {
    expect(validateTemplate(base)).toBeNull()
  })
})

describe('generateRandomString', () => {
  it('rand=0 时英文取池首字符', () => {
    const t: FileAssignTemplate = { english: { count: 3, caseMode: 'lower' }, digits: null, special: null, position: { type: 'replace' } }
    expect(generateRandomString(t, rand0)).toBe('aaa')
  })

  it('大写池取 A-Z', () => {
    const t: FileAssignTemplate = { english: { count: 2, caseMode: 'upper' }, digits: null, special: null, position: { type: 'replace' } }
    expect(generateRandomString(t, rand0)).toBe('AA')
  })

  it('按 英文+数字+特殊字符 顺序拼接', () => {
    const t: FileAssignTemplate = {
      english: { count: 2, caseMode: 'lower' },
      digits: { count: 2 },
      special: { count: 1, charset: '!@' },
      position: { type: 'replace' },
    }
    expect(generateRandomString(t, rand0)).toBe('aa00!')
  })
})

describe('splitExt', () => {
  it('普通文件名', () => {
    expect(splitExt('a.png')).toEqual({ stem: 'a', ext: '.png' })
  })

  it('多点文件名取最后一段扩展名', () => {
    expect(splitExt('a.b.c.tar.gz')).toEqual({ stem: 'a.b.c.tar', ext: '.gz' })
  })

  it('无扩展名', () => {
    expect(splitExt('README')).toEqual({ stem: 'README', ext: '' })
  })
})

describe('applyPosition', () => {
  const gen = 'xx'
  const withPos = (type: FileAssignTemplate['position']['type'], value?: string | number) => ({
    ...base,
    position: { type, value },
  })

  it('replace：替换 stem 保留扩展名', () => {
    expect(applyPosition('a.png', gen, withPos('replace').position)).toBe('xx.png')
  })

  it('before：生成串在前', () => {
    expect(applyPosition('a.png', gen, withPos('before').position)).toBe('xxa.png')
  })

  it('after：生成串在后', () => {
    expect(applyPosition('a.png', gen, withPos('after').position)).toBe('axx.png')
  })

  it('after-position：第 N 个字符后插入', () => {
    expect(applyPosition('abcd.png', gen, withPos('after-position', 2).position)).toBe('abxxcd.png')
  })

  it('after-position：位置超长放末尾', () => {
    expect(applyPosition('ab.png', gen, withPos('after-position', 9).position)).toBe('abxx.png')
  })

  it('after-text：指定文本后插入', () => {
    expect(applyPosition('file2024x.png', gen, withPos('after-text', '2024').position)).toBe('file2024xxx.png')
  })

  it('after-text：未找到抛错', () => {
    expect(() => applyPosition('a.png', gen, withPos('after-text', 'zzz').position)).toThrow(/未在文件名/)
  })
})

describe('generateUniqueNames', () => {
  const t: FileAssignTemplate = { english: { count: 1, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } }

  it('生成互不重复且不撞现存文件的新名', () => {
    const exists = ['x.png', 'ba.png']
    const names = generateUniqueNames(['a.png', 'b.png'], t, exists, randSeq([0, 0.3, 0.6, 0.9]))
    expect(names).toEqual(['aa.png', 'hb.png'])
  })

  it('尝试耗尽抛错', () => {
    const exists = ['aa.png', 'ab.png']
    expect(() => generateUniqueNames(['a.png', 'b.png'], t, exists, rand0)).toThrow(/唯一新名失败/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/file-assign-name-template.test.ts`
Expected: FAIL（模块不存在，Cannot find module）

- [ ] **Step 3: 写实现**

创建 `src/tools/errors.ts`：

```ts
/**
 * 工具域错误（tools 层）：工具业务错误码与 ToolError
 * 依赖方向：无依赖，被 tools 内各模块抛出，由 server 路由映射为统一响应
 * 设计思路：tools 不能反向依赖 server（分层约束），故自持错误码；
 * 数值与 server/http/errors.ts 的 ERROR_CODES 对应项保持一致（code = status*100 + 序号）
 */
export const TOOL_ERROR_CODES = {
  /** 400：源文件夹不存在或不是目录 */
  TOOL_DIR_NOT_FOUND: 40001,
  /** 400：目标列在 accounts.xlsx 中不存在 */
  TOOL_COLUMN_NOT_FOUND: 40002,
  /** 400：文件数少于账号行数 */
  TOOL_FILES_INSUFFICIENT: 40003,
  /** 400：名称模板无效（生成串为空/个数越界/插入参数缺失） */
  TOOL_TEMPLATE_INVALID: 40004,
  /** 400：执行阶段回传计划校验失败（文件变动/行数不一致等） */
  TOOL_PLAN_INVALID: 40005,
  /** 409：上一次执行进行中 */
  TOOL_BUSY: 40904,
  /** 500：磁盘 IO 失败（重命名/写回 xlsx） */
  TOOL_IO_FAILED: 50001,
} as const

/** 工具域业务错误：status 为期望 HTTP 状态码，code 为业务错误码（路由负责转统一响应） */
export class ToolError extends Error {
  constructor(public status: number, public code: number, message: string) {
    super(message)
    this.name = 'ToolError'
  }
}
```

创建 `src/tools/file-assign/types.ts`：

```ts
/**
 * 文件随机分配类型（tools 层）：模板/计划/执行参数
 * 依赖方向：无依赖，被 name-template/planner/applier 与 server 路由引用
 */
export type EnglishCase = 'lower' | 'upper' | 'mixed'

/** 插入位置：replace=替换文件名、before=文件名前、after=文件名后、after-position=指定位置后、after-text=指定文本后 */
export type PositionType = 'replace' | 'before' | 'after' | 'after-position' | 'after-text'

export interface EnglishComponent {
  count: number
  caseMode: EnglishCase
}

export interface DigitsComponent {
  count: number
}

export interface SpecialComponent {
  count: number
  charset: string
}

export interface PositionConfig {
  type: PositionType
  /** after-position: 原 stem 中插入位置（1 起）；after-text: 定位文本 */
  value?: string | number
}

/** 名称模板：组件为 null 表示不启用该组件；生成串 = 英文 + 数字 + 特殊字符顺序拼接 */
export interface FileAssignTemplate {
  english: EnglishComponent | null
  digits: DigitsComponent | null
  special: SpecialComponent | null
  position: PositionConfig
}

/** 单行分配计划（与账号表数据行一一对应） */
export interface AssignRow {
  /** xlsx 行号（1 起，第 1 行为表头） */
  rowNumber: number
  /** 展示用窗口标识：窗口名称列 / 窗口列 / 行号兜底 */
  window: string
  oldName: string
  newName: string
  newPath: string
}

/** 预览返回的分配计划 */
export interface AssignPlan {
  accountsCount: number
  filesCount: number
  plan: AssignRow[]
}

/** 执行参数：plan 为预览阶段回传的计划 */
export interface ApplyParams {
  sourceDir: string
  column: string
  plan: AssignRow[]
  xlsxPath: string
}

export interface ApplyResult {
  renamedCount: number
  updatedRows: number
}
```

创建 `src/tools/file-assign/name-template.ts`：

```ts
/**
 * 名称模板（tools 层）：生成串生成 + 插入位置应用 + 批量唯一名生成
 * 依赖方向：仅依赖 ./types，被 planner/applier 引用；纯函数无副作用便于单测
 * 设计思路：扩展名始终保留；新名不与目录现存文件冲突（Windows 大小写不敏感，比较统一小写）
 */
import type { EnglishCase, FileAssignTemplate, PositionConfig } from './types'

const LOWER_POOL = 'abcdefghijklmnopqrstuvwxyz'
const UPPER_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

const ENGLISH_POOLS: Record<EnglishCase, string> = {
  lower: LOWER_POOL,
  upper: UPPER_POOL,
  mixed: LOWER_POOL + UPPER_POOL,
}

/** 各组件个数上限（防极端参数拖垮生成） */
export const MAX_COMPONENT_COUNT = 20

/** 唯一名生成最大尝试次数 */
const MAX_GEN_ATTEMPTS = 100

/** 从字符池随机取 count 个字符 */
function pick(pool: string, count: number, rand: () => number): string {
  let out = ''
  for (let i = 0; i < count; i++) out += pool[Math.floor(rand() * pool.length)]
  return out
}

/** 校验模板：合法返回 null，否则返回中文错误文案 */
export function validateTemplate(t: FileAssignTemplate): string | null {
  if (!t || !t.position) return '名称模板不能为空'
  const comps = [t.english, t.digits, t.special]
  if (!comps.some((c) => c && c.count > 0)) return '至少勾选一个生成组件（英文/数字/特殊字符）'
  if (t.english && (t.english.count < 1 || t.english.count > MAX_COMPONENT_COUNT)) return `英文个数需在 1-${MAX_COMPONENT_COUNT} 之间`
  if (t.digits && (t.digits.count < 1 || t.digits.count > MAX_COMPONENT_COUNT)) return `数字位数需在 1-${MAX_COMPONENT_COUNT} 之间`
  if (t.special) {
    if (t.special.count < 1 || t.special.count > MAX_COMPONENT_COUNT) return `特殊字符个数需在 1-${MAX_COMPONENT_COUNT} 之间`
    if (!t.special.charset.trim()) return '特殊字符集不能为空'
  }
  if (t.position.type === 'after-position' && (typeof t.position.value !== 'number' || !Number.isInteger(t.position.value) || t.position.value < 1)) {
    return '指定位置需为不小于 1 的整数'
  }
  if (t.position.type === 'after-text' && (typeof t.position.value !== 'string' || t.position.value.trim() === '')) {
    return '指定文本不能为空'
  }
  return null
}

/** 按模板生成随机生成串：英文 + 数字 + 特殊字符顺序拼接（与面板示例一致） */
export function generateRandomString(t: FileAssignTemplate, rand: () => number = Math.random): string {
  let out = ''
  if (t.english) out += pick(ENGLISH_POOLS[t.english.caseMode], t.english.count, rand)
  if (t.digits) out += pick('0123456789', t.digits.count, rand)
  if (t.special) out += pick(t.special.charset.trim(), t.special.count, rand)
  return out
}

/** 拆分扩展名：'a.png' → {stem:'a', ext:'.png'}；无扩展名 → ext 为空串 */
export function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

/** 按插入位置把生成串应用到原文件名（扩展名保留）；after-text 未找到文本时抛错 */
export function applyPosition(oldName: string, gen: string, position: PositionConfig): string {
  const { stem, ext } = splitExt(oldName)
  let newStem: string
  switch (position.type) {
    case 'replace':
      newStem = gen
      break
    case 'before':
      newStem = gen + stem
      break
    case 'after':
      newStem = stem + gen
      break
    case 'after-position': {
      const n = Number(position.value)
      newStem = n >= stem.length ? stem + gen : stem.slice(0, n) + gen + stem.slice(n)
      break
    }
    case 'after-text': {
      const text = String(position.value)
      const idx = stem.indexOf(text)
      if (idx < 0) throw new Error(`指定文本「${text}」未在文件名「${oldName}」中出现`)
      newStem = stem.slice(0, idx + text.length) + gen + stem.slice(idx + text.length)
      break
    }
    default:
      throw new Error(`未知插入位置: ${String(position.type)}`)
  }
  return newStem + ext
}

/**
 * 为旧文件名批量生成新名：互不重复、且不与目录现存文件冲突
 * @param oldNames 按分配顺序排列的旧文件名（与账号行一一对应）
 * @param exists 目录现存文件名集合（含未参与分配的其余文件与旧名本身）
 */
export function generateUniqueNames(
  oldNames: string[],
  t: FileAssignTemplate,
  exists: string[],
  rand: () => number = Math.random,
): string[] {
  const taken = new Set(exists.map((n) => n.toLowerCase()))
  const result: string[] = []
  for (const old of oldNames) {
    let chosen = ''
    for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
      const candidate = applyPosition(old, generateRandomString(t, rand), t.position)
      if (!taken.has(candidate.toLowerCase())) {
        chosen = candidate
        break
      }
    }
    if (!chosen) throw new Error(`为「${old}」生成唯一新名失败（尝试 ${MAX_GEN_ATTEMPTS} 次），请调整模板或字符集`)
    taken.add(chosen.toLowerCase())
    result.push(chosen)
  }
  return result
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/file-assign-name-template.test.ts`
Expected: PASS（12 个用例全绿）

- [ ] **Step 5: 验证类型与全量测试**

Run: `npm run typecheck` 与 `npm test`
Expected: 均通过

- [ ] **Step 6: Commit**

```powershell
git add src/tools/errors.ts src/tools/file-assign/types.ts src/tools/file-assign/name-template.ts tests/file-assign-name-template.test.ts
git commit -m "feat: 工具域类型/错误码与名称模板纯函数"
```

---

### Task 2: xlsx 读写封装

**Files:**
- Create: `src/tools/file-assign/xlsx.ts`
- Test: `tests/file-assign-xlsx.test.ts`

**Interfaces:**
- Consumes: 无（用 exceljs 直接读写，约定与 `src/infrastructure/datasource.ts` 一致：第一行表头、跳过完全空白行）
- Produces:
  - `readXlsxMeta(path: string): Promise<XlsxMeta>`，`XlsxMeta = { columns: string[]; rows: Array<{ rowNumber: number; window: string }> }`（任务 3/4 使用）
  - `writeCells(path: string, column: string, updates: Array<{ rowNumber: number; value: string }>): Promise<void>`（任务 4 使用）

- [ ] **Step 1: 写失败测试**

创建 `tests/file-assign-xlsx.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { readXlsxMeta, writeCells } from '../src/tools/file-assign/xlsx'

let dir: string
let xlsxPath: string

/** 建测试 xlsx：表头 5 列 + 3 个数据行 + 1 个完全空白行 */
async function makeXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '窗口', '邮箱', '图片地址', '文件地址'])
  ws.addRow(['01', '01', 'a@x.com', '', 'C:\\dir\\old1.png'])
  ws.addRow(['02', '02', 'b@x.com', '', 'C:\\dir\\old2.png'])
  ws.addRow(['', '', '', '', ''])
  ws.addRow(['03', '03', 'c@x.com', '', 'C:\\dir\\old3.png'])
  await wb.xlsx.writeFile(path)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'file-assign-xlsx-'))
  xlsxPath = join(dir, 'accounts.xlsx')
  await makeXlsx(xlsxPath)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readXlsxMeta', () => {
  it('返回列清单与非空数据行（跳过空白行）', async () => {
    const meta = await readXlsxMeta(xlsxPath)
    expect(meta.columns).toEqual(['窗口名称', '窗口', '邮箱', '图片地址', '文件地址'])
    expect(meta.rows).toHaveLength(3)
    expect(meta.rows[0]).toEqual({ rowNumber: 2, window: '01' })
    expect(meta.rows[2]).toEqual({ rowNumber: 5, window: '03' })
  })

  it('无窗口名称/窗口列时窗口标识兜底行号', async () => {
    const p2 = join(dir, 'no-win.xlsx')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('accounts')
    ws.addRow(['邮箱'])
    ws.addRow(['a@x.com'])
    await wb.xlsx.writeFile(p2)
    const meta = await readXlsxMeta(p2)
    expect(meta.rows[0]).toEqual({ rowNumber: 2, window: '第2行' })
  })
})

describe('writeCells', () => {
  it('只改目标列单元格，其他列不动', async () => {
    const p3 = join(dir, 'write.xlsx')
    await makeXlsx(p3)
    await writeCells(p3, '文件地址', [
      { rowNumber: 2, value: 'C:\\dir\\new1.png' },
      { rowNumber: 5, value: 'C:\\dir\\new3.png' },
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(p3)
    const ws = wb.worksheets[0]
    expect(ws.getRow(2).getCell(5).text).toBe('C:\\dir\\new1.png')
    expect(ws.getRow(2).getCell(1).text).toBe('01')
    expect(ws.getRow(3).getCell(5).text).toBe('C:\\dir\\old2.png')
    expect(ws.getRow(5).getCell(5).text).toBe('C:\\dir\\new3.png')
  })

  it('列不存在抛错', async () => {
    const p4 = join(dir, 'bad-col.xlsx')
    await makeXlsx(p4)
    await expect(writeCells(p4, '不存在的列', [{ rowNumber: 2, value: 'x' }])).rejects.toThrow(/找不到列/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/file-assign-xlsx.test.ts`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 写实现**

创建 `src/tools/file-assign/xlsx.ts`：

```ts
/**
 * 账号表读写（tools 层）：以 exceljs 直接读写 accounts.xlsx
 * 依赖方向：仅依赖 exceljs；读写约定与 infrastructure/datasource 一致（第一行表头、跳过完全空白行）
 */
import ExcelJS from 'exceljs'

/** 账号表元数据（tools 用）：列清单 + 非空数据行（行号 1 起） */
export interface XlsxMeta {
  columns: string[]
  rows: Array<{ rowNumber: number; window: string }>
}

/** 读取表头与数据行；窗口标识取「窗口名称」列，其次「窗口」列，兜底行号 */
export async function readXlsxMeta(path: string): Promise<XlsxMeta> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const sheet = wb.worksheets[0]
  if (!sheet) throw new Error('Excel 中没有工作表')
  const headerRow = sheet.getRow(1)
  const columns: string[] = []
  for (let i = 1; i <= headerRow.cellCount; i++) columns.push(String(headerRow.getCell(i).text ?? '').trim())
  while (columns.length > 0 && columns[columns.length - 1] === '') columns.pop()
  const winNameIdx = columns.indexOf('窗口名称') + 1
  const winIdx = columns.indexOf('窗口') + 1
  const rows: XlsxMeta['rows'] = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const text = (i: number) => String(row.getCell(i).text ?? '').trim()
    const hasValue = columns.some((_, i) => text(i + 1) !== '')
    if (!hasValue) return
    const window = (winNameIdx > 0 && text(winNameIdx)) || (winIdx > 0 && text(winIdx)) || `第${rowNumber}行`
    rows.push({ rowNumber, window })
  })
  return { columns, rows }
}

/** 把 updates 写入目标列对应行（其他单元格不动），写回原文件；列不存在抛错 */
export async function writeCells(
  path: string,
  column: string,
  updates: Array<{ rowNumber: number; value: string }>,
): Promise<void> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const sheet = wb.worksheets[0]
  if (!sheet) throw new Error('Excel 中没有工作表')
  const headerRow = sheet.getRow(1)
  let colIdx = -1
  for (let i = 1; i <= headerRow.cellCount; i++) {
    if (String(headerRow.getCell(i).text ?? '').trim() === column) {
      colIdx = i
      break
    }
  }
  if (colIdx < 0) throw new Error(`找不到列: ${column}`)
  for (const u of updates) sheet.getRow(u.rowNumber).getCell(colIdx).value = u.value
  await wb.xlsx.writeFile(path)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/file-assign-xlsx.test.ts`
Expected: PASS（4 个用例全绿）

- [ ] **Step 5: 验证类型与全量测试**

Run: `npm run typecheck` 与 `npm test`
Expected: 均通过

- [ ] **Step 6: Commit**

```powershell
git add src/tools/file-assign/xlsx.ts tests/file-assign-xlsx.test.ts
git commit -m "feat: 工具域 xlsx 读写封装"
```

---

### Task 3: 分配计划生成（planner）

**Files:**
- Create: `src/tools/file-assign/planner.ts`
- Test: `tests/file-assign-planner.test.ts`

**Interfaces:**
- Consumes:
  - 任务 1：`validateTemplate` / `generateUniqueNames`（`src/tools/file-assign/name-template`）、`ToolError` / `TOOL_ERROR_CODES`、`AssignPlan` / `FileAssignTemplate` 类型
  - 任务 2：`readXlsxMeta`（`src/tools/file-assign/xlsx`）
- Produces:
  - `shuffle<T>(arr: T[], rand?): T[]`（Fisher-Yates，返回新数组）
  - `preparePreview(p: PreparePreviewParams): Promise<AssignPlan>`，`PreparePreviewParams = { sourceDir: string; column: string; template: FileAssignTemplate; xlsxPath: string }`（任务 5 路由使用）

- [ ] **Step 1: 写失败测试**

创建 `tests/file-assign-planner.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { preparePreview, shuffle } from '../src/tools/file-assign/planner'
import type { FileAssignTemplate } from '../src/tools/file-assign/types'

let dir: string
let xlsxPath: string

const template: FileAssignTemplate = {
  english: { count: 2, caseMode: 'lower' },
  digits: null,
  special: null,
  position: { type: 'before' },
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'file-assign-planner-'))
  xlsxPath = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '文件地址'])
  ws.addRow(['01', ''])
  ws.addRow(['02', ''])
  ws.addRow(['03', ''])
  await wb.xlsx.writeFile(xlsxPath)
  writeFileSync(join(dir, 'a.png'), 'a')
  writeFileSync(join(dir, 'b.png'), 'b')
  writeFileSync(join(dir, 'c.png'), 'c')
  writeFileSync(join(dir, 'd.png'), 'd')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('shuffle', () => {
  it('返回新数组且长度一致', () => {
    const src = [1, 2, 3, 4, 5]
    const out = shuffle(src, () => 0.5)
    expect(out).toHaveLength(5)
    expect([...out].sort()).toEqual([...src].sort())
  })
})

describe('preparePreview', () => {
  it('生成计划：每行一个不重复文件、新名唯一、路径正确', async () => {
    const data = await preparePreview({ sourceDir: dir, column: '文件地址', template, xlsxPath })
    expect(data.accountsCount).toBe(3)
    expect(data.filesCount).toBe(4)
    expect(data.plan).toHaveLength(3)
    const oldNames = data.plan.map((r) => r.oldName)
    expect(new Set(oldNames).size).toBe(3)
    const newNames = data.plan.map((r) => r.newName)
    expect(new Set(newNames.map((n) => n.toLowerCase())).size).toBe(3)
    for (const row of data.plan) {
      expect(row.newPath).toBe(join(dir, row.newName))
      expect(row.oldName).toMatch(/\.png$/)
      expect(row.newName).not.toBe(row.oldName)
      expect(row.window).toMatch(/0[123]/)
    }
  })

  it('源文件夹不存在 → TOOL_DIR_NOT_FOUND', async () => {
    await expect(
      preparePreview({ sourceDir: join(dir, 'nope'), column: '文件地址', template, xlsxPath }),
    ).rejects.toMatchObject({ code: 40001 })
  })

  it('目标列不存在 → TOOL_COLUMN_NOT_FOUND', async () => {
    await expect(
      preparePreview({ sourceDir: dir, column: '不存在的列', template, xlsxPath }),
    ).rejects.toMatchObject({ code: 40002 })
  })

  it('文件不足 → TOOL_FILES_INSUFFICIENT', async () => {
    const smallDir = mkdtempSync(join(tmpdir(), 'fa-small-'))
    writeFileSync(join(smallDir, 'only.png'), 'x')
    await expect(
      preparePreview({ sourceDir: smallDir, column: '文件地址', template, xlsxPath }),
    ).rejects.toMatchObject({ code: 40003 })
    rmSync(smallDir, { recursive: true, force: true })
  })

  it('空模板 → TOOL_TEMPLATE_INVALID', async () => {
    const empty: FileAssignTemplate = { english: null, digits: null, special: null, position: { type: 'replace' } }
    await expect(
      preparePreview({ sourceDir: dir, column: '文件地址', template: empty, xlsxPath }),
    ).rejects.toMatchObject({ code: 40004 })
  })

  it('after-text 未命中 → TOOL_TEMPLATE_INVALID 且信息含文件名', async () => {
    const t: FileAssignTemplate = { ...template, position: { type: 'after-text', value: 'zzz' } }
    await expect(
      preparePreview({ sourceDir: dir, column: '文件地址', template: t, xlsxPath }),
    ).rejects.toMatchObject({ code: 40004 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/file-assign-planner.test.ts`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 写实现**

创建 `src/tools/file-assign/planner.ts`：

```ts
/**
 * 分配计划生成（tools 层）：读目录/读账号表 → 校验 → 洗牌 → 生成预览计划
 * 依赖方向：依赖 ./name-template ./xlsx ./errors；被 server 路由调用
 * 设计思路：纯编排（fs 读取在此层，写操作在 applier）；校验失败抛 ToolError 由路由映射统一响应
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AssignPlan, FileAssignTemplate } from './types'
import { generateUniqueNames, validateTemplate } from './name-template'
import { readXlsxMeta } from './xlsx'
import { ToolError, TOOL_ERROR_CODES } from '../errors'

/** Fisher-Yates 洗牌（返回新数组，不动原数组） */
export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface PreparePreviewParams {
  sourceDir: string
  column: string
  template: FileAssignTemplate
  xlsxPath: string
}

/** 生成分配预览计划（不落盘）：目录/列/数量/模板校验 + 洗牌取文件 + 唯一名生成 */
export async function preparePreview(p: PreparePreviewParams): Promise<AssignPlan> {
  if (!p.sourceDir) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_DIR_NOT_FOUND, '源文件夹不能为空')
  if (!p.column) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_COLUMN_NOT_FOUND, '目标列不能为空')
  if (!p.template) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_TEMPLATE_INVALID, '名称模板不能为空')
  const dir = resolve(p.sourceDir)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ToolError(400, TOOL_ERROR_CODES.TOOL_DIR_NOT_FOUND, `源文件夹不存在或不是目录: ${p.sourceDir}`)
  }
  const templateErr = validateTemplate(p.template)
  if (templateErr) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_TEMPLATE_INVALID, templateErr)
  const meta = await readXlsxMeta(p.xlsxPath)
  if (!meta.columns.includes(p.column)) {
    throw new ToolError(400, TOOL_ERROR_CODES.TOOL_COLUMN_NOT_FOUND, `目标列「${p.column}」不存在（现有列: ${meta.columns.join(', ')}）`)
  }
  if (meta.rows.length === 0) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_FILES_INSUFFICIENT, '账号表没有数据行')
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    // accounts.xlsx 若在源文件夹内绝不能被选中改名，否则会毁掉账号表
    .filter((name) => resolve(join(dir, name)) !== resolve(p.xlsxPath))
  if (files.length < meta.rows.length) {
    throw new ToolError(400, TOOL_ERROR_CODES.TOOL_FILES_INSUFFICIENT, `文件不足：需要 ${meta.rows.length} 个，实际 ${files.length} 个`)
  }
  const picked = shuffle(files).slice(0, meta.rows.length)
  let newNames: string[]
  try {
    newNames = generateUniqueNames(picked, p.template, files)
  } catch (e) {
    throw new ToolError(400, TOOL_ERROR_CODES.TOOL_TEMPLATE_INVALID, (e as Error).message)
  }
  const plan = meta.rows.map((r, i) => ({
    rowNumber: r.rowNumber,
    window: r.window,
    oldName: picked[i],
    newName: newNames[i],
    newPath: join(dir, newNames[i]),
  }))
  return { accountsCount: meta.rows.length, filesCount: files.length, plan }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/file-assign-planner.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: 验证类型与全量测试**

Run: `npm run typecheck` 与 `npm test`
Expected: 均通过

- [ ] **Step 6: Commit**

```powershell
git add src/tools/file-assign/planner.ts tests/file-assign-planner.test.ts
git commit -m "feat: 工具域分配计划生成（预览）"
```

---

### Task 4: 分配执行服务（applier）

**Files:**
- Create: `src/tools/file-assign/applier.ts`
- Test: `tests/file-assign-applier.test.ts`

**Interfaces:**
- Consumes:
  - 任务 1：`ToolError` / `TOOL_ERROR_CODES`、`ApplyParams` / `ApplyResult` / `AssignRow` 类型
  - 任务 2：`readXlsxMeta` / `writeCells` / `XlsxMeta`（`src/tools/file-assign/xlsx`）
- Produces:
  - `FileAssignIo` 接口与 `defaultIo`（node:fs 真盘实现）
  - `class FileAssignService`：`constructor(io: FileAssignIo = defaultIo)`、`get isBusy(): boolean`、`apply(params: ApplyParams): Promise<ApplyResult>`（任务 5 路由使用）

- [ ] **Step 1: 写失败测试**

创建 `tests/file-assign-applier.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { FileAssignService } from '../src/tools/file-assign/applier'
import type { AssignRow } from '../src/tools/file-assign/types'

const dirs: string[] = []

/** 每个用例独立临时目录：目录含 a/b/c 三个文件 + 两行账号 xlsx */
async function setup(): Promise<{ dir: string; xlsxPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'file-assign-applier-'))
  dirs.push(dir)
  const xlsxPath = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '文件地址'])
  ws.addRow(['01', ''])
  ws.addRow(['02', ''])
  await wb.xlsx.writeFile(xlsxPath)
  writeFileSync(join(dir, 'a.png'), 'a')
  writeFileSync(join(dir, 'b.png'), 'b')
  writeFileSync(join(dir, 'c.png'), 'c')
  return { dir, xlsxPath }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function row(dir: string, rowNumber: number, oldName: string, newName: string): AssignRow {
  return { rowNumber, window: '01', oldName, newName, newPath: join(dir, newName) }
}

describe('FileAssignService.apply', () => {
  it('校验通过：改名落盘 + xlsx 写回 + 返回计数', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    const result = await svc.apply({
      sourceDir: dir,
      column: '文件地址',
      xlsxPath,
      plan: [row(dir, 2, 'a.png', 'new-a.png'), row(dir, 3, 'b.png', 'new-b.png')],
    })
    expect(result).toEqual({ renamedCount: 2, updatedRows: 2 })
    expect(existsSync(join(dir, 'new-a.png'))).toBe(true)
    expect(existsSync(join(dir, 'a.png'))).toBe(false)
    expect(existsSync(join(dir, 'c.png'))).toBe(true)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(xlsxPath)
    const ws = wb.worksheets[0]
    expect(ws.getRow(2).getCell(2).text).toBe(join(dir, 'new-a.png'))
    expect(ws.getRow(3).getCell(2).text).toBe(join(dir, 'new-b.png'))
  })

  it('计划行数与账号行数不一致 → TOOL_PLAN_INVALID', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    await expect(
      svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan: [row(dir, 2, 'c.png', 'new-c.png')] }),
    ).rejects.toMatchObject({ code: 40005 })
    expect(existsSync(join(dir, 'c.png'))).toBe(true)
  })

  it('计划中文件已不存在 → TOOL_PLAN_INVALID', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    await expect(
      svc.apply({
        sourceDir: dir,
        column: '文件地址',
        xlsxPath,
        plan: [row(dir, 2, 'gone.png', 'x.png'), row(dir, 3, 'c.png', 'y.png')],
      }),
    ).rejects.toMatchObject({ code: 40005 })
  })

  it('新名与现存文件冲突 → TOOL_PLAN_INVALID', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService()
    await expect(
      svc.apply({
        sourceDir: dir,
        column: '文件地址',
        xlsxPath,
        plan: [row(dir, 2, 'a.png', 'b.png'), row(dir, 3, 'c.png', 'z.png')],
      }),
    ).rejects.toMatchObject({ code: 40005 })
  })

  it('执行中再次调用 → TOOL_BUSY', async () => {
    const { dir, xlsxPath } = await setup()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const svc = new FileAssignService({
      renameFile: async () => { await gate },
      writeXlsx: async () => {},
      readXlsx: async () => ({
        columns: ['窗口名称', '文件地址'],
        rows: [{ rowNumber: 2, window: '01' }, { rowNumber: 3, window: '02' }],
      }),
      readDirFiles: async () => ['a.png', 'b.png'],
      existsDir: () => true,
    })
    const p1 = svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan: [row(dir, 2, 'a.png', 'x.png'), row(dir, 3, 'b.png', 'y.png')] })
    await expect(svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan: [row(dir, 2, 'a.png', 'x.png'), row(dir, 3, 'b.png', 'y.png')] })).rejects.toMatchObject({ code: 40904 })
    release()
    await expect(p1).resolves.toEqual({ renamedCount: 2, updatedRows: 2 })
  })

  it('改名中途失败 → TOOL_IO_FAILED 且错误信息附已改名清单', async () => {
    const { dir, xlsxPath } = await setup()
    const svc = new FileAssignService({
      renameFile: async (from) => {
        if (from.endsWith('b.png')) throw new Error('磁盘错误')
      },
      writeXlsx: async () => {},
      readXlsx: async () => ({
        columns: ['窗口名称', '文件地址'],
        rows: [{ rowNumber: 2, window: '01' }, { rowNumber: 3, window: '02' }],
      }),
      readDirFiles: async () => ['a.png', 'b.png'],
      existsDir: () => true,
    })
    await expect(
      svc.apply({ sourceDir: dir, column: '文件地址', xlsxPath, plan: [row(dir, 2, 'a.png', 'x.png'), row(dir, 3, 'b.png', 'y.png')] }),
    ).rejects.toMatchObject({ code: 50001 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/file-assign-applier.test.ts`
Expected: FAIL（Cannot find module）

- [ ] **Step 3: 写实现**

创建 `src/tools/file-assign/applier.ts`：

```ts
/**
 * 分配执行（tools 层）：校验回传计划 → 逐个重命名 → 写回 xlsx；带进程内执行锁
 * 依赖方向：依赖 ./xlsx ./errors ./types；IO 经构造注入（默认实现走 node:fs 真盘，测试可替换）
 * 设计思路：apply 是破坏性操作，先全量校验再动手；写盘失败不回滚改名，错误信息附已改名清单
 */
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ApplyParams, ApplyResult } from './types'
import { readXlsxMeta, writeCells, type XlsxMeta } from './xlsx'
import { ToolError, TOOL_ERROR_CODES } from '../errors'

/** 可注入 IO 面：真实实现走本机磁盘，测试替换以验证锁/失败路径 */
export interface FileAssignIo {
  renameFile(from: string, to: string): Promise<void>
  writeXlsx(path: string, column: string, updates: Array<{ rowNumber: number; value: string }>): Promise<void>
  readXlsx(path: string): Promise<XlsxMeta>
  readDirFiles(dir: string): Promise<string[]>
  existsDir(dir: string): boolean
}

/** 默认 IO：node:fs + exceljs 真盘实现 */
export const defaultIo: FileAssignIo = {
  renameFile: async (from, to) => {
    renameSync(from, to)
  },
  writeXlsx: writeCells,
  readXlsx: readXlsxMeta,
  readDirFiles: async (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name),
  existsDir: (dir) => existsSync(dir) && statSync(dir).isDirectory(),
}

export class FileAssignService {
  private busy = false

  constructor(private io: FileAssignIo = defaultIo) {}

  /** 是否正在执行（进程内单服务实例，面板并发点击靠它拦截） */
  get isBusy(): boolean {
    return this.busy
  }

  async apply(params: ApplyParams): Promise<ApplyResult> {
    if (this.busy) throw new ToolError(409, TOOL_ERROR_CODES.TOOL_BUSY, '上一次分配正在执行，请稍候')
    this.busy = true
    try {
      return await this.applyInner(params)
    } finally {
      this.busy = false
    }
  }

  private async applyInner(params: ApplyParams): Promise<ApplyResult> {
    if (!params.sourceDir || !params.column || !Array.isArray(params.plan) || params.plan.length === 0) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, '参数不完整（源文件夹/目标列/计划）')
    }
    const dir = resolve(params.sourceDir)
    if (!this.io.existsDir(dir)) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_DIR_NOT_FOUND, `源文件夹不存在或不是目录: ${params.sourceDir}`)
    }
    const meta = await this.io.readXlsx(params.xlsxPath)
    if (!meta.columns.includes(params.column)) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_COLUMN_NOT_FOUND, `目标列「${params.column}」不存在`)
    }
    if (meta.rows.length !== params.plan.length) {
      throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `计划与账号行数不一致（计划 ${params.plan.length} 行，账号 ${meta.rows.length} 行），请重新生成预览`)
    }
    const existing = new Set((await this.io.readDirFiles(dir)).map((n) => n.toLowerCase()))
    const newLower = new Set<string>()
    for (const row of params.plan) {
      if (!existing.has(row.oldName.toLowerCase())) {
        throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `文件已不存在: ${row.oldName}（源文件夹有变动，请重新生成预览）`)
      }
      const lower = row.newName.toLowerCase()
      if (existing.has(lower) && lower !== row.oldName.toLowerCase()) {
        throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `新文件名与现存文件冲突: ${row.newName}`)
      }
      if (newLower.has(lower)) throw new ToolError(400, TOOL_ERROR_CODES.TOOL_PLAN_INVALID, `计划中新文件名重复: ${row.newName}`)
      newLower.add(lower)
    }
    // 校验全部通过后执行改名：中途失败不回滚，错误信息附已改名清单
    const renamed: string[] = []
    for (const row of params.plan) {
      try {
        await this.io.renameFile(join(dir, row.oldName), join(dir, row.newName))
        renamed.push(row.oldName)
      } catch (e) {
        throw new ToolError(500, TOOL_ERROR_CODES.TOOL_IO_FAILED, `重命名失败（${(e as Error).message}）；已改名的文件: ${renamed.join(', ') || '无'}`)
      }
    }
    try {
      await this.io.writeXlsx(
        params.xlsxPath,
        params.column,
        params.plan.map((r) => ({ rowNumber: r.rowNumber, value: r.newPath })),
      )
    } catch (e) {
      throw new ToolError(500, TOOL_ERROR_CODES.TOOL_IO_FAILED, `写回 accounts.xlsx 失败（${(e as Error).message}）；文件已改名: ${renamed.join(', ') || '无'}`)
    }
    return { renamedCount: params.plan.length, updatedRows: params.plan.length }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/file-assign-applier.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: 验证类型与全量测试**

Run: `npm run typecheck` 与 `npm test`
Expected: 均通过

- [ ] **Step 6: Commit**

```powershell
git add src/tools/file-assign/applier.ts tests/file-assign-applier.test.ts
git commit -m "feat: 工具域分配执行服务（校验/改名/写回/执行锁）"
```

---

### Task 5: 工具注册表、路由与装配

**Files:**
- Create: `src/tools/index.ts`
- Create: `src/server/routes/tools.ts`
- Modify: `src/server/http/errors.ts`（追加工具错误码）
- Modify: `src/server/app.ts`（挂载 toolsRouter）
- Test: `tests/tools-route.test.ts`

**Interfaces:**
- Consumes:
  - 任务 1：`TOOL_ERROR_CODES` / `ToolError`、`FileAssignTemplate` / `AssignRow` 类型
  - 任务 3：`preparePreview`
  - 任务 4：`FileAssignService`
  - 既有：`ok` / `fail` / `asyncHandler`（`src/server/http/response.ts`）、`ERROR_CODES`（`src/server/http/errors.ts`）
- Produces:
  - `TOOLS: ToolMeta[]`（`{ key, name, description }`，任务 7 前端渲染用）
  - `toolsRouter(deps: { xlsxPath: string; datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void> } }): Router`
  - 接口：`GET /api/tools`、`POST /api/tools/file-assign/preview`、`POST /api/tools/file-assign/apply`

- [ ] **Step 1: 写失败测试**

创建 `tests/tools-route.test.ts`：

```ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { toolsRouter } from '../src/server/routes/tools'
import { errorHandler } from '../src/server/http/error'
import type { Logger } from '../src/infrastructure/logger'

let dir: string
let xlsxPath: string

function makeApp(xlsxPath: string) {
  const app = express()
  app.use(express.json())
  const reload = vi.fn().mockResolvedValue(undefined)
  const summary = vi.fn().mockReturnValue({ rows: 2, columns: ['窗口名称', '文件地址'] })
  // 与真实装配一致：路由定义无 /api 前缀，挂载在 /api 下（app.ts 的 api router 同构）
  app.use('/api', toolsRouter({ xlsxPath, datasource: { reload, summary } }))
  app.use(errorHandler({ error: () => {}, warn: () => {}, info: () => {} } as unknown as Logger))
  return { app, reload, summary }
}

const template = {
  english: { count: 2, caseMode: 'lower' },
  digits: null,
  special: null,
  position: { type: 'before' },
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tools-route-'))
  xlsxPath = join(dir, 'accounts.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('accounts')
  ws.addRow(['窗口名称', '文件地址'])
  ws.addRow(['01', ''])
  ws.addRow(['02', ''])
  await wb.xlsx.writeFile(xlsxPath)
  writeFileSync(join(dir, 'a.png'), 'a')
  writeFileSync(join(dir, 'b.png'), 'b')
  writeFileSync(join(dir, 'c.png'), 'c')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/tools', () => {
  it('返回工具清单', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app).get('/api/tools')
    expect(res.body.code).toBe(0)
    expect(res.body.data.tools).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'file-assign', name: '文件随机分配' })]))
  })
})

describe('POST /api/tools/file-assign/preview', () => {
  it('正常生成预览计划', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app)
      .post('/api/tools/file-assign/preview')
      .send({ sourceDir: dir, column: '文件地址', template })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.accountsCount).toBe(2)
    expect(res.body.data.filesCount).toBe(3)
    expect(res.body.data.plan).toHaveLength(2)
    for (const row of res.body.data.plan) {
      expect(typeof row.rowNumber).toBe('number')
      expect(typeof row.oldName).toBe('string')
      expect(typeof row.newName).toBe('string')
      expect(row.newPath.startsWith(dir)).toBe(true)
    }
  })

  it('源文件夹不存在 → 400/40001', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app)
      .post('/api/tools/file-assign/preview')
      .send({ sourceDir: join(dir, 'nope'), column: '文件地址', template })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40001)
  })

  it('参数缺失 → 400/40000', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app).post('/api/tools/file-assign/preview').send({ sourceDir: dir })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40000)
  })
})

describe('POST /api/tools/file-assign/apply', () => {
  it('执行成功：改名 + 写回 + 数据源重载', async () => {
    const { app, reload, summary } = makeApp(xlsxPath)
    const prev = await request(app)
      .post('/api/tools/file-assign/preview')
      .send({ sourceDir: dir, column: '文件地址', template })
    const plan = prev.body.data.plan
    const res = await request(app)
      .post('/api/tools/file-assign/apply')
      .send({ sourceDir: dir, column: '文件地址', plan })
    expect(res.status).toBe(200)
    expect(res.body.code).toBe(0)
    expect(res.body.data.renamedCount).toBe(2)
    expect(res.body.data.updatedRows).toBe(2)
    expect(res.body.data.reloadedRows).toBe(2)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(summary).toHaveBeenCalled()
    for (const row of plan) {
      const { existsSync } = await import('node:fs')
      expect(existsSync(row.newPath)).toBe(true)
    }
  })

  it('计划行数不一致 → 400/40005', async () => {
    const { app } = makeApp(xlsxPath)
    const res = await request(app)
      .post('/api/tools/file-assign/apply')
      .send({ sourceDir: dir, column: '文件地址', plan: [{ rowNumber: 2, window: '01', oldName: 'a.png', newName: 'x.png', newPath: join(dir, 'x.png') }] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe(40005)
  })
})
```

注意：该测试在「执行成功」用例里改名了真实临时目录中的文件；该用例必须放在本文件最后执行（vitest 同文件内按声明顺序串行），apply 的「计划行数不一致」用例不依赖文件名状态，放在其后依然通过。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools-route.test.ts`
Expected: FAIL（Cannot find module `../src/server/routes/tools`）

- [ ] **Step 3: 追加服务端错误码**

修改 `src/server/http/errors.ts`，在 `ERROR_CODES` 中追加（与 `src/tools/errors.ts` 数值一致）：

```ts
export const ERROR_CODES = {
  INVALID_ARGUMENT: 40000,
  // 工具域错误码（与 src/tools/errors.ts 的 TOOL_ERROR_CODES 数值一致）
  TOOL_DIR_NOT_FOUND: 40001,
  TOOL_COLUMN_NOT_FOUND: 40002,
  TOOL_FILES_INSUFFICIENT: 40003,
  TOOL_TEMPLATE_INVALID: 40004,
  TOOL_PLAN_INVALID: 40005,
  GENERIC_NOT_FOUND: 40400,
  TASK_NOT_FOUND: 40401,
  PROFILE_NOT_FOUND: 40402,
  SCREENSHOT_NOT_FOUND: 40403,
  DOCS_NOT_FOUND: 40404,
  BATCH_NOT_FOUND: 40405,
  SCHEDULE_NOT_FOUND: 40406,
  TASK_DISABLED: 40901,
  TASK_RUNNING: 40902,
  SCHEDULE_DISABLED: 40903,
  TOOL_BUSY: 40904,
  INTERNAL: 50000,
  TOOL_IO_FAILED: 50001,
} as const
```

- [ ] **Step 4: 写工具注册表**

创建 `src/tools/index.ts`：

```ts
/**
 * 工具注册表（tools 层）：面板工具中心的数据源
 * 依赖方向：无依赖，被 server 路由引用；新增工具在此登记，前端卡片按 key 扩展
 */
export interface ToolMeta {
  key: string
  name: string
  description: string
}

export const TOOLS: ToolMeta[] = [
  {
    key: 'file-assign',
    name: '文件随机分配',
    description: '按名称模板重命名指定文件夹内的文件，随机分配给 accounts.xlsx 各账号行并写回目标列',
  },
]
```

- [ ] **Step 5: 写工具路由**

创建 `src/server/routes/tools.ts`：

```ts
/**
 * 工具路由（server 层）：工具清单 + 文件随机分配的预览/执行
 * 依赖方向：server → tools（注册表/planner/applier）；ToolError 在此映射为统一响应
 */
import { Router } from 'express'
import { ok, fail, asyncHandler } from '../http/response'
import { ERROR_CODES } from '../http/errors'
import { TOOLS } from '../../tools'
import { preparePreview } from '../../tools/file-assign/planner'
import { FileAssignService } from '../../tools/file-assign/applier'
import { ToolError } from '../../tools/errors'
import type { AssignRow, FileAssignTemplate } from '../../tools/file-assign/types'

/** 进程内单实例：FileAssignService 的执行锁跨请求生效（面板并发点击靠它拦截） */
const service = new FileAssignService()

/**
 * @swagger
 * /api/tools:
 *   get:
 *     summary: 工具清单（面板工具中心卡片数据源）
 *     responses:
 *       '200':
 *         description: 工具列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tools:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key: { type: string }
 *                           name: { type: string }
 *                           description: { type: string }
 */

/**
 * @swagger
 * /api/tools/file-assign/preview:
 *   post:
 *     summary: 文件随机分配预览（校验并生成分配计划，不落盘）
 *     responses:
 *       '200':
 *         description: 分配计划
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     accountsCount: { type: integer }
 *                     filesCount: { type: integer }
 *                     plan:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           rowNumber: { type: integer }
 *                           window: { type: string }
 *                           oldName: { type: string }
 *                           newName: { type: string }
 *                           newPath: { type: string }
 */

/**
 * @swagger
 * /api/tools/file-assign/apply:
 *   post:
 *     summary: 文件随机分配执行（按预览回传计划改名并写回 xlsx）
 *     responses:
 *       '200':
 *         description: 执行结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: integer, example: 0 }
 *                 message: { type: string, example: ok }
 *                 data:
 *                   type: object
 *                   properties:
 *                     renamedCount: { type: integer }
 *                     updatedRows: { type: integer }
 *                     reloadedRows: { type: integer }
 */

export function toolsRouter(deps: {
  xlsxPath: string
  datasource: { summary(): { rows: number; columns: string[] }; reload(): Promise<void> }
}): Router {
  const router = Router()

  router.get('/tools', (req, res) => {
    ok(res, { tools: TOOLS })
  })

  router.post('/tools/file-assign/preview', asyncHandler(async (req, res) => {
    const body = req.body as { sourceDir?: unknown; column?: unknown; template?: unknown }
    if (typeof body?.sourceDir !== 'string' || typeof body?.column !== 'string' || typeof body?.template !== 'object' || body.template === null) {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '参数格式错误（sourceDir/column/template）')
      return
    }
    try {
      const data = await preparePreview({
        sourceDir: body.sourceDir,
        column: body.column,
        template: body.template as FileAssignTemplate,
        xlsxPath: deps.xlsxPath,
      })
      ok(res, data)
    } catch (e) {
      if (e instanceof ToolError) {
        fail(res, e.status, e.code, e.message)
        return
      }
      throw e
    }
  }))

  router.post('/tools/file-assign/apply', asyncHandler(async (req, res) => {
    const body = req.body as { sourceDir?: unknown; column?: unknown; plan?: unknown }
    if (typeof body?.sourceDir !== 'string' || typeof body?.column !== 'string' || !Array.isArray(body?.plan)) {
      fail(res, 400, ERROR_CODES.INVALID_ARGUMENT, '参数格式错误（sourceDir/column/plan）')
      return
    }
    try {
      const result = await service.apply({
        sourceDir: body.sourceDir,
        column: body.column,
        plan: body.plan as AssignRow[],
        xlsxPath: deps.xlsxPath,
      })
      await deps.datasource.reload()
      ok(res, { ...result, reloadedRows: deps.datasource.summary().rows })
    } catch (e) {
      if (e instanceof ToolError) {
        fail(res, e.status, e.code, e.message)
        return
      }
      throw e
    }
  }))

  return router
}
```

- [ ] **Step 6: 挂载路由**

修改 `src/server/app.ts`：
- import 区（第 28 行 `settingsRouter` 之后）加一行：

```ts
import { toolsRouter } from './routes/tools'
```

- 挂载区（第 74 行 `settingsRouter` 挂载之后）加一行：

```ts
  api.use(toolsRouter({ xlsxPath: deps.cfg.dataSource.path, datasource: deps.datasource }))
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/tools-route.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 8: 验证类型与全量测试**

Run: `npm run typecheck` 与 `npm test`
Expected: 均通过（既有 web.test.ts 等不受影响）

- [ ] **Step 9: Commit**

```powershell
git add src/tools/index.ts src/server/routes/tools.ts src/server/http/errors.ts src/server/app.ts tests/tools-route.test.ts
git commit -m "feat: 工具清单与文件随机分配路由（预览/执行）"
```

---

### Task 6: 前端 API 层（types + endpoints）

**Files:**
- Modify: `web/src/types.ts`（追加工具相关类型，手补先例）
- Modify: `web/src/api/endpoints.ts`（追加 3 个具名请求函数）

**Interfaces:**
- Consumes: 任务 5 的接口响应结构（envelope data）
- Produces:
  - 类型：`ToolItem`、`EnglishCase`、`PositionType`、`FileAssignTemplate`、`FileAssignRow`、`FileAssignPreview`、`FileAssignApplyResult`（任务 7 使用）
  - 函数：`fetchTools(): Promise<{ tools: ToolItem[] }>`、`previewFileAssign(body: { sourceDir: string; column: string; template: FileAssignTemplate }): Promise<FileAssignPreview>`、`applyFileAssign(body: { sourceDir: string; column: string; plan: FileAssignRow[] }): Promise<FileAssignApplyResult>`（任务 7 使用）

- [ ] **Step 1: 追加前端类型**

修改 `web/src/types.ts`，在文件末尾追加：

```ts
// ===== 工具中心（手补类型：/api/tools 与 /api/tools/file-assign/*） =====

export type ToolItem = { key: string; name: string; description: string }

export type EnglishCase = 'lower' | 'upper' | 'mixed'

export type PositionType = 'replace' | 'before' | 'after' | 'after-position' | 'after-text'

/** 名称模板（与后端 src/tools/file-assign/types.ts 的 FileAssignTemplate 同构） */
export interface FileAssignTemplate {
  english: { count: number; caseMode: EnglishCase } | null
  digits: { count: number } | null
  special: { count: number; charset: string } | null
  position: { type: PositionType; value?: string | number }
}

export interface FileAssignRow {
  rowNumber: number
  window: string
  oldName: string
  newName: string
  newPath: string
}

export interface FileAssignPreview {
  accountsCount: number
  filesCount: number
  plan: FileAssignRow[]
}

export interface FileAssignApplyResult {
  renamedCount: number
  updatedRows: number
  reloadedRows: number
}
```

- [ ] **Step 2: 追加 endpoints**

修改 `web/src/api/endpoints.ts`：
- import 行改为：

```ts
import type { BatchesData, BatchDetailData, TaskMetaView, ProfileRow, SettingsData, DatasourceInfo, ScheduleItem, ScheduleConfigInput, ToolItem, FileAssignTemplate, FileAssignRow, FileAssignPreview, FileAssignApplyResult } from '../types'
```

- 文件末尾追加：

```ts
// ===== 工具中心 =====
export const fetchTools = () => get<{ tools: ToolItem[] }>('/api/tools')
export const previewFileAssign = (body: { sourceDir: string; column: string; template: FileAssignTemplate }) => post<FileAssignPreview>('/api/tools/file-assign/preview', body)
export const applyFileAssign = (body: { sourceDir: string; column: string; plan: FileAssignRow[] }) => post<FileAssignApplyResult>('/api/tools/file-assign/apply', body)
```

- [ ] **Step 3: 验证类型**

Run: `npx tsc -b`（workdir 为 `web`）
Expected: 通过

- [ ] **Step 4: Commit**

```powershell
git add web/src/types.ts web/src/api/endpoints.ts
git commit -m "feat: 前端工具 API 类型与请求函数"
```

---

### Task 7: 前端工具中心页与文件分配面板

**Files:**
- Create: `web/src/pages/tools/hooks.ts`
- Create: `web/src/pages/tools/index.tsx`
- Create: `web/src/pages/tools/file-assign.tsx`
- Test: `web/src/pages/tools/hooks.test.tsx`
- Modify: `web/src/App.tsx`（加路由）
- Modify: `web/src/layouts/AppLayout.tsx`（加菜单项）

**Interfaces:**
- Consumes:
  - 任务 6：`fetchTools` / `previewFileAssign` / `applyFileAssign`、类型 `ToolItem` / `FileAssignTemplate` / `FileAssignRow` / `FileAssignPreview` / `FileAssignApplyResult` / `EnglishCase` / `PositionType`
  - 既有：`client.ts` 的 `HttpError`、`pages/settings` 的页面/hooks 模式、`AppLayout` 菜单、`App.tsx` 路由
- Produces:
  - hooks：`useTools()`、`useFileAssignPreview()`、`useFileAssignApply()`、`buildTemplate(form): { template } | { error }`、`sampleName(oldName, template, rand?)`
  - 页面：`ToolsPage`（default export）、`FileAssignPanel`（default export）

- [ ] **Step 1: 写 hooks 失败测试**

创建 `web/src/pages/tools/hooks.test.tsx`：

```tsx
import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from 'antd'
import { buildTemplate, sampleName, useFileAssignApply } from './hooks'
import type { FileAssignTemplate } from '../../types'

vi.mock('../../api/endpoints', () => ({
  applyFileAssign: vi.fn().mockResolvedValue({ renamedCount: 2, updatedRows: 2, reloadedRows: 2 }),
}))

const fixed = () => 0

describe('buildTemplate', () => {
  it('组件全空 → 报错', () => {
    const r = buildTemplate({ english: false, englishCount: 4, caseMode: 'lower', digits: false, digitsCount: 3, special: false, specialCount: 2, charset: '!@', position: 'replace', positionValue: '' })
    expect('error' in r).toBe(true)
  })

  it('after-position 非法 → 报错', () => {
    const r = buildTemplate({ english: true, englishCount: 2, caseMode: 'lower', digits: false, digitsCount: 3, special: false, specialCount: 2, charset: '!@', position: 'after-position', positionValue: '0' })
    expect('error' in r).toBe(true)
  })

  it('合法表单 → 模板对象（positionValue 转数字）', () => {
    const r = buildTemplate({ english: true, englishCount: 2, caseMode: 'mixed', digits: false, digitsCount: 3, special: false, specialCount: 2, charset: '!@', position: 'after-position', positionValue: '3' })
    expect(r).toEqual({
      template: {
        english: { count: 2, caseMode: 'mixed' },
        digits: null,
        special: null,
        position: { type: 'after-position', value: 3 },
      },
    })
  })
})

describe('sampleName', () => {
  const t: FileAssignTemplate = { english: { count: 2, caseMode: 'lower' }, digits: null, special: null, position: { type: 'before' } }

  it('before：生成串在前，保留扩展名', () => {
    expect(sampleName('a.png', t, fixed)).toBe('aaa.png')
  })

  it('replace：替换 stem', () => {
    expect(sampleName('a.png', { ...t, position: { type: 'replace' } }, fixed)).toBe('aa.png')
  })

  it('after-position：第 N 字符后插入', () => {
    expect(sampleName('abcd.png', { ...t, position: { type: 'after-position', value: 2 } }, fixed)).toBe('abaacd.png')
  })

  it('after-text：文本后插入；未找到放末尾', () => {
    expect(sampleName('file2024x.png', { ...t, position: { type: 'after-text', value: '2024' } }, fixed)).toBe('file2024aax.png')
    expect(sampleName('abcd.png', { ...t, position: { type: 'after-text', value: 'zzz' } }, fixed)).toBe('abcdaa.png')
  })
})

describe('useFileAssignApply', () => {
  it('成功后提示并失效 settings 查询', async () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useFileAssignApply(), {
      wrapper: ({ children }) => (
        <App>
          <QueryClientProvider client={qc}>{children}</QueryClientProvider>
        </App>
      ),
    })
    result.current.mutate({ sourceDir: 'D:/x', column: '文件地址', plan: [] })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:web`（workdir 项目根）
Expected: FAIL（Cannot find module `./hooks`）

- [ ] **Step 3: 写 hooks**

创建 `web/src/pages/tools/hooks.ts`：

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App } from 'antd'
import { applyFileAssign, fetchTools, previewFileAssign } from '../../api/endpoints'
import { HttpError } from '../../api/client'
import type { EnglishCase, FileAssignTemplate, FileAssignRow, PositionType } from '../../types'

const errMsg = (e: unknown) => (e instanceof HttpError ? e.message : '操作失败，请重试')

/** 工具清单（工具中心卡片数据源） */
export function useTools() {
  return useQuery({ queryKey: ['tools'], queryFn: fetchTools })
}

/** 文件随机分配预览 */
export function useFileAssignPreview() {
  const { message } = App.useApp()
  return useMutation({
    mutationFn: (body: { sourceDir: string; column: string; template: FileAssignTemplate }) => previewFileAssign(body),
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 文件随机分配执行（成功后失效 settings，让数据源状态刷新） */
export function useFileAssignApply() {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { sourceDir: string; column: string; plan: FileAssignRow[] }) => applyFileAssign(body),
    onSuccess: (res) => {
      message.success(`已重命名 ${res.renamedCount} 个文件，写回 ${res.updatedRows} 行，数据源已重载（${res.reloadedRows} 行）`)
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (e) => message.error(errMsg(e)),
  })
}

/** 面板表单状态（与 file-assign.tsx 的表单字段一一对应） */
export interface TemplateForm {
  english: boolean
  englishCount: number
  caseMode: EnglishCase
  digits: boolean
  digitsCount: number
  special: boolean
  specialCount: number
  charset: string
  position: PositionType
  positionValue: string
}

/** 表单 → 模板对象；校验失败返回 error 文案 */
export function buildTemplate(form: TemplateForm): { template: FileAssignTemplate } | { error: string } {
  const template: FileAssignTemplate = {
    english: form.english ? { count: Math.floor(form.englishCount), caseMode: form.caseMode } : null,
    digits: form.digits ? { count: Math.floor(form.digitsCount) } : null,
    special: form.special ? { count: Math.floor(form.specialCount), charset: form.charset.trim() } : null,
    position: { type: form.position },
  }
  if (form.position === 'after-position') {
    const n = Number(form.positionValue)
    if (!Number.isInteger(n) || n < 1) return { error: '指定位置需为不小于 1 的整数' }
    template.position.value = n
  }
  if (form.position === 'after-text') {
    const text = form.positionValue.trim()
    if (!text) return { error: '指定文本不能为空' }
    template.position.value = text
  }
  if (![template.english, template.digits, template.special].some((c) => c && c.count > 0)) return { error: '至少勾选一个生成组件（英文/数字/特殊字符）' }
  for (const c of [template.english, template.digits, template.special]) {
    if (c && (c.count < 1 || c.count > 20)) return { error: '组件个数需在 1-20 之间' }
  }
  return { template }
}

/** 示例名（纯展示）：与后端同规则的轻量实现；after-text 未命中时生成串放末尾 */
export function sampleName(oldName: string, template: FileAssignTemplate, rand: () => number = Math.random): string {
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const pools = { lower, upper: lower.toUpperCase(), mixed: lower + lower.toUpperCase() }
  const pick = (pool: string, count: number) => Array.from({ length: count }, () => pool[Math.floor(rand() * pool.length)]).join('')
  let gen = ''
  if (template.english) gen += pick(pools[template.english.caseMode], template.english.count)
  if (template.digits) gen += pick('0123456789', template.digits.count)
  if (template.special) gen += pick(template.special.charset, template.special.count)
  const dot = oldName.lastIndexOf('.')
  const stem = dot > 0 ? oldName.slice(0, dot) : oldName
  const ext = dot > 0 ? oldName.slice(dot) : ''
  const pos = template.position
  let newStem: string
  if (pos.type === 'replace') newStem = gen
  else if (pos.type === 'before') newStem = gen + stem
  else if (pos.type === 'after') newStem = stem + gen
  else if (pos.type === 'after-position') {
    const n = Number(pos.value)
    newStem = n >= stem.length ? stem + gen : stem.slice(0, n) + gen + stem.slice(n)
  } else {
    const text = String(pos.value)
    const idx = stem.indexOf(text)
    newStem = idx < 0 ? stem + gen : stem.slice(0, idx + text.length) + gen + stem.slice(idx + text.length)
  }
  return newStem + ext
}
```

- [ ] **Step 4: 写文件分配面板**

创建 `web/src/pages/tools/file-assign.tsx`：

```tsx
import { useState } from 'react'
import { App, Button, Card, Checkbox, Divider, Input, InputNumber, Radio, Select, Space, Table, Tag, Typography } from 'antd'
import { buildTemplate, sampleName, useFileAssignApply, useFileAssignPreview } from './hooks'
import type { EnglishCase, FileAssignPreview, PositionType } from '../../types'

/** 示例文件名（名称模板实时示例用，固定值保证演示稳定） */
const SAMPLE_OLD = '4^orgn23.png'

export default function FileAssignPanel() {
  const { message } = App.useApp()
  const preview = useFileAssignPreview()
  const apply = useFileAssignApply()

  const [sourceDir, setSourceDir] = useState('')
  const [column, setColumn] = useState('文件地址')
  const [english, setEnglish] = useState(true)
  const [englishCount, setEnglishCount] = useState(4)
  const [caseMode, setCaseMode] = useState<EnglishCase>('lower')
  const [digits, setDigits] = useState(true)
  const [digitsCount, setDigitsCount] = useState(3)
  const [special, setSpecial] = useState(true)
  const [specialCount, setSpecialCount] = useState(2)
  const [charset, setCharset] = useState('!@$%^')
  const [position, setPosition] = useState<PositionType>('before')
  const [positionValue, setPositionValue] = useState('')
  const [plan, setPlan] = useState<FileAssignPreview | null>(null)

  const built = buildTemplate({ english, englishCount, caseMode, digits, digitsCount, special, specialCount, charset, position, positionValue })

  const doPreview = () => {
    if (!sourceDir.trim()) {
      message.warning('请先填写源文件夹路径')
      return
    }
    if ('error' in built) {
      message.warning(built.error)
      return
    }
    preview.mutate(
      { sourceDir: sourceDir.trim(), column, template: built.template },
      { onSuccess: (data) => setPlan(data) },
    )
  }

  const doApply = () => {
    if (!plan) return
    apply.mutate(
      { sourceDir: sourceDir.trim(), column, plan: plan.plan },
      { onSuccess: () => setPlan(null) },
    )
  }

  const sample = 'error' in built ? built.error : sampleName(SAMPLE_OLD, built.template)

  return (
    <Card size="small" title="文件随机分配">
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Space wrap size={12}>
          <Typography.Text>源文件夹路径</Typography.Text>
          <Input
            style={{ width: 420 }}
            placeholder="C:\Users\PC\Desktop\空投文件\全部文件"
            value={sourceDir}
            onChange={(e) => setSourceDir(e.target.value)}
          />
          <Button type="primary" loading={preview.isPending} onClick={doPreview}>
            生成预览
          </Button>
          {plan && (
            <Tag color="blue">
              已检测：{plan.filesCount} 个文件 / 账号 {plan.accountsCount} 行
            </Tag>
          )}
        </Space>

        <Space wrap size={12}>
          <Typography.Text>写入目标列</Typography.Text>
          <Select
            style={{ width: 160 }}
            value={column}
            onChange={setColumn}
            options={[
              { value: '图片地址', label: '图片地址' },
              { value: '文件地址', label: '文件地址' },
            ]}
          />
        </Space>

        <Space wrap size={12}>
          <Typography.Text>名称生成组件</Typography.Text>
          <Checkbox checked={english} onChange={(e) => setEnglish(e.target.checked)}>
            英文(随机)
          </Checkbox>
          <InputNumber min={1} max={20} disabled={!english} value={englishCount} onChange={(v) => setEnglishCount(v ?? 0)} />
          <Select
            style={{ width: 120 }}
            disabled={!english}
            value={caseMode}
            onChange={setCaseMode}
            options={[
              { value: 'lower', label: '小写 a-z' },
              { value: 'upper', label: '大写 A-Z' },
              { value: 'mixed', label: '大小写混合' },
            ]}
          />
          <Checkbox checked={digits} onChange={(e) => setDigits(e.target.checked)}>
            数字(随机)
          </Checkbox>
          <InputNumber min={1} max={20} disabled={!digits} value={digitsCount} onChange={(v) => setDigitsCount(v ?? 0)} />
          <Checkbox checked={special} onChange={(e) => setSpecial(e.target.checked)}>
            特殊字符
          </Checkbox>
          <InputNumber min={1} max={20} disabled={!special} value={specialCount} onChange={(v) => setSpecialCount(v ?? 0)} />
          <Input style={{ width: 110 }} disabled={!special} value={charset} onChange={(e) => setCharset(e.target.value)} placeholder="字符集" />
        </Space>

        <Space wrap size={12}>
          <Typography.Text>插入位置</Typography.Text>
          <Radio.Group value={position} onChange={(e) => setPosition(e.target.value as PositionType)}>
            <Radio.Button value="replace">替换文件名</Radio.Button>
            <Radio.Button value="before">文件名前</Radio.Button>
            <Radio.Button value="after">文件名后</Radio.Button>
            <Radio.Button value="after-position">指定位置后</Radio.Button>
            <Radio.Button value="after-text">指定文本后</Radio.Button>
          </Radio.Group>
          {position === 'after-position' && (
            <InputNumber min={1} value={positionValue ? Number(positionValue) : undefined} onChange={(v) => setPositionValue(String(v ?? ''))} placeholder="位置" />
          )}
          {position === 'after-text' && (
            <Input style={{ width: 110 }} value={positionValue} onChange={(e) => setPositionValue(e.target.value)} placeholder="文本" />
          )}
        </Space>

        <Typography.Text type="secondary">
          示例：<Typography.Text code>{SAMPLE_OLD}</Typography.Text> →{' '}
          <Typography.Text code>{'error' in built ? built.error : sample}</Typography.Text>
          （扩展名始终保留；「指定文本后」未找到文本的行会在预览中报错）
        </Typography.Text>

        <div>
          <Button type="primary" danger disabled={!plan} loading={apply.isPending} onClick={doApply}>
            执行分配
          </Button>
          <Typography.Text type="secondary" style={{ marginLeft: 12 }}>
            执行前需先生成并确认预览
          </Typography.Text>
        </div>

        {plan && (
          <>
            <Divider style={{ margin: '8px 0' }} />
            <Table
              size="small"
              rowKey="rowNumber"
              pagination={false}
              dataSource={plan.plan}
              columns={[
                { title: '窗口', dataIndex: 'window', width: 100 },
                {
                  title: '文件改名',
                  render: (_, r) => (
                    <span>
                      <Typography.Text delete type="secondary">{r.oldName}</Typography.Text>
                      <span style={{ margin: '0 8px', color: '#999' }}>→</span>
                      <Typography.Text style={{ color: '#1677ff' }}>{r.newName}</Typography.Text>
                    </span>
                  ),
                },
                { title: '目标路径', dataIndex: 'newPath', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
              ]}
            />
          </>
        )}
      </Space>
    </Card>
  )
}
```

- [ ] **Step 5: 写工具中心页**

创建 `web/src/pages/tools/index.tsx`：

```tsx
import { useState } from 'react'
import { Alert, Card, Col, Row, Space, Typography } from 'antd'
import { FileOutlined } from '@ant-design/icons'
import { useTools } from './hooks'
import FileAssignPanel from './file-assign'

export default function ToolsPage() {
  const tools = useTools()
  const [activeKey, setActiveKey] = useState<string | null>(null)

  if (tools.isPending) {
    return (
      <Card size="small">
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Typography.Text type="secondary">加载中...</Typography.Text>
        </div>
      </Card>
    )
  }

  if (tools.isError || !tools.data) {
    return <Alert type="error" showIcon message="工具列表加载失败" description="请检查后端服务是否运行" />
  }

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <div>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          工具中心
        </Typography.Title>
        <Typography.Text type="secondary">项目常用工具集合，随需扩展</Typography.Text>
      </div>
      <Row gutter={[16, 16]}>
        {tools.data.tools.map((t) => (
          <Col key={t.key} xs={24} sm={12} lg={8}>
            <Card
              hoverable
              onClick={() => setActiveKey(activeKey === t.key ? null : t.key)}
              style={activeKey === t.key ? { borderColor: '#1677ff' } : undefined}
            >
              <Card.Meta
                avatar={<FileOutlined style={{ fontSize: 24, color: '#1677ff' }} />}
                title={t.name}
                description={t.description}
              />
            </Card>
          </Col>
        ))}
      </Row>
      {activeKey === 'file-assign' && <FileAssignPanel />}
    </Space>
  )
}
```

- [ ] **Step 6: 注册路由与菜单**

修改 `web/src/App.tsx`：
- import 区（`SettingsPage` 之后）加：

```tsx
import ToolsPage from './pages/tools'
```

- 路由区（`settings` 路由之后）加：

```tsx
            <Route path="tools" element={<ToolsPage />} />
```

修改 `web/src/layouts/AppLayout.tsx`：
- icons import 加 `ToolOutlined`：

```ts
import {
  DashboardOutlined,
  DesktopOutlined,
  UnorderedListOutlined,
  ScheduleOutlined,
  ReadOutlined,
  SettingOutlined,
  ToolOutlined,
} from '@ant-design/icons'
```

- `menuItems` 在「定时任务」与「文档」之间插入：

```ts
  { key: '/tools', icon: <ToolOutlined />, label: '工具' },
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npm run test:web`（项目根）
Expected: PASS（hooks.test.tsx 10 个用例全绿 + 既有用例不受影响）

- [ ] **Step 8: 验证类型与构建**

Run: `npx tsc -b`（workdir `web`）与 `npm run typecheck`（项目根）
Expected: 均通过

- [ ] **Step 9: 手工冒烟（需 dev 环境）**

Run: `npm run dev`
Expected:
- 面板侧边栏出现「工具」菜单（看板/窗口/任务/定时任务/工具/文档/设置）
- 工具中心显示「文件随机分配」卡片，点击展开面板
- 填源文件夹（如 `C:\Users\PC\Desktop\空投文件\空投文件\全部文件`）→ 生成预览 → 表格显示旧名→新名→目标路径 → 执行分配 → 成功提示；`config/accounts.xlsx` 目标列被写入新路径
- 文件不足/列不存在/空模板时均有中文报错提示

- [ ] **Step 10: Commit**

```powershell
git add web/src/pages/tools web/src/App.tsx web/src/layouts/AppLayout.tsx
git commit -m "feat: 面板工具中心页与文件随机分配面板"
```

---

## 最终验证清单（全部任务完成后）

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（含新增 5 个后端测试文件）
- [ ] `npm run test:web` 通过
- [ ] `npx tsc -b`（workdir `web`）通过
- [ ] 手工冒烟：dev 起服务，工具页预览 + 执行一条链走通（用临时文件夹验证，勿动真实 `config/accounts.xlsx` 或先备份）
