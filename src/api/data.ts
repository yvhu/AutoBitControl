/**
 * 数据与产物函数（api 层）：数据源取值 / 文件上传 / 容错截图
 * 依赖方向：engine TaskContext 类型
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from 'patchright'
import type { TaskContext } from '../engine/task-context'

/** 取数据源当前窗口行某列（严格：无行/无列/空值抛错） */
export async function getAccountValue(ctx: TaskContext, column: string): Promise<string> {
  const row = ctx.accountRow
  if (!row) throw new Error(`数据源无当前窗口对应的行（窗口: ${ctx.profile.name}）`)
  const v = row[column]
  if (v === undefined) throw new Error(`数据源缺少列: ${column}（可用列: ${Object.keys(row).join(', ')}）`)
  if (v === '') throw new Error(`数据源列 ${column} 在窗口 ${ctx.profile.name} 的行为空`)
  return v
}

/** 上传文件：值支持 http(s) URL（自动下载到临时文件）或本地路径 */
export async function setInputFiles(ctx: TaskContext, selector: string, value: string): Promise<void> {
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

/** 容错截图：默认截当前页，可传 page 指定其它页面（如新标签页跳转后的页）；存产物目录，失败只告警返回空串 */
export async function takeScreenshot(ctx: TaskContext, name: string, page?: Page): Promise<string> {
  try {
    mkdirSync(ctx.artifactsDir, { recursive: true })
    const file = join(ctx.artifactsDir, `${name}.png`)
    await (page ?? ctx.page).screenshot({ path: file, fullPage: false })
    ctx.recordScreenshot(file)
    return file
  } catch (e) {
    ctx.log.warn({ step: 'screenshot', window: ctx.profile.name, err: (e as Error).message }, '截图失败（不影响任务结果）')
    return ''
  }
}

/** 元素截图选项 */
export interface ElementScreenshotOptions {
  /** 目标页面（缺省 ctx.page）；多标签页场景可指定新标签页 */
  page?: Page
  /** 定位/截图超时毫秒（缺省 15000） */
  timeoutMs?: number
  /** 元素截图失败时是否回退截当前视口（缺省 true，保证不会因截图让任务失败） */
  fallbackToViewport?: boolean
}

/**
 * 按元素截图：滚动到目标元素并只截元素区域，适合任务卡片在首屏下方、全屏截图看不到任务的场景。
 * 执行流程：在目标页面定位 selector 首元素 → locator.screenshot（自动滚动到可见）→ 记录产物路径；
 * 失败时按 fallbackToViewport 回退到 takeScreenshot（默认回退），绝不因截图失败影响任务结果。
 * @param ctx 任务上下文（提供产物目录与日志）
 * @param name 截图名（不含扩展名）
 * @param selector 目标元素选择器
 * @param opts 页面/超时/回退选项
 * @returns 截图路径；失败返回空串
 */
export async function takeElementScreenshot(
  ctx: TaskContext,
  name: string,
  selector: string,
  opts: ElementScreenshotOptions = {},
): Promise<string> {
  const page = opts.page ?? ctx.page
  try {
    mkdirSync(ctx.artifactsDir, { recursive: true })
    const file = join(ctx.artifactsDir, `${name}.png`)
    const timeout = opts.timeoutMs ?? 15000
    await page.locator(selector).first().screenshot({ path: file, timeout })
    ctx.recordScreenshot(file)
    return file
  } catch (e) {
    ctx.log.warn({ step: 'screenshot', selector, window: ctx.profile.name, err: (e as Error).message }, '元素截图失败（不影响任务结果）')
    if (opts.fallbackToViewport === false) return ''
    return takeScreenshot(ctx, name, page)
  }
}
