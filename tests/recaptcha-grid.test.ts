/**
 * 九宫格模拟点击模块单测：提示语映射纯函数 + 注入假 frame 的求解循环分支
 * 假 frame 用最小 locator 模拟器（按选择器分派行为），网格/小图截图用 jimp 生成真实 PNG
 * 真机语义（2026-09-09）：点击格子后 Google 刷新该格小图，需按 img src 变化做小图二次识别确认；
 * 分类空数组/抛错时点官方刷新按钮换一批图重试（换图后提示语可能变化，必须重读）；
 * frame 内点击走拟人坐标点击（framePoint 合成坐标 → human.clickAt），拿不到坐标回退 locator 直点
 */
import { describe, it, expect, vi } from 'vitest'
import Jimp from 'jimp'

// mock node:fs 写盘（recaptcha-grid 的诊断落盘只在真机有意义）：防止测试把 fake 截图写进 data/screenshots/grid-debug
// 目录清理（pruneDebugDir）同样 mock：existsSync 恒 false 使其早退，避免测试清空真机诊断目录
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(), existsSync: vi.fn(() => false), readdirSync: vi.fn(() => []), unlinkSync: vi.fn() }
})
import { mapQuestionId, solveRecaptchaGrid, findAnchorFrame, findChallengeFrame, toStandardBase64, ANCHOR_FRAME_PART, CHALLENGE_FRAME_PART, ANCHOR_SELECTOR, PROMPT_SELECTOR, TILE_SELECTOR, VERIFY_SELECTOR, GRID_SELECTOR, RELOAD_SELECTOR, RELOAD_MAX } from '../src/automation/recaptcha-grid'
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

