import { describe, it, expect, vi } from 'vitest'
import { getAccount, uploadFile, takeScreenshot, recordStep, getSteps } from '../src/api'
import { StepRecorder } from '../src/automation'

/** 最小假 ctx：只提供被测函数用到的字段 */
function makeCtx(over: Record<string, unknown> = {}) {
  const setInputFiles = vi.fn(async () => {})
  const screenshot = vi.fn(async () => {})
  const ctx = {
    accountRow: { 邮箱: 'a@b.com', 密码: '' } as Record<string, string> | null,
    profile: { name: 'W1' },
    page: {
      locator: () => ({ first: () => ({ setInputFiles }) }),
      screenshot,
    },
    artifactsDir: 'C:/tmp/art',
    log: { info: vi.fn(), warn: vi.fn() },
    recorder: new StepRecorder(),
    ...over,
  }
  return { ctx: ctx as never, spies: { setInputFiles, screenshot } }
}

describe('api/data getAccount', () => {
  it('无当前窗口行：抛错并带窗口名', async () => {
    const { ctx } = makeCtx({ accountRow: null })
    await expect(getAccount(ctx, '邮箱')).rejects.toThrow('数据源无当前窗口对应的行')
  })

  it('缺少列：抛错并提示可用列', async () => {
    const { ctx } = makeCtx()
    await expect(getAccount(ctx, '不存在列')).rejects.toThrow('数据源缺少列')
  })

  it('列为空：抛错', async () => {
    const { ctx } = makeCtx()
    await expect(getAccount(ctx, '密码')).rejects.toThrow('为空')
  })

  it('命中：返回该列值', async () => {
    const { ctx } = makeCtx()
    expect(await getAccount(ctx, '邮箱')).toBe('a@b.com')
  })
})

describe('api/data uploadFile', () => {
  it('本地路径：直接 setInputFiles', async () => {
    const { ctx, spies } = makeCtx()
    await uploadFile(ctx, 'input[type=file]', './a.png')
    expect(spies.setInputFiles).toHaveBeenCalledWith('./a.png')
  })
})

describe('api/data takeScreenshot', () => {
  it('成功：返回产物路径', async () => {
    const { ctx } = makeCtx()
    const out = await takeScreenshot(ctx, 'shot')
    expect(out.endsWith('shot.png')).toBe(true)
  })

  it('失败：返回空串并告警', async () => {
    const { ctx } = makeCtx({ page: { screenshot: vi.fn(async () => { throw new Error('boom') }) } })
    expect(await takeScreenshot(ctx, 'shot')).toBe('')
    expect((ctx as never as { log: { warn: ReturnType<typeof vi.fn> } }).log.warn).toHaveBeenCalled()
  })
})

describe('api/diag recordStep', () => {
  it('记录步骤并透传返回值', async () => {
    const { ctx } = makeCtx()
    const out = await recordStep(ctx, 'step1', async () => 42)
    expect(out).toBe(42)
    const steps = getSteps(ctx)
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ name: 'step1', ok: true })
  })

  it('抛出时记录失败步骤并继续抛错', async () => {
    const { ctx } = makeCtx()
    await expect(recordStep(ctx, 'bad', async () => { throw new Error('nope') })).rejects.toThrow('nope')
    expect(getSteps(ctx)[0]).toMatchObject({ name: 'bad', ok: false })
  })
})
