/**
 * 失败诊断包（automation/diag 层）：任务失败瞬间采集页面与步骤上下文，供面板排障
 * 依赖方向：仅依赖 patchright 类型与 ./recorder；采集全程 best-effort，绝不抛错影响任务结果
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'patchright'
import type { StepRecord } from './recorder'

/** 失败诊断包：任务失败瞬间的上下文快照，写盘供面板排障时查看「当时页面长什么样、步骤走到哪」 */
export interface DiagBundle {
  /** 任务标识（TaskMeta.key） */
  taskKey: string
  /** 窗口名（数据源中的 profile 名） */
  profileName: string
  /** 运行状态（如 failed/retry_wait） */
  status: string
  /** 失败时的错误消息 */
  error: string
  /** 采集时的页面 URL */
  url: string
  /** 采集时刻的 ISO 时间字符串 */
  capturedAt: string
  /** 已记录的步骤时间线 */
  steps: StepRecord[]
  /** 页面可见文本（截断到 2000 字），用于判断页面实际内容 */
  visibleText: string
  /** 页面上 [role=dialog] 对话框文本（截断到 1000 字），用于看弹窗提示 */
  dialogText: string
}

/** 采集诊断所需的输入：页面、步骤时间线、错误与状态、窗口/任务标识 */
export interface CollectDiagOpts {
  /** 失败时所在页面 */
  page: Page
  /** 已记录的步骤时间线（通常来自 StepRecorder.steps()） */
  steps: StepRecord[]
  /** 失败错误消息 */
  error: string
  /** 运行状态 */
  status: string
  /** 窗口名 */
  windowName: string
  /** 任务标识 */
  taskKey: string
}

/**
 * 采集失败诊断：把当前页面 URL、可见文本、对话框文本与步骤时间线打包成一个 DiagBundle。
 * 采集全程 best-effort——每一项都用 safe 包裹，任一取值失败就回退为空串，绝不抛错影响任务结果本身。
 * @param opts 采集输入（页面、步骤、错误、状态、窗口/任务标识）
 * @returns 组装好的诊断包
 */
export async function collectDiagnostics(opts: CollectDiagOpts): Promise<DiagBundle> {
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => fn().catch(() => fallback)
  const url = await safe(async () => opts.page.url(), '')
  const visibleText = await safe(async () => opts.page.evaluate(() => document.body.innerText.slice(0, 2000)), '')
  const dialogText = await safe(async () => opts.page.evaluate(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').trim().slice(0, 1000)), '')
  return {
    taskKey: opts.taskKey,
    profileName: opts.windowName,
    status: opts.status,
    error: opts.error,
    url,
    capturedAt: new Date().toISOString(),
    steps: opts.steps,
    visibleText,
    dialogText,
  }
}

/**
 * 把诊断包写成 JSON 文件（best-effort）。
 * @param dir 目标目录（不存在会递归创建）
 * @param name 文件名（不含扩展名，实际写为 <name>.json）
 * @param bundle 诊断包内容
 * @returns 写入文件的绝对路径（供面板按路径取用）
 */
export function writeDiagBundle(dir: string, name: string, bundle: DiagBundle): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8')
  return file
}
