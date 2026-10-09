/**
 * 数据与产物函数（api 层）：数据源取值 / 文件上传 / 容错截图
 * 依赖方向：engine TaskContext 类型
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TaskContext } from '../engine/task-context'

/** 取数据源当前窗口行某列（严格：无行/无列/空值抛错） */
export async function getAccount(ctx: TaskContext, column: string): Promise<string> {
  const row = ctx.accountRow
  if (!row) throw new Error(`数据源无当前窗口对应的行（窗口: ${ctx.profile.name}）`)
  const v = row[column]
  if (v === undefined) throw new Error(`数据源缺少列: ${column}（可用列: ${Object.keys(row).join(', ')}）`)
  if (v === '') throw new Error(`数据源列 ${column} 在窗口 ${ctx.profile.name} 的行为空`)
  return v
}

/** 上传文件：值支持 http(s) URL（自动下载到临时文件）或本地路径 */
export async function uploadFile(ctx: TaskContext, selector: string, value: string): Promise<void> {
  const loc = ctx.page.locator(selector).first()
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value)
    if (!res.ok) throw new Error(`图片下载失败: ${value.split('?')[0]} (HTTP ${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (value.split('?')[0].match(/\.(\w+)$/)?.[1] ?? 'png').slice(0, 10)
    mkdirSync(join(tmpdir(), 'abc-uploads'), { recursive: true })
    const file = join(tmpdir(), 'abc-uploads', `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
    writeFileSync(file, buf)
    await loc.setInputFiles(file)
    return
  }
  await loc.setInputFiles(value)
}

/** 容错截图：存产物目录，失败只告警返回空串 */
export async function takeScreenshot(ctx: TaskContext, name: string): Promise<string> {
  try {
    mkdirSync(ctx.artifactsDir, { recursive: true })
    const file = join(ctx.artifactsDir, `${name}.png`)
    await ctx.page.screenshot({ path: file, fullPage: false })
    return file
  } catch (e) {
    ctx.log.warn({ step: 'screenshot', window: ctx.profile.name, err: (e as Error).message }, '截图失败（不影响任务结果）')
    return ''
  }
}
