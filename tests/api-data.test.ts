import { describe, it, expect, vi } from 'vitest'
import { getAccountValue, setInputFiles, takeScreenshot, takeElementScreenshot, recordStep, getSteps } from '../src/api'
import { StepRecorder } from '../src/automation'

/** 最小假 ctx：只提供被测函数用到的字段 */
function makeCtx(over: Record<string, unknown> = {}) {
  const locatorSetInputFiles = vi.fn(async () => {})
  const screenshot = vi.fn(async () => {})
  const recordScreenshot = vi.fn()
  const ctx = {
    accountRow: { 邮箱: 'a@b.com', 密码: '' } as Record<string, string> | null,
    profile: { name: 'W1' },
    page: {
      locator: () => ({ first: () => ({ setInputFiles: locatorSetInputFiles }) }),
      screenshot,
    },
    artifactsDir: 'C:/tmp/art',
    recordScreenshot,
    log: { info: vi.fn(), warn: vi.fn() },
    recorder: new StepRecorder(),
    ...over,
  }
  return { ctx: ctx as never, spies: { setInputFiles: locatorSetInputFiles, screenshot, recordScreenshot } }
}

describe('api/data getAccountValue', () => {
  it('无当前窗口行：抛错并带窗口名', async () => {
    const { ctx } = makeCtx({ accountRow: null })
    await expect(getAccountValue(ctx, '邮箱')).rejects.toThrow('数据源无当前窗口对应的行')
  })

  it('缺少列：抛错并提示可用列', async () => {
    const { ctx } = makeCtx()
    await expect(getAccountValue(ctx, '不存在列')).rejects.toThrow('数据源缺少列')
  })

  it('列为空：抛错', async () => {
    const { ctx } = makeCtx()
    await expect(getAccountValue(ctx, '密码')).rejects.toThrow('为空')
  })

  it('命中：返回该列值', async () => {
    const { ctx } = makeCtx()
    expect(await getAccountValue(ctx, '邮箱')).toBe('a@b.com')
  })
})

describe('api/data setInputFiles', () => {
  it('本地路径：直接 setInputFiles', async () => {
    const { ctx, spies } = makeCtx()
    await setInputFiles(ctx, 'input[type=file]', './a.png')
    expect(spies.setInputFiles).toHaveBeenCalledWith('./a.png')
  })
})

describe('api/data takeScreenshot', () => {
  it('成功：返回产物路径并记录到 ctx', async () => {
    const { ctx, spies } = makeCtx()
    const out = await takeScreenshot(ctx, 'shot')
    expect(out.endsWith('shot.png')).toBe(true)
    expect(spies.recordScreenshot).toHaveBeenCalledWith(out)
  })

  it('失败：返回空串并告警，不记录路径', async () => {
    const { ctx, spies } = makeCtx({ page: { screenshot: vi.fn(async () => { throw new Error('boom') }) } })
    expect(await takeScreenshot(ctx, 'shot')).toBe('')
    expect(spies.recordScreenshot).not.toHaveBeenCalled()
    expect((ctx as never as { log: { warn: ReturnType<typeof vi.fn> } }).log.warn).toHaveBeenCalled()
  })

  it('可指定 page：截取传入页面而非 ctx.page', async () => {
    const { ctx, spies } = makeCtx()
    const otherShot = vi.fn(async () => {})
    const out = await takeScreenshot(ctx, 'shot2', { screenshot: otherShot } as never)
    expect(out.endsWith('shot2.png')).toBe(true)
    expect(otherShot).toHaveBeenCalled()
    expect(spies.screenshot).not.toHaveBeenCalled()
  })
})

describe('api/data takeElementScreenshot', () => {
  it('成功：按元素截图并记录路径，不截整页', async () => {
    const elementShot = vi.fn(async () => {})
    const viewportShot = vi.fn(async () => {})
    const { ctx, spies } = makeCtx({
      page: {
        locator: () => ({ first: () => ({ screenshot: elementShot }) }),
        screenshot: viewportShot,
      },
    })
    const out = await takeElementScreenshot(ctx, 'card', '#card')
    expect(out.endsWith('card.png')).toBe(true)
    expect(elementShot).toHaveBeenCalledWith(expect.objectContaining({ path: out }))
    expect(viewportShot).not.toHaveBeenCalled()
    expect(spies.recordScreenshot).toHaveBeenCalledWith(out)
  })

  it('元素截图失败：回退整页截图，保证不影响任务', async () => {
    const elementShot = vi.fn(async () => { throw new Error('element gone') })
    const viewportShot = vi.fn(async () => {})
    const { ctx, spies } = makeCtx({
      page: { locator: () => ({ first: () => ({ screenshot: elementShot }) }), screenshot: viewportShot },
    })
    const out = await takeElementScreenshot(ctx, 'card', '#card')
    expect(out.endsWith('card.png')).toBe(true)
    expect(viewportShot).toHaveBeenCalled()
    expect(spies.recordScreenshot).toHaveBeenCalledWith(out)
  })

  it('可指定 page：在传入页面按元素截图', async () => {
    const elementShot = vi.fn(async () => {})
    const { ctx } = makeCtx()
    const otherPage = { locator: () => ({ first: () => ({ screenshot: elementShot }) }), screenshot: vi.fn() }
    const out = await takeElementScreenshot(ctx, 'card2', '#card', { page: otherPage as never })
    expect(out.endsWith('card2.png')).toBe(true)
    expect(elementShot).toHaveBeenCalled()
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