describe('toStandardBase64 中心裁剪', () => {
  it('非正方形输入中心裁剪：左右 10px 红/蓝色条被裁掉，输出正方形且四角为绿色（旧实现直接拉伸会残留色条）', async () => {
    const img = new Jimp(400, 380, 0x00ff00ff)
    for (let x = 0; x < 400; x++) {
      for (let y = 0; y < 380; y++) {
        if (x < 10) img.setPixelColor(0xff0000ff, x, y)
        else if (x >= 390) img.setPixelColor(0x0000ffff, x, y)
      }
    }
    const b64 = await toStandardBase64(await img.getBufferAsync(Jimp.MIME_PNG), 300)
    const out = await Jimp.read(Buffer.from(b64, 'base64'))
    expect(out.getWidth()).toBe(300)
    expect(out.getHeight()).toBe(300)
    for (const [x, y] of [[0, 0], [299, 0], [0, 299], [299, 299]]) {
      expect(out.getPixelColor(x, y)).toBe(0x00ff00ff)
    }
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
  /** evaluate 返回的固定盒中心（framePoint 拟人点击坐标用；缺省 null → 拟人点击回退 locator 直点） */
  box?: { x: number; y: number } | null
}

function makeFrame(behaviors: Record<string, ElemBehavior>, extra: { frameElement?: () => Promise<unknown> } = {}) {
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
      evaluate: vi.fn().mockImplementation(async () => b.box ?? null),
    }
  }
  const locator = (selector: string) => build(behaviors[selector] ?? {})
  const frameElement = extra.frameElement ?? (async () => null)
  return { locator, frameElement }
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
    /** 挑战 frame 从第 N 次 frames() 调用起才出现（模拟锚点重点后 bframe 才注入） */
    challengeAppearsOnFrameCall?: number
    /** 挑战 frame 的 frameElement 实现（缺省返回 null → 拟人点击回退 locator 直点） */
    challengeFrameElementImpl?: () => Promise<{ evaluate: ReturnType<typeof vi.fn> } | null>
    /** 每格 evaluate 返回的固定盒中心（缺省 null → 拟人点击回退 locator 直点） */
    tileBox?: { x: number; y: number } | null
  } = {}) {
    const o = { anchorChecked: 'false', anchorPresent: true, challengePresent: true, prompt: '停车计时器', tileCount: 9, gridResult: { type: 'multi', objects: [0, 2] }, gridScreenshotBuf: null, ...overrides }
    // 锚点 aria-checked 为动态状态：点验证按钮后置 true（模拟真机「验证后变绿」）
    let checked = o.anchorChecked
    // 每个锚点 frame 独立 click mock（多 anchor 并存时供选择断言）
    const anchorSpecs = o.anchors ?? [{ url: `https://www.google.com/${ANCHOR_FRAME_PART}?k=${V2}` }]
    const anchorFrames = anchorSpecs.map((spec) => {
      const click = vi.fn().mockResolvedValue(undefined)
      const mk = makeFrame({
        [ANCHOR_SELECTOR]: {
          click,
          getAttributeImpl: async (name: string) => (name === 'aria-checked' ? checked : null),
        },
      })
      return {
        url: spec.url,
        click,
        locator: mk.locator,
        frameElement: mk.frameElement,
      }
    })
    // 每个格子索引独立 click mock：nth(i) 按索引分派，供点选行为断言使用
    // 缺省 class 含 selected（模拟「点击已确认无刷新」），src/class 变化场景由 tileBehaviors 覆盖
    const tileClicks = Array.from({ length: o.tileCount }, () => vi.fn().mockResolvedValue(undefined))
    const tileNth: Record<number, ElemBehavior> = {}
    for (let i = 0; i < o.tileCount; i++) {
      const { clickImpl, ...extra } = o.tileBehaviors?.[i] ?? {}
      if (clickImpl) tileClicks[i] = vi.fn().mockImplementation(async () => { clickImpl() })
      // count 缺省 1：真实格子 td 内必有 img（waitTileStable 先查 img 存在才轮询 src 稳定）
      tileNth[i] = { click: tileClicks[i], attrs: { class: 'rc-imageselect-tile selected' }, box: o.tileBox ?? null, count: 1, ...extra }
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
    }, { frameElement: o.challengeFrameElementImpl ?? (async () => null) })
    // 拟人点击 mock（缺省成功；framePoint 拿不到坐标时不会被调用）
    const human = { clickAt: vi.fn().mockResolvedValue(undefined) }
    // frames() 调用计数：驱动 anchor 延迟附着（第 N 次调用起才返回 anchor frame）
    let framesCalls = 0
    const page = {
      frames: () => {
        // anchor 从第 N 次 frames() 调用起才出现（模拟 iframe 已入 DOM 但 CDP frame 未附着）
        framesCalls++
        return [
          ...(o.anchorPresent && framesCalls >= (o.anchorAppearsOnFrameCall ?? 1) ? anchorFrames.map((a) => ({ url: () => a.url, locator: a.locator, frameElement: a.frameElement })) : []),
          ...(o.challengePresent && framesCalls >= (o.challengeAppearsOnFrameCall ?? 1) ? [{ url: () => `https://www.google.com/${CHALLENGE_FRAME_PART}?hl=zh-CN`, locator: challenge.locator, frameElement: challenge.frameElement }] : []),
        ]
      },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    }
    const captcha = { solveGrid: vi.fn().mockResolvedValue(o.gridResult) }
    const logger = { info: vi.fn(), warn: vi.fn() }
    return { page, captcha, logger, human, anchorFrames, challenge, tileClicks, reloadClick, verifyClick, getFramesCalls: () => framesCalls }
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
    // 成本记账回调缺省为空实现（向后兼容）；死参数 profileId/taskKey 不再透传
    expect((captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ onLog: expect.any(Function) })
    expect((captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0][2]).not.toHaveProperty('profileId')
    expect((captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0][2]).not.toHaveProperty('taskKey')
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

  it('点格子走拟人坐标点击：坐标为 frame 内中心 + frame 元素页面偏移合成值，locator 直点不被调', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, human, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0, 2] },
      tileBox: { x: 10, y: 20 },
      challengeFrameElementImpl: async () => ({ evaluate: vi.fn().mockResolvedValue({ x: 100, y: 50 }) }),
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: human as never })).resolves.toBe('solved')
    // 坐标 = 格中心（10,20）+ frame 页面偏移（100,50）；objects=[0,2] 各点一次
    expect(human.clickAt).toHaveBeenCalledTimes(2)
    expect(human.clickAt).toHaveBeenCalledWith(110, 70)
    expect(tileClicks[0]).not.toHaveBeenCalled()
    expect(tileClicks[2]).not.toHaveBeenCalled()
  }, 30000)

  it('framePoint 拿不到坐标（frameElement 为空）→ 回退 locator 直点，拟人点击不被调', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, human, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBox: { x: 10, y: 20 },
      challengeFrameElementImpl: async () => null,
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: human as never })).resolves.toBe('solved')
    expect(human.clickAt).not.toHaveBeenCalled()
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
  }, 30000)

  it('成本记账透传：opts 的 onLog 原样传给 solveGrid（profileId/taskKey 死参数不再透传）', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({ gridScreenshotBuf: gridBuf })
    const onLog = vi.fn()
    await expect(solveRecaptchaGrid(
      { page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never },
      { onLog },
    )).resolves.toBe('solved')
    const optsArg = (captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(optsArg.onLog).toBe(onLog)
    expect(optsArg).not.toHaveProperty('profileId')
    expect(optsArg).not.toHaveProperty('taskKey')
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

  it('挑战 frame 始终未出现且未变绿 → 每轮重点 1 次锚点自纠，轮数耗尽 failed', async () => {
    const { page, captcha, logger, anchorFrames } = makeDeps({ challengePresent: false })
    await expect(solveRecaptchaGrid(
      { page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never },
      { maxRounds: 2 },
    )).resolves.toBe('failed')
    // 初始点击 1 次 + 每轮重点 1 次（2 轮）：共 3 次锚点点击；不点验证不进分类
    expect(anchorFrames[0].click).toHaveBeenCalledTimes(3)
    expect(captcha.solveGrid).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith({ round: 1 }, '挑战 frame 未出现且未变绿，重点一次锚点自纠')
    expect(logger.warn).toHaveBeenCalledWith({ round: 2 }, '挑战 frame 未出现且未变绿，重点一次锚点自纠')
  }, 30000)

  it('锚点重点自纠生效：挑战 frame 延迟出现 → 继续求解成功（不 failed）', async () => {
    const gridBuf = await makePngBuffer(300)
    // 初始等待与首轮重查都找不到挑战（前 40 次 frames() 调用无 bframe），重点锚点后出现
    const { page, captcha, logger, anchorFrames, verifyClick } = makeDeps({ gridScreenshotBuf: gridBuf, challengeAppearsOnFrameCall: 40 })
    await expect(solveRecaptchaGrid(
      { page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never },
      { maxRounds: 2 },
    )).resolves.toBe('solved')
    // 初始点击 + 1 次重点自纠；重点后挑战出现并完成一轮求解
    expect(anchorFrames[0].click).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith({ round: 1 }, '挑战 frame 未出现且未变绿，重点一次锚点自纠')
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
    expect(verifyClick).toHaveBeenCalledTimes(1)
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

  it('点击节奏随机化：截图前 1500-2500ms、点格后 500ms 稳定性轮询、点验证前 3000-5000ms、点验证后 2500-3500ms，随机区间多次运行取值不同', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({ gridScreenshotBuf: gridBuf, gridResult: { type: 'multi', objects: [0, 2] } })
    // 多轮运行观察取值方差：固定等待则所有取值相同 → 断言失败；随机化则几乎必然出现不同取值
    const preVerifyWaits: number[] = []
    const verifyWaits: number[] = []
    const preShotWaits: number[] = []
    const allWaits: number[] = []
    for (let i = 0; i < 12; i++) {
      await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
      const start = allWaits.length
      allWaits.push(...(page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.slice(start).map((c: unknown[]) => c[0] as number))
      const waits = allWaits.slice(start)
      // 每轮顺序：挑战 frame 轮询 500ms → 截图前动画稳定 1500-2500ms → shotGrid 内部稳定 800ms
      // → 格子 0 稳定性轮询 500ms → 格子 2 稳定性轮询 500ms → 验证前全体稳定 3000-5000ms → 验证后 2500-3500ms
      expect(waits).toHaveLength(7)
      expect(waits[0]).toBe(500)
      expect(waits[1]).toBeGreaterThanOrEqual(1500)
      expect(waits[1]).toBeLessThanOrEqual(2500)
      expect(waits[2]).toBe(800)
      preShotWaits.push(waits[1])
      expect(waits[3]).toBe(500)
      expect(waits[4]).toBe(500)
      preVerifyWaits.push(waits[5])
      verifyWaits.push(waits[6])
    }
    for (const w of preShotWaits) {
      expect(w).toBeGreaterThanOrEqual(1500)
      expect(w).toBeLessThanOrEqual(2500)
    }
    for (const w of preVerifyWaits) {
      expect(w).toBeGreaterThanOrEqual(3000)
      expect(w).toBeLessThanOrEqual(5000)
    }
    for (const w of verifyWaits) {
      expect(w).toBeGreaterThanOrEqual(2500)
      expect(w).toBeLessThanOrEqual(3500)
    }
    expect(new Set(preShotWaits).size).toBeGreaterThan(1)
    expect(new Set(preVerifyWaits).size).toBeGreaterThan(1)
    expect(new Set(verifyWaits).size).toBeGreaterThan(1)
  }, 30000)

  it('小图刷新二次识别命中后再点确认：初次点 + 确认点（均 500ms 稳定性轮询）+ src 未变无 selected 重试点（1500-2500ms 随机），验证前 3000-5000ms', async () => {
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
    const retryWaits: number[] = []
    const preVerifyWaits: number[] = []
    const verifyWaits: number[] = []
    const allWaits: number[] = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    for (let i = 0; i < 8; i++) {
      await expect(runOnce()).resolves.toBe('solved')
      const start = allWaits.length
      allWaits.push(...(page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.slice(start).map((c: unknown[]) => c[0] as number))
      const waits = allWaits.slice(start)
      // 每轮顺序：500ms 轮询 → 截图前动画稳定 1500-2500ms → shotGrid 内部 800ms → 格子 0/2 等待（500ms 稳定性轮询或 1500-2500ms 重试随机）
      // → 验证前全体稳定 3000-5000ms → 验证后 2500-3500ms
      // 首轮：格子 0 初次稳定 500 + 确认稳定 500 + 重试随机；后续轮 src 已稳定为 B：格子 0 初次稳定 500 + 两次重试随机——中间段位置随轮次不同，按取值分桶断言
      expect(waits[0]).toBe(500)
      expect(waits[1]).toBeGreaterThanOrEqual(1500)
      expect(waits[1]).toBeLessThanOrEqual(2500)
      expect(waits[2]).toBe(800)
      // 首格初次点击后的稳定性轮询固定 500ms
      expect(waits[3]).toBe(500)
      for (const w of waits.slice(4, waits.length - 2)) {
        if (w === 500) continue
        expect(w).toBeGreaterThanOrEqual(1500)
        expect(w).toBeLessThanOrEqual(2500)
        retryWaits.push(w)
      }
      preVerifyWaits.push(waits[waits.length - 2])
      verifyWaits.push(waits[waits.length - 1])
    }
    expect(retryWaits.length).toBeGreaterThan(0)
    for (const w of retryWaits) {
      expect(w).toBeGreaterThanOrEqual(1500)
      expect(w).toBeLessThanOrEqual(2500)
    }
    for (const w of preVerifyWaits) {
      expect(w).toBeGreaterThanOrEqual(3000)
      expect(w).toBeLessThanOrEqual(5000)
    }
    for (const w of verifyWaits) {
      expect(w).toBeGreaterThanOrEqual(2500)
      expect(w).toBeLessThanOrEqual(3500)
    }
    expect(new Set(retryWaits).size).toBeGreaterThan(1)
    expect(new Set(preVerifyWaits).size).toBeGreaterThan(1)
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

  it('网格图走容器元素截图：截图前先等 1500-2500ms 动画稳定 + shotGrid 内部 800ms，解出图 300x300', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({ gridScreenshotBuf: gridBuf })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
    const [imageArg] = (captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[0]
    const img = await Jimp.read(Buffer.from(imageArg, 'base64'))
    expect(img.getWidth()).toBe(300)
    expect(img.getHeight()).toBe(300)
    // 截图前存在 1500-2500ms 动画稳定等待与 shotGrid 内部 800ms 稳定等待（动画未稳定时截图内容错乱，删除会失败）
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits[0]).toBe(500)
    expect(waits[1]).toBeGreaterThanOrEqual(1500)
    expect(waits[1]).toBeLessThanOrEqual(2500)
    expect(waits[2]).toBe(800)
  }, 30000)

  it('img 不稳定时等待稳定：点击后 src 连续两次相同才进入确认流程（不提前点 verify，该格确认流程只处理一次）', async () => {
    const gridBuf = await makePngBuffer(300)
    const tileBuf = await makePngBuffer(100)
    // src 读取序列：点击前 A → 点击后 B（刷新动画）→ 动画抖动 C → 稳定 B、B（连续两次相同）
    const srcSeq = ['A', 'B', 'C', 'B', 'B', 'B', 'B', 'B', 'B']
    let srcReads = 0
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: { attrs: { class: 'rc-imageselect-tile' }, screenshotBuf: tileBuf, srcImpl: async () => srcSeq[Math.min(srcReads++, srcSeq.length - 1)] } },
    })
    let solveCall = 0
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      solveCall++
      return solveCall === 1 ? { type: 'multi', objects: [0] } : { type: 'single', hasObject: false }
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // src 被多次轮询读取（等稳定期间 ≥6 次读取：点击前 1 + 点击后轮询 3 + 确认流程 1；不轮询直接进确认只会读 2 次）
    expect(srcReads).toBeGreaterThanOrEqual(6)
    // 确认流程只处理一次：小图二次识别恰好 1 次（multi + single 共 2 次分类）、该格只点 1 次（动画未稳定时不提前判定 src 变化）
    expect(captcha.solveGrid).toHaveBeenCalledTimes(2)
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
  }, 30000)

  it('格子 img 元素缺失时不轮询等待稳定（空串恒等假稳定不成立）：点击后直接进入验证前稳定等待', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: { count: 0 } },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    // 序列：挑战轮询 500 → 截图前 1500-2500 → shotGrid 内部 800 → 验证前 3000-5000 → 验证后 2500-3500
    // （无 img 稳定性 500ms 轮询：img 缺失时若仍轮询 src，空串恒等会立刻假稳定——此断言失败说明修复退化）
    expect(waits).toHaveLength(5)
    expect(waits[3]).toBeGreaterThanOrEqual(3000)
    expect(waits[3]).toBeLessThanOrEqual(5000)
  }, 30000)

  it('verify 前有稳定等待：点验证前 waitForTimeout 取 3000-5000ms（全体格子动画收尾），点后保持 2500-3500ms', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, verifyClick } = makeDeps({ gridScreenshotBuf: gridBuf, gridResult: { type: 'multi', objects: [0, 2] } })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(verifyClick).toHaveBeenCalledTimes(1)
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    // 点 verify 前最后一个非稳定轮询等待落在 3000-5000ms（删除全体稳定等待时该区间不存在 → 失败）
    const preVerifyIdx = waits.length - 2
    expect(waits[preVerifyIdx]).toBeGreaterThanOrEqual(3000)
    expect(waits[preVerifyIdx]).toBeLessThanOrEqual(5000)
    // 点 verify 后保持现有 2500-3500ms 随机等待
    expect(waits[waits.length - 1]).toBeGreaterThanOrEqual(2500)
    expect(waits[waits.length - 1]).toBeLessThanOrEqual(3500)
  }, 30000)

  it('小图 img 元素截图失败 → 跳过二次识别（该格只点 1 次、分类仅网格 1 次）', async () => {
    const gridBuf = await makePngBuffer(300)
    let src = 'A'
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: { screenshotBuf: null, srcImpl: async () => src, clickImpl: () => { src = 'B' } } },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 小图 img 截图拿不到图 → 不做二次识别确认：该格只点 1 次
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
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
