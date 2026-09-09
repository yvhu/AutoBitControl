/**
 * 九宫格模拟点击模块单测：提示语映射纯函数 + 注入假 frame 的求解循环分支
 * 假 frame 用最小 locator 模拟器（按选择器分派行为），网格截图用 jimp 生成真实 PNG
 */
import { describe, it, expect, vi } from 'vitest'
import Jimp from 'jimp'
import { mapQuestionId, solveRecaptchaGrid, ANCHOR_FRAME_PART, CHALLENGE_FRAME_PART, ANCHOR_SELECTOR, PROMPT_SELECTOR, TILE_SELECTOR, VERIFY_SELECTOR, GRID_SELECTOR } from '../src/automation/recaptcha-grid'

describe('mapQuestionId 提示语映射', () => {
  it('中文常见提示语', () => {
    expect(mapQuestionId('停车计时器')).toBe('/m/015qbp')
    expect(mapQuestionId('停车计价表')).toBe('/m/015qbp')
    expect(mapQuestionId('红绿灯')).toBe('/m/015qff')
    expect(mapQuestionId('人行横道')).toBe('/m/014xcs')
  })

  it('英文常见提示语', () => {
    expect(mapQuestionId('traffic lights')).toBe('/m/015qff')
    expect(mapQuestionId('parking meters')).toBe('/m/015qbp')
    expect(mapQuestionId('bicycles')).toBe('/m/0199g')
  })

  it('长句包含目标词也能命中', () => {
    expect(mapQuestionId('请选择包含停车计时器的所有图片')).toBe('/m/015qbp')
  })

  it('未覆盖提示语返回 null', () => {
    expect(mapQuestionId('storefronts')).toBeNull()
    expect(mapQuestionId('')).toBeNull()
  })
})

/** 最小假 locator：元素行为表；count/getAttribute/textContent/click/screenshot 均按选择器分派 */
interface ElemBehavior {
  count?: number
  attrs?: Record<string, string>
  text?: string | null
  click?: ReturnType<typeof vi.fn>
  screenshotBuf?: Buffer | null
  getAttributeImpl?: (name: string) => Promise<string | null>
  /** 按索引分派的子行为：nth(i) 返回独立实例（每个索引独立 click mock），未命中回落到当前行为 */
  nthBehaviors?: Record<number, ElemBehavior>
}

function makeFrame(behaviors: Record<string, ElemBehavior>) {
  const build = (b: ElemBehavior) => {
    const click = b.click ?? vi.fn().mockResolvedValue(undefined)
    return {
      first: () => build(b),
      nth: (i: number) => build(b.nthBehaviors?.[i] ?? b),
      locator: () => build(b),
      count: vi.fn().mockResolvedValue(b.count ?? 0),
      getAttribute: vi.fn().mockImplementation(async (name: string) => b.getAttributeImpl ? b.getAttributeImpl(name) : (b.attrs ?? {})[name] ?? null),
      textContent: vi.fn().mockResolvedValue(b.text ?? null),
      click,
      screenshot: vi.fn().mockResolvedValue(b.screenshotBuf ?? null),
    }
  }
  const locator = (selector: string) => build(behaviors[selector] ?? {})
  return { locator }
}

/** 造一张纯色 PNG（供 jimp 缩放链路） */
async function makePngBuffer(size: number): Promise<Buffer> {
  const img = new Jimp(size, size, 0x22aaffff)
  return img.getBufferAsync(Jimp.MIME_PNG)
}

