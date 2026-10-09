/**
 * 失败诊断包（automation/diag 层）：任务失败瞬间采集页面与步骤上下文，供面板排障
 * 依赖方向：仅依赖 patchright 类型与 ./recorder；采集全程 best-effort，绝不抛错影响任务结果
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'patchright'
import type { StepRecord } from './recorder'

export interface DiagBundle {
  taskKey: string
  profileName: string
  status: string
  error: string
  url: string
  capturedAt: string
  steps: StepRecord[]
  visibleText: string
  dialogText: string
}

export interface CollectDiagOpts {
  page: Page
  steps: StepRecord[]
  error: string
  status: string
  windowName: string
  taskKey: string
}

/** 采集诊断（字段级 catch：任一项失败置空串，不抛错） */
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

/** 写诊断包 JSON（best-effort；返回文件绝对路径） */
export function writeDiagBundle(dir: string, name: string, bundle: DiagBundle): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8')
  return file
}
