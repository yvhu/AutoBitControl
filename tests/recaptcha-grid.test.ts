/**
 * 九宫格模拟点击模块单测：提示语映射纯函数 + 注入假 frame 的求解循环分支
 * 假 frame 用最小 locator 模拟器（按选择器分派行为），网格/小图截图用 jimp 生成真实 PNG
 * 真机语义（2026-09-09）：点击格子后 Google 刷新该格小图，需按 img src 变化做小图二次识别确认；
 * 分类空数组/抛错时点官方刷新按钮换一批图重试（换图后提示语可能变化，必须重读）
 */
import { describe, it, expect, vi } from 'vitest'
import Jimp from 'jimp'
import { mapQuestionId, solveRecaptchaGrid, findAnchorFrame, findChallengeFrame, ANCHOR_FRAME_PART, CHALLENGE_FRAME_PART, ANCHOR_SELECTOR, PROMPT_SELECTOR, TILE_SELECTOR, VERIFY_SELECTOR, GRID_SELECTOR, RELOAD_SELECTOR, RELOAD_MAX } from '../src/automation/recaptcha-grid'
import { CaptchaFailure } from '../src/integrations/yescaptcha'

/** 真机核实（2026-09-09）：页面常驻 v3 sitekey；挑战时动态插入 v2 sitekey */
const V3 = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'
const V2 = '6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve'

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

  it('真机遇到的中文变体（2026-09-09 扩充）', () => {
    expect(mapQuestionId('过街人行道')).toBe('/m/014xcs')
    expect(mapQuestionId('小轿车')).toBe('/m/0k4j')
    expect(mapQuestionId('大巴')).toBe('/m/01bjv')
    expect(mapQuestionId('轿车')).toBe('/m/0k4j')
    expect(mapQuestionId('人行道')).toBe('/m/014xcs')
    expect(mapQuestionId('摩托')).toBe('/m/04_sv')
    expect(mapQuestionId('火车')).toBe('/m/07jdr')
    expect(mapQuestionId('卡车')).toBe('/m/07r04')
    expect(mapQuestionId('飞机')).toBe('/m/0cmf2')
    expect(mapQuestionId('商店')).toBe('/m/02y_9m3')
    expect(mapQuestionId('店面')).toBe('/m/02y_9m3')
    expect(mapQuestionId('店面门脸')).toBe('/m/02y_9m3')
    expect(mapQuestionId('邮箱')).toBe('/m/04w5f')
    expect(mapQuestionId('交通信号灯')).toBe('/m/015qff')
  })

  it('英文扩充变体（storefronts/trucks/trains/airplanes/mailboxes）', () => {
    expect(mapQuestionId('storefronts')).toBe('/m/02y_9m3')
    expect(mapQuestionId('trucks')).toBe('/m/07r04')
    expect(mapQuestionId('trains')).toBe('/m/07jdr')
    expect(mapQuestionId('airplanes')).toBe('/m/0cmf2')
    expect(mapQuestionId('mailboxes')).toBe('/m/04w5f')
  })

  it('未覆盖提示语返回 null', () => {
    expect(mapQuestionId('不存在的物体xyz')).toBeNull()
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
  /** 动态截图实现（每次调用执行；供模拟首次超时失败等场景） */
  screenshotImpl?: () => Promise<Buffer | null>
  getAttributeImpl?: (name: string) => Promise<string | null>
  /** img src 动态读取（点击后变化模拟 Google 小图刷新） */
  srcImpl?: () => Promise<string | null>
  /** 动态 textContent（每次读取时调用；缺省回落 text 静态值） */
  textContentImpl?: () => Promise<string | null>
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
      getAttribute: vi.fn().mockImplementation(async (name: string) => {
        if (b.srcImpl && name === 'src') return b.srcImpl()
        return b.getAttributeImpl ? b.getAttributeImpl(name) : (b.attrs ?? {})[name] ?? null
      }),
      textContent: vi.fn().mockImplementation(async () => b.textContentImpl ? b.textContentImpl() : (b.text ?? null)),
      click,
      screenshot: vi.fn().mockImplementation(async () => b.screenshotImpl ? b.screenshotImpl() : (b.screenshotBuf ?? null)),
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
  function makeDeps(overrides: {
    anchorChecked?: string
    anchorPresent?: boolean
    challengePresent?: boolean
    prompt?: string | null
    tileCount?: number
    gridResult?: unknown
    gridScreenshotBuf?: Buffer | null
    /** 网格容器动态截图实现（模拟首次超时等失败场景） */
    gridScreenshotImpl?: () => Promise<Buffer | null>
    anchors?: Array<{ url: string }>
    promptImpl?: () => Promise<string | null>
    /** 按格子索引覆盖行为；clickImpl 在点击时执行（模拟点击后 img src 变化），不影响 tileClicks 断言 */
    tileBehaviors?: Record<number, ElemBehavior & { clickImpl?: () => void }>
    anchorAppearsOnFrameCall?: number
  } = {}) {
    const o = { anchorChecked: 'false', anchorPresent: true, challengePresent: true, prompt: '停车计时器', tileCount: 9, gridResult: { type: 'multi', objects: [0, 2] }, gridScreenshotBuf: null, ...overrides }
    // 锚点 aria-checked 为动态状态：点验证按钮后置 true（模拟真机「验证后变绿」）
    let checked = o.anchorChecked
    // 每个锚点 frame 独立 click mock（多 anchor 并存时供选择断言）
    const anchorSpecs = o.anchors ?? [{ url: `https://www.google.com/${ANCHOR_FRAME_PART}?k=${V2}` }]
    const anchorFrames = anchorSpecs.map((spec) => {
      const click = vi.fn().mockResolvedValue(undefined)
      return {
        url: spec.url,
        click,
        locator: makeFrame({
          [ANCHOR_SELECTOR]: {
            click,
            getAttributeImpl: async (name: string) => (name === 'aria-checked' ? checked : null),
          },
        }).locator,
      }
    })
    // 每个格子索引独立 click mock：nth(i) 按索引分派，供点选行为断言使用
    // 缺省 class 含 selected（模拟「点击已确认无刷新」），src/class 变化场景由 tileBehaviors 覆盖
    const tileClicks = Array.from({ length: o.tileCount }, () => vi.fn().mockResolvedValue(undefined))
    const tileNth: Record<number, ElemBehavior> = {}
    for (let i = 0; i < o.tileCount; i++) {
      const { clickImpl, ...extra } = o.tileBehaviors?.[i] ?? {}
      if (clickImpl) tileClicks[i] = vi.fn().mockImplementation(async () => { clickImpl() })
      tileNth[i] = { click: tileClicks[i], attrs: { class: 'rc-imageselect-tile selected' }, ...extra }
    }
    // 刷新换图按钮与验证按钮独立 click mock（供「换图重试」「不点 verify」断言）
    const reloadClick = vi.fn().mockResolvedValue(undefined)
    const verifyClick = vi.fn().mockImplementation(async () => { checked = 'true' })
    const challenge = makeFrame({
      [PROMPT_SELECTOR]: { text: o.prompt, textContentImpl: o.promptImpl },
      [TILE_SELECTOR]: { count: o.tileCount, attrs: { class: 'rc-imageselect-tile selected' }, nthBehaviors: tileNth },
      [GRID_SELECTOR]: { screenshotBuf: o.gridScreenshotBuf, screenshotImpl: o.gridScreenshotImpl },
      [VERIFY_SELECTOR]: { click: verifyClick },
      [RELOAD_SELECTOR]: { click: reloadClick },
    })
    // frames() 调用计数：驱动 anchor 延迟附着（第 N 次调用起才返回 anchor frame）
    let framesCalls = 0
    const page = {
      frames: () => {
        // anchor 从第 N 次 frames() 调用起才出现（模拟 iframe 已入 DOM 但 CDP frame 未附着）
        framesCalls++
        return [
          ...(o.anchorPresent && framesCalls >= (o.anchorAppearsOnFrameCall ?? 1) ? anchorFrames.map((a) => ({ url: () => a.url, locator: a.locator })) : []),
          ...(o.challengePresent ? [{ url: () => `https://www.google.com/${CHALLENGE_FRAME_PART}?hl=zh-CN`, locator: challenge.locator }] : []),
        ]
      },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    }
    const captcha = { solveGrid: vi.fn().mockResolvedValue(o.gridResult) }
    const logger = { info: vi.fn(), warn: vi.fn() }
    return { page, captcha, logger, anchorFrames, challenge, tileClicks, reloadClick, verifyClick, getFramesCalls: () => framesCalls }
  }

  it('无锚点 frame → none', async () => {
    const { page, captcha, logger } = makeDeps({ anchorPresent: false, challengePresent: false })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('none')
  })

  it('anchor frame 延迟附着：前两次 frames() 无 anchor → 轮询等附着后正常求解（不返回 none）', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, getFramesCalls } = makeDeps({ gridScreenshotBuf: gridBuf, anchorAppearsOnFrameCall: 3 })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
    // 确实发生了轮询重查（首查无 anchor，随后 500ms 间隔重查两次才附着）
    expect(getFramesCalls()).toBeGreaterThanOrEqual(3)
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits[0]).toBe(500)
    expect(waits[1]).toBe(500)
  }, 30000)

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
    // 日志带 objects 数组（排障用）：完整对象深比较
    expect(logger.info).toHaveBeenCalledWith({ objects: [0, 2], round: 'multi' }, '九宫格识别完成，开始点选')
    // 不传 confidence（平台默认返回 top3，满足 Google 每轮至少点 3 格）
    expect((captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0][2]).not.toHaveProperty('confidence')
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
    expect(optsArg).not.toHaveProperty('confidence')
  }, 30000)

  it('多 anchor 并存：siteKeyExclude 排除常驻 v3 锚点，点选 v2 锚点（v3 排在前）', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, anchorFrames } = makeDeps({
      gridScreenshotBuf: gridBuf,
      anchors: [
        { url: `https://www.google.com/${ANCHOR_FRAME_PART}?k=${V3}` },
        { url: `https://www.google.com/${ANCHOR_FRAME_PART}?k=${V2}` },
      ],
    })
    await expect(solveRecaptchaGrid(
      { page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never },
      { siteKeyExclude: V3 },
    )).resolves.toBe('solved')
    expect(anchorFrames[0].click).not.toHaveBeenCalled()
    expect(anchorFrames[1].click).toHaveBeenCalledTimes(1)
  }, 30000)

  it('提示语首次读空、稍后渲染完成 → 等待重读后正常求解（不抛「提示文字未找到」）', async () => {
    const gridBuf = await makePngBuffer(300)
    let reads = 0
    const { page, captcha, logger } = makeDeps({
      gridScreenshotBuf: gridBuf,
      prompt: null,
      promptImpl: async () => { reads++; return reads >= 2 ? '停车计时器' : '' },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
  }, 30000)

  it('点击节奏随机化：点格子后等待在 1500-2500ms 内且多次运行取值不同、点验证后在 2500-3500ms 内且取值不同（固定 2s/3s 会失败）', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({ gridScreenshotBuf: gridBuf, gridResult: { type: 'multi', objects: [0, 2] } })
    // 多轮运行观察取值方差：固定等待则所有取值相同 → 断言失败；随机化则几乎必然出现不同取值
    const tileWaits: number[] = []
    const verifyWaits: number[] = []
    const allWaits: number[] = []
    for (let i = 0; i < 12; i++) {
      await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
      const start = allWaits.length
      allWaits.push(...(page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.slice(start).map((c: unknown[]) => c[0] as number))
      const waits = allWaits.slice(start)
      // 每轮顺序：挑战 frame 轮询 500ms → 格子 0 → 格子 2 → 验证按钮
      expect(waits).toHaveLength(4)
      expect(waits[0]).toBe(500)
      tileWaits.push(...waits.slice(1, 3))
      verifyWaits.push(waits[3])
    }
    for (const w of tileWaits) {
      expect(w).toBeGreaterThanOrEqual(1500)
      expect(w).toBeLessThanOrEqual(2500)
    }
    for (const w of verifyWaits) {
      expect(w).toBeGreaterThanOrEqual(2500)
      expect(w).toBeLessThanOrEqual(3500)
    }
    expect(new Set(tileWaits).size).toBeGreaterThan(1)
    expect(new Set(verifyWaits).size).toBeGreaterThan(1)
  }, 30000)

  it('小图刷新二次识别命中后再点确认：初次点 + 确认点 + src 未变无 selected 重试点，等待均在 1500-2500ms 内随机取值', async () => {
    const gridBuf = await makePngBuffer(300)
    const tileBuf = await makePngBuffer(100)
    let src = 'A'
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      tileBehaviors: { 0: { attrs: { class: 'rc-imageselect-tile' }, screenshotBuf: tileBuf, srcImpl: async () => src, clickImpl: () => { src = 'B' } } },
    })
    // 分类序列：网格 multi → 格子 0 小图 single（命中）；格子 2 走 selected 直通不再分类
    let solveCall = 0
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      solveCall++
      return solveCall % 2 === 1 ? { type: 'multi', objects: [0, 2] } : { type: 'single', hasObject: true }
    })
    // 每次运行重置分类计数（首轮 src 变化后保持新值，后续轮不再触发小图分类，计数按轮独立）
    const runOnce = async () => {
      solveCall = 0
      return solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })
    }
    // 单次运行断言点击行为；多轮运行观察随机方差（固定 2000ms 时所有取值相同 → 失败）
    await expect(runOnce()).resolves.toBe('solved')
    // 格子 0：初次 1 点 + 刷新识别命中确认 1 点 + src 未变且无 selected 重试 1 点；格子 2：只点 1 次（selected 直通）
    expect(tileClicks[0]).toHaveBeenCalledTimes(3)
    expect(tileClicks[2]).toHaveBeenCalledTimes(1)
    // 分类只发生 2 次：网格 multi 1 次 + 格子 0 小图 single 1 次（确认循环中 src 未变不再重复分类）
    expect(captcha.solveGrid).toHaveBeenCalledTimes(2)
    const tileWaits: number[] = []
    const verifyWaits: number[] = []
    const allWaits: number[] = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    for (let i = 0; i < 8; i++) {
      await expect(runOnce()).resolves.toBe('solved')
      const start = allWaits.length
      allWaits.push(...(page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.slice(start).map((c: unknown[]) => c[0] as number))
      const waits = allWaits.slice(start)
      // 每轮顺序：500ms 轮询 → 格子 0 三次（初次 + 确认 + 重试）→ 格子 2 一次 → 验证按钮
      expect(waits).toHaveLength(6)
      expect(waits[0]).toBe(500)
      tileWaits.push(...waits.slice(1, 5))
      verifyWaits.push(waits[5])
    }
    for (const w of tileWaits) {
      expect(w).toBeGreaterThanOrEqual(1500)
      expect(w).toBeLessThanOrEqual(2500)
    }
    for (const w of verifyWaits) {
      expect(w).toBeGreaterThanOrEqual(2500)
      expect(w).toBeLessThanOrEqual(3500)
    }
    expect(new Set(tileWaits).size).toBeGreaterThan(1)
    expect(new Set(verifyWaits).size).toBeGreaterThan(1)
  }, 30000)

  it('小图刷新确认：点击后 img src 变化 → 小图二次识别 hasObject=true → 再点确认（该格共 2 点、分类 2 次）', async () => {
    const gridBuf = await makePngBuffer(300)
    const tileBuf = await makePngBuffer(100)
    let src = 'A'
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: { screenshotBuf: tileBuf, srcImpl: async () => src, clickImpl: () => { src = 'B' } } },
    })
    let solveCall = 0
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      solveCall++
      return solveCall === 1 ? { type: 'multi', objects: [0] } : { type: 'single', hasObject: true }
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 初次点击 + 刷新后确认点击：共 2 点（确认环节被跳过时只会点 1 次，此断言失败）
    expect(tileClicks[0]).toHaveBeenCalledTimes(2)
    // 分类 2 次：网格 multi 1 次 + 小图 single 1 次
    expect(captcha.solveGrid).toHaveBeenCalledTimes(2)
    const [, singleQuestionArg] = (captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[1]
    expect(singleQuestionArg).toBe('/m/015qbp')
    // 小图确认再点时打 warn 级别日志（排障用）
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ idx: 0 }), '九宫格小图刷新后仍含目标，再次点击确认')
  }, 30000)

  it('小图刷新后二次识别 hasObject=false → 不再点击该格（刷新后图不含目标，确认完成）', async () => {
    const gridBuf = await makePngBuffer(300)
    const tileBuf = await makePngBuffer(100)
    let src = 'A'
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: { screenshotBuf: tileBuf, srcImpl: async () => src, clickImpl: () => { src = 'B' } } },
    })
    let solveCall = 0
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      solveCall++
      return solveCall === 1 ? { type: 'multi', objects: [0] } : { type: 'single', hasObject: false }
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 初次点击后小图识别不含目标 → 不点确认：该格只点 1 次
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    // 分类 2 次：网格 multi + 小图 single（小图识别仍会发生，决定是否确认）
    expect(captcha.solveGrid).toHaveBeenCalledTimes(2)
    // 不再打「再次点击确认」日志
    expect(logger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ idx: 0 }), '九宫格小图刷新后仍含目标，再次点击确认')
  }, 30000)

  it('分类返回空数组 → 点刷新换图重试一次，第二次返回对象后流程继续（提示语必须重读）', async () => {
    const gridBuf = await makePngBuffer(300)
    let reads = 0
    // 换图后 Google 可能换提示语：首次读「停车计时器」，刷新后读「红绿灯」——第二次分类必须用新 qid
    const { page, captcha, logger, tileClicks, reloadClick } = makeDeps({
      gridScreenshotBuf: gridBuf,
      promptImpl: async () => { reads++; return reads >= 2 ? '红绿灯' : '停车计时器' },
    })
    let solveCall = 0
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      solveCall++
      return solveCall === 1 ? { type: 'multi', objects: [] } : { type: 'multi', objects: [0, 2] }
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 空数组触发刷新换图：刷新按钮点 1 次、分类调用 2 次，第二次结果驱动点选
    expect(reloadClick).toHaveBeenCalledTimes(1)
    expect(captcha.solveGrid).toHaveBeenCalledTimes(2)
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    expect(tileClicks[2]).toHaveBeenCalledTimes(1)
    // 换图后提示语重读：第二次分类的 qid 是「红绿灯」映射（提示语没重读会在此失败）
    expect((captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe('/m/015qff')
    expect(reads).toBeGreaterThanOrEqual(2)
    // 刷新后等新图渲染 2000-3000ms 随机
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits.some((w) => w >= 2000 && w <= 3000)).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reload: 1 }), '九宫格分类返回空数组，点刷新换图重试')
  }, 30000)

  it('分类抛错（ERROR_GARBAGE_SAMPLE）→ 点刷新换图重试成功', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, reloadClick } = makeDeps({ gridScreenshotBuf: gridBuf })
    let solveCall = 0
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      solveCall++
      if (solveCall === 1) throw new CaptchaFailure('yescaptcha 九宫格分类失败: ERROR_GARBAGE_SAMPLE')
      return { type: 'multi', objects: [0, 2] }
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 抛错触发刷新换图：刷新按钮点 1 次，第二次分类成功走完流程
    expect(reloadClick).toHaveBeenCalledTimes(1)
    expect(captcha.solveGrid).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reload: 1, err: expect.stringContaining('ERROR_GARBAGE_SAMPLE') }),
      '九宫格分类失败，点刷新换图重试',
    )
  }, 30000)

  it('分类恒空数组 → 刷新换图 RELOAD_MAX 次后放弃本轮（不点 verify），主循环轮数耗尽 failed', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, reloadClick, verifyClick } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [] },
    })
    await expect(solveRecaptchaGrid(
      { page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never },
      { maxRounds: 1 },
    )).resolves.toBe('failed')
    // 每轮最多换图 RELOAD_MAX 次：分类共 RELOAD_MAX+1 次，随后放弃本轮不点 verify
    expect(reloadClick).toHaveBeenCalledTimes(RELOAD_MAX)
    expect(captcha.solveGrid).toHaveBeenCalledTimes(RELOAD_MAX + 1)
    expect(verifyClick).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('九宫格分类刷新换图后仍为空数组，本轮放弃（不点验证，等主循环下一轮）')
  }, 30000)

  it('分类恒抛错 → 刷新换图 RELOAD_MAX 次后抛错（任务失败）', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, reloadClick, verifyClick } = makeDeps({ gridScreenshotBuf: gridBuf })
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockRejectedValue(new CaptchaFailure('yescaptcha 九宫格分类失败: ERROR_GARBAGE_SAMPLE'))
    await expect(solveRecaptchaGrid(
      { page: page as never, captcha: captcha as never, logger: { info: vi.fn(), warn: vi.fn() } as never, human: {} as never },
      { maxRounds: 1 },
    )).rejects.toThrow()
    expect(reloadClick).toHaveBeenCalledTimes(RELOAD_MAX)
    expect(verifyClick).not.toHaveBeenCalled()
  }, 30000)

  it('网格截图首次失败（元素动画中超时）→ 1 秒后重试成功继续求解', async () => {
    const gridBuf = await makePngBuffer(300)
    let shots = 0
    const { page, captcha, logger } = makeDeps({
      gridResult: { type: 'multi', objects: [0] },
      gridScreenshotImpl: async () => {
        shots++
        if (shots === 1) throw new Error('timeout 30000ms exceeded')
        return gridBuf
      },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(shots).toBe(2)
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits).toContain(1000)
    expect(logger.warn).toHaveBeenCalledWith('九宫格网格截图失败（元素可能动画中），1 秒后重试一次')
  }, 30000)
})