describe('solveRecaptchaGrid 求解循环', () => {
  function makeDeps(overrides: { anchorChecked?: string; anchorPresent?: boolean; challengePresent?: boolean; prompt?: string | null; tileCount?: number; gridResult?: unknown; gridScreenshotBuf?: Buffer | null } = {}) {
    const o = { anchorChecked: 'false', anchorPresent: true, challengePresent: true, prompt: '停车计时器', tileCount: 9, gridResult: { type: 'multi', objects: [0, 2] }, gridScreenshotBuf: null, ...overrides }
    // 锚点 aria-checked 为动态状态：点验证按钮后置 true（模拟真机「验证后变绿」）
    let checked = o.anchorChecked
    const anchor = makeFrame({
      [ANCHOR_SELECTOR]: {
        click: vi.fn().mockResolvedValue(undefined),
        getAttributeImpl: async (name: string) => (name === 'aria-checked' ? checked : null),
      },
    })
    // 每个格子索引独立 click mock：nth(i) 按索引分派，供点选行为断言使用
    const tileClicks = Array.from({ length: o.tileCount }, () => vi.fn().mockResolvedValue(undefined))
    const challenge = makeFrame({
      [PROMPT_SELECTOR]: { text: o.prompt },
      [TILE_SELECTOR]: {
        count: o.tileCount,
        attrs: { class: 'rc-imageselect-tile' },
        nthBehaviors: Object.fromEntries(tileClicks.map((click, i) => [i, { click, attrs: { class: 'rc-imageselect-tile' } }])),
      },
      [GRID_SELECTOR]: { screenshotBuf: o.gridScreenshotBuf },
      [VERIFY_SELECTOR]: { click: vi.fn().mockImplementation(async () => { checked = 'true' }) },
    })
    const page = {
      frames: () => [
        ...(o.anchorPresent ? [{ url: () => `https://www.google.com/${ANCHOR_FRAME_PART}?k=6LcCqC8s`, locator: anchor.locator }] : []),
        ...(o.challengePresent ? [{ url: () => `https://www.google.com/${CHALLENGE_FRAME_PART}?hl=zh-CN`, locator: challenge.locator }] : []),
      ],
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    }
    const captcha = { solveGrid: vi.fn().mockResolvedValue(o.gridResult) }
    const logger = { info: vi.fn(), warn: vi.fn() }
    return { page, captcha, logger, anchor, challenge, tileClicks }
  }

  it('无锚点 frame → none', async () => {
    const { page, captcha, logger } = makeDeps({ anchorPresent: false, challengePresent: false })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('none')
  })

  it('点复选框后 aria-checked=true（一键通过）→ solved，不进网格', async () => {
    const { page, captcha, logger } = makeDeps({ anchorChecked: 'true', challengePresent: false })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(captcha.solveGrid).not.toHaveBeenCalled()
  })

  it('完整一轮：读提示语 → 分类 → 点格子 → 验证 → aria-checked=true → solved', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, tileClicks } = makeDeps({ gridResult: { type: 'multi', objects: [0, 2] }, gridScreenshotBuf: gridBuf })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
    const [imageArg, questionArg] = (captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(questionArg).toBe('/m/015qbp')
    expect(imageArg).toMatch(/^[A-Za-z0-9+/=]+$/)
    // 成本记账缺省透传为 null（向后兼容）
    expect((captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ profileId: null, taskKey: null })
    // 点选行为断言：objects=[0,2] 时索引 0/2 各点一次、其余格子不点（删除点选循环会在此失败）
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    expect(tileClicks[2]).toHaveBeenCalledTimes(1)
    for (let i = 0; i < tileClicks.length; i++) {
      if (i !== 0 && i !== 2) expect(tileClicks[i]).not.toHaveBeenCalled()
    }
    const totalClicks = tileClicks.reduce((n, m) => n + m.mock.calls.length, 0)
    expect(totalClicks).toBe(2)
  }, 30000)

  it('成本记账透传：opts 的 profileId/taskKey/onLog 传给 solveGrid', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({ gridScreenshotBuf: gridBuf })
    const onLog = vi.fn()
    await expect(solveRecaptchaGrid(
      { page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never },
      { profileId: 7, taskKey: 'checkin:faucet', onLog },
    )).resolves.toBe('solved')
    const optsArg = (captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(optsArg).toMatchObject({ profileId: 7, taskKey: 'checkin:faucet', onLog })
  }, 30000)
})