describe('find 函数 sitekey 排除', () => {
  function makeFrames(urls: string[]) {
    return { frames: () => urls.map((url) => ({ url: () => url })) } as never
  }

  it('findAnchorFrame：跳过 sitekey 与排除值相同的 frame，返回 v2 anchor', () => {
    const page = makeFrames([
      `https://www.google.com/${ANCHOR_FRAME_PART}?k=${V3}`,
      `https://www.google.com/${ANCHOR_FRAME_PART}?k=${V2}`,
    ])
    expect(findAnchorFrame(page, V3)?.url()).toContain(`k=${V2}`)
  })

  it('findAnchorFrame：不传排除值时行为不变（取第一个匹配 frame）', () => {
    const page = makeFrames([
      `https://www.google.com/${ANCHOR_FRAME_PART}?k=${V3}`,
      `https://www.google.com/${ANCHOR_FRAME_PART}?k=${V2}`,
    ])
    expect(findAnchorFrame(page)?.url()).toContain(`k=${V3}`)
  })

  it('findChallengeFrame：跳过 sitekey 与排除值相同的 bframe', () => {
    const page = makeFrames([
      `https://www.google.com/${CHALLENGE_FRAME_PART}?k=${V3}`,
      `https://www.google.com/${CHALLENGE_FRAME_PART}?k=${V2}`,
    ])
    expect(findChallengeFrame(page, V3)?.url()).toContain(`k=${V2}`)
  })
})
