/**
 * 九宫格模拟点击模块单测：提示语映射纯函数 + 注入假 frame 的求解循环分支
 * 假 frame 用最小 locator 模拟器（按选择器分派行为），网格截图用 jimp 生成真实 PNG
 * 真机语义（2026-09-09 诊断）：点击后格子 td class 两类——dynamic-selected（图片刷新中，
 * 刷新完成后必须再点一次确认才算选中）与 tileselected（直接选中完成）；选点判定以 class 为准、
 * 不再依赖 img src（src 变化监测抓不到 1-6 秒才发生的刷新）；
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
import { mapQuestionId, solveRecaptchaGrid, findAnchorFrame, findChallengeFrame, toStandardBase64, readErrorHint, SUPPLEMENT_MAX, VERIFY_VISIBLE_POLLS, VERIFY_VISIBLE_RETRY_POLLS, CONFIRM_MAX, ANCHOR_FRAME_PART, CHALLENGE_FRAME_PART, ANCHOR_SELECTOR, PROMPT_SELECTOR, TILE_SELECTOR, VERIFY_SELECTOR, GRID_SELECTOR, RELOAD_SELECTOR, RELOAD_MAX } from '../src/automation/recaptcha-grid'
import { CaptchaFailure } from '../src/integrations/yescaptcha'

/** 真机核实（2026-09-09）：页面常驻 v3 sitekey；挑战时动态插入 v2 sitekey */
const V3 = '6LcNs_0pAAAAAJuAAa-VQryi8XsocHubBk-YlUy2'
const V2 = '6LcCqC8sAAAAAHGuWXnlpxcEYJD3lE_EFLebNnve'

/** 错误提示候选元素（挑战 frame 内；verify 后按优先级轮询检测） */
const ERROR_HINT_SELECTORS = [
  '.rc-imageselect-error-select-more',
  '.rc-imageselect-error-select-something',
  '.rc-imageselect-error-dynamic-more',
  '.rc-imageselect-error-dynamic-select-more',
  '.rc-imageselect-incorrect-response',
]
/** 无错误提示时 verify 后轮询的 500ms 间隔等待次数（5s 超时：首查立即 + 9 次间隔等待） */
const ERROR_POLL_WAITS = 9

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
  /** img src 动态读取（点击后变化模拟 Google 小图刷新；点击诊断快照用） */
  srcImpl?: () => Promise<string | null>
  /** td class 动态读取（每次读取时调用；模拟点击后 dynamic-selected/tileselected 状态流转） */
  classImpl?: () => Promise<string | null>
  /** 动态 textContent（每次读取时调用；缺省回落 text 静态值） */
  textContentImpl?: () => Promise<string | null>
  /** 按索引分派的子行为：nth(i) 返回独立实例（每个索引独立 click mock），未命中回落到当前行为 */
  nthBehaviors?: Record<number, ElemBehavior>
  /** evaluate 返回的固定盒中心（framePoint 拟人点击坐标用；缺省 null → 拟人点击回退 locator 直点） */
  box?: { x: number; y: number } | null
  /** 动态 count（每次调用执行；供模拟 verify 按钮延迟出现等场景） */
  countImpl?: () => Promise<number>
  /** 静态 isVisible（缺省 true：verify 按钮默认立即可见，保持既有用例语义） */
  isVisible?: boolean
  /** 动态 isVisible（每次调用执行；供模拟 verify 按钮恒不可见等场景） */
  isVisibleImpl?: () => Promise<boolean>
}

function makeFrame(behaviors: Record<string, ElemBehavior>, extra: { frameElement?: () => Promise<unknown>; snapshots?: () => string[] } = {}) {
  const build = (b: ElemBehavior) => {
    const click = b.click ?? vi.fn().mockResolvedValue(undefined)
    return {
      first: () => build(b),
      nth: (i: number) => build(b.nthBehaviors?.[i] ?? b),
      locator: () => build(b),
      count: vi.fn().mockImplementation(async () => b.countImpl ? b.countImpl() : (b.count ?? 0)),
      isVisible: vi.fn().mockImplementation(async () => b.isVisibleImpl ? b.isVisibleImpl() : (b.isVisible ?? true)),
      getAttribute: vi.fn().mockImplementation(async (name: string) => {
        if (b.classImpl && name === 'class') return b.classImpl()
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
  const evaluate = vi.fn().mockImplementation(async () => (extra.snapshots ?? (() => []))())
  return { locator, frameElement, evaluate }
}

/** 造一张纯色 PNG（供 jimp 缩放链路） */
async function makePngBuffer(size: number): Promise<Buffer> {
  const img = new Jimp(size, size, 0x22aaffff)
  return img.getBufferAsync(Jimp.MIME_PNG)
}

describe('readErrorHint 错误提示检测', () => {
  it('select-more 系列各候选元素命中 → select-more', async () => {
    for (const sel of ERROR_HINT_SELECTORS.slice(0, 4)) {
      const ch = makeFrame({ [sel]: { count: 1, text: '请选择所有匹配的图片' } })
      await expect(readErrorHint(ch as never)).resolves.toBe('select-more')
    }
  })

  it('incorrect-response 命中 → incorrect', async () => {
    const ch = makeFrame({ '.rc-imageselect-incorrect-response': { count: 1, text: '请重试' } })
    await expect(readErrorHint(ch as never)).resolves.toBe('incorrect')
  })

  it('多提示并存按优先级：select-more 先于 incorrect', async () => {
    const ch = makeFrame({
      '.rc-imageselect-incorrect-response': { count: 1, text: '请重试' },
      '.rc-imageselect-error-select-more': { count: 1, text: '请选择所有匹配的图片' },
    })
    await expect(readErrorHint(ch as never)).resolves.toBe('select-more')
  })

  it('无任何提示 → null（元素缺失 / 空白文本）', async () => {
    await expect(readErrorHint(makeFrame({}) as never)).resolves.toBeNull()
    await expect(readErrorHint(makeFrame({ '.rc-imageselect-error-select-more': { count: 1, text: '   ' } }) as never)).resolves.toBeNull()
  })
})

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
    /** 错误提示文本（动态读取；缺省恒空 → 无提示） */
    hintImpl?: () => string | null
    /** verify 点击回调（第 N 次点击触发；模拟点 verify 后错误提示出现/消失） */
    onVerifyClick?: (count: number) => void
    /** verify 按钮 count 动态实现（缺省恒 1：按钮立即可见，保持既有用例语义） */
    verifyCountImpl?: () => Promise<number>
    /** verify 按钮 isVisible 动态实现（缺省恒 true） */
    verifyIsVisibleImpl?: () => Promise<boolean>
    /** snapshotTileSrcs 全网格快照动态实现（缺省恒空数组：保持既有用例「无可变格」语义） */
    tileSnapshots?: () => string[]
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
    // 缺省 class 含 selected（模拟「点击直接选中无需确认」）；dynamic-selected/tileselected 状态流转由 tileBehaviors.classImpl 覆盖
    const tileClicks = Array.from({ length: o.tileCount }, () => vi.fn().mockResolvedValue(undefined))
    const tileNth: Record<number, ElemBehavior> = {}
    for (let i = 0; i < o.tileCount; i++) {
      const { clickImpl, ...extra } = o.tileBehaviors?.[i] ?? {}
      if (clickImpl) tileClicks[i] = vi.fn().mockImplementation(async () => { clickImpl() })
      tileNth[i] = { click: tileClicks[i], attrs: { class: 'rc-imageselect-tile selected' }, box: o.tileBox ?? null, count: 1, ...extra }
    }
    // 刷新换图按钮与验证按钮独立 click mock（供「换图重试」「不点 verify」断言）
    // 错误提示候选元素全部注册：文本按内容路由到对应元素（'请重试' 只出现在 incorrect 元素、
    // 其余文本只出现在 select-more 系列）——模拟真机 DOM 语义，避免所有选择器共享同一文本导致探针误命中
    const hintText = () => o.hintImpl?.() ?? ''
    const hintBehaviors: Record<string, ElemBehavior> = {}
    for (const sel of ERROR_HINT_SELECTORS) {
      const isIncorrectSel = sel === '.rc-imageselect-incorrect-response'
      hintBehaviors[sel] = {
        count: 1,
        textContentImpl: async () => {
          const t = hintText()
          if (!t) return ''
          return isIncorrectSel === (t === '请重试') ? t : ''
        },
      }
    }
    const reloadClick = vi.fn().mockResolvedValue(undefined)
    let verifyCalls = 0
    const verifyClick = vi.fn().mockImplementation(async () => { verifyCalls++; checked = 'true'; o.onVerifyClick?.(verifyCalls) })
    const challenge = makeFrame({
      [PROMPT_SELECTOR]: { text: o.prompt, textContentImpl: o.promptImpl },
      [TILE_SELECTOR]: { count: o.tileCount, attrs: { class: 'rc-imageselect-tile selected' }, nthBehaviors: tileNth },
      [GRID_SELECTOR]: { screenshotBuf: o.gridScreenshotBuf, screenshotImpl: o.gridScreenshotImpl },
      [VERIFY_SELECTOR]: { count: 1, click: verifyClick, ...(o.verifyCountImpl ? { countImpl: o.verifyCountImpl } : {}), ...(o.verifyIsVisibleImpl ? { isVisibleImpl: o.verifyIsVisibleImpl } : {}) },
      [RELOAD_SELECTOR]: { click: reloadClick },
      ...hintBehaviors,
    }, { frameElement: o.challengeFrameElementImpl ?? (async () => null), snapshots: o.tileSnapshots ?? (() => []) })
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
          ...(o.challengePresent && framesCalls >= (o.challengeAppearsOnFrameCall ?? 1) ? [{ url: () => `https://www.google.com/${CHALLENGE_FRAME_PART}?hl=zh-CN`, locator: challenge.locator, frameElement: challenge.frameElement, evaluate: challenge.evaluate }] : []),
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

  it('点击节奏随机化：截图前 1500-2500ms、点格后稳定 1500-2500ms、点验证前 3000-5000ms、点验证后 2500-3500ms，随机区间多次运行取值不同', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({ gridScreenshotBuf: gridBuf, gridResult: { type: 'multi', objects: [0, 2] } })
    // 多轮运行观察取值方差：固定等待则所有取值相同 → 断言失败；随机化则几乎必然出现不同取值
    const preVerifyWaits: number[] = []
    const verifyWaits: number[] = []
    const preShotWaits: number[] = []
    const tileWaits: number[] = []
    const allWaits: number[] = []
    for (let i = 0; i < 12; i++) {
      await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
      const start = allWaits.length
      allWaits.push(...(page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.slice(start).map((c: unknown[]) => c[0] as number))
      const waits = allWaits.slice(start)
      // 每轮顺序：挑战 frame 轮询 500ms → 截图前动画稳定 1500-2500ms → shotGrid 内部稳定 800ms
      // → 格子 0 点击后稳定 1500-2500ms → 格子 2 点击后稳定 1500-2500ms
      // → 验证前全体稳定 3000-5000ms → 验证后 2500-3500ms → 错误提示轮询 9×500ms（无提示）
      expect(waits).toHaveLength(3 + 2 + 2 + ERROR_POLL_WAITS)
      expect(waits[0]).toBe(500)
      expect(waits[1]).toBeGreaterThanOrEqual(1500)
      expect(waits[1]).toBeLessThanOrEqual(2500)
      expect(waits[2]).toBe(800)
      preShotWaits.push(waits[1])
      for (const base of [3, 4]) {
        expect(waits[base]).toBeGreaterThanOrEqual(1500)
        expect(waits[base]).toBeLessThanOrEqual(2500)
        tileWaits.push(waits[base])
      }
      preVerifyWaits.push(waits[5])
      verifyWaits.push(waits[6])
      for (const w of waits.slice(7)) expect(w).toBe(500)
    }
    for (const w of preShotWaits) {
      expect(w).toBeGreaterThanOrEqual(1500)
      expect(w).toBeLessThanOrEqual(2500)
    }
    for (const w of tileWaits) {
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
    expect(new Set(tileWaits).size).toBeGreaterThan(1)
    expect(new Set(preVerifyWaits).size).toBeGreaterThan(1)
    expect(new Set(verifyWaits).size).toBeGreaterThan(1)
  }, 30000)

  it('dynamic-selected 确认再点：点击后 class 为 dynamic-selected → 轮询等刷新完成 → 确认点击后变 tileselected（该格共 2 点）', async () => {
    const gridBuf = await makePngBuffer(300)
    let clicks = 0
    let reads = 0
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: {
        classImpl: async () => {
          reads++
          if (clicks < 1) return 'rc-imageselect-tile'
          if (clicks === 1) return reads <= 3 ? 'rc-imageselect-tile dynamic-selected' : 'rc-imageselect-tile'
          return 'rc-imageselect-tile tileselected'
        },
        clickImpl: () => { clicks++ },
      } },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 初次点击 + dynamic-selected 确认点击：共 2 点（确认流程缺失时只点 1 次，此断言失败）
    expect(tileClicks[0]).toHaveBeenCalledTimes(2)
    // 确认日志带 confirmed: true（排障用）
    expect(logger.info).toHaveBeenCalledWith({ step: 'grid-tile-confirm', idx: 0, confirmed: true }, '九宫格格子动态刷新确认')
    // 确认判定以 class 为准、不再依赖 src：小图二次识别/分类不发生（分类仅网格 multi 1 次）
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
    // 等待序列：挑战 500 → 截图前 1500-2500 → 800 → 点击后稳定 1500-2500 → dynamic 轮询 500×1
    // → 确认后稳定 1500-2500 → 验证前 3000-5000 → 验证后 2500-3500 → 错误提示轮询 9×500
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits).toHaveLength(3 + 1 + 1 + 1 + 2 + ERROR_POLL_WAITS)
    expect(waits[0]).toBe(500)
    expect(waits[1]).toBeGreaterThanOrEqual(1500)
    expect(waits[1]).toBeLessThanOrEqual(2500)
    expect(waits[2]).toBe(800)
    expect(waits[3]).toBeGreaterThanOrEqual(1500)
    expect(waits[3]).toBeLessThanOrEqual(2500)
    expect(waits[4]).toBe(500)
    expect(waits[5]).toBeGreaterThanOrEqual(1500)
    expect(waits[5]).toBeLessThanOrEqual(2500)
    expect(waits[6]).toBeGreaterThanOrEqual(3000)
    expect(waits[6]).toBeLessThanOrEqual(5000)
  }, 30000)

  it('tileselected 无需确认：点击后 class 直接 tileselected → 该格只点 1 次、不打确认日志', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: { attrs: { class: 'rc-imageselect-tile tileselected' } } },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // tileselected 直接选中完成：只点初次 1 次（误判为 dynamic 走确认流程会在此失败）
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    expect(logger.info).not.toHaveBeenCalledWith(expect.objectContaining({ step: 'grid-tile-confirm' }), '九宫格格子动态刷新确认')
    expect(logger.warn).not.toHaveBeenCalledWith({ idx: 0 }, '九宫格该格点击未注册（class 无 selected 字样），不重试点击（select-more 兜底）')
    // 无 dynamic 轮询等待：对比 dynamic 用例少 500ms 轮询与确认稳定等待
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits).toHaveLength(3 + 1 + 2 + ERROR_POLL_WAITS)
  }, 30000)

  it('dynamic 刷新等待：dynamic-selected 保持多次轮询后才刷新完成 → 确认点击发生在刷新完成后', async () => {
    const gridBuf = await makePngBuffer(300)
    const events: string[] = []
    let clicks = 0
    let reads = 0
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: {
        classImpl: async () => {
          reads++
          events.push('read')
          if (clicks < 1) return 'rc-imageselect-tile'
          if (clicks === 1) return reads <= 5 ? 'rc-imageselect-tile dynamic-selected' : 'rc-imageselect-tile'
          return 'rc-imageselect-tile tileselected'
        },
        clickImpl: () => { clicks++; events.push(`click-${clicks}`) },
      } },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(tileClicks[0]).toHaveBeenCalledTimes(2)
    // 确认点击（click-2）发生在 6 次 class 读取之后（第 6 次读到刷新完成、第 2/3/4/5 次仍 dynamic；
    // 刷新未完成就确认 → click-2 位置提前在此失败）
    const confirmIdx = events.indexOf('click-2')
    expect(confirmIdx).toBeGreaterThan(-1)
    expect(events.slice(0, confirmIdx).filter((e) => e === 'read').length).toBe(6)
    // dynamic 轮询 3×500ms 间隔（4 次轮询读取见非 dynamic），确认等待落在 1500-2500ms
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits).toHaveLength(3 + 1 + 3 + 1 + 2 + ERROR_POLL_WAITS)
    expect(waits[4]).toBe(500)
    expect(waits[5]).toBe(500)
    expect(waits[6]).toBe(500)
    expect(waits[7]).toBeGreaterThanOrEqual(1500)
    expect(waits[7]).toBeLessThanOrEqual(2500)
    expect(waits[8]).toBeGreaterThanOrEqual(3000)
    expect(waits[8]).toBeLessThanOrEqual(5000)
  }, 30000)

  it('dynamic-selected 确认后仍 dynamic → 再确认最多 CONFIRM_MAX 轮，仍 dynamic 记 warn 继续（select-more 兜底）', async () => {
    const gridBuf = await makePngBuffer(300)
    let clicks = 0
    const { page, captcha, logger, tileClicks, verifyClick } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      tileBehaviors: { 0: {
        classImpl: async () => (clicks < 1 ? 'rc-imageselect-tile' : 'rc-imageselect-tile dynamic-selected'),
        clickImpl: () => { clicks++ },
      } },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 初次 1 点 + CONFIRM_MAX 次确认点：共 3 点；仍 dynamic 不再多点（防死循环/取消已选）
    expect(tileClicks[0]).toHaveBeenCalledTimes(1 + CONFIRM_MAX)
    const confirmLogs = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => c[1] === '九宫格格子动态刷新确认')
    expect(confirmLogs).toHaveLength(CONFIRM_MAX)
    expect(logger.warn).toHaveBeenCalledWith({ idx: 0 }, '九宫格该格多次确认后仍处动态刷新，继续（select-more 兜底）')
    // 照常点 verify（select-more 兜底不阻塞验证流程）
    expect(verifyClick).toHaveBeenCalledTimes(1)
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

  it('verify 前有稳定等待：点验证前 waitForTimeout 取 3000-5000ms（全体格子动画收尾），点后保持 2500-3500ms', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, verifyClick } = makeDeps({ gridScreenshotBuf: gridBuf, gridResult: { type: 'multi', objects: [0, 2] } })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(verifyClick).toHaveBeenCalledTimes(1)
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    // 点 verify 前最后一个非稳定轮询等待落在 3000-5000ms（删除全体稳定等待时该区间不存在 → 失败）；
    // 其后为 verify 后 2500-3500ms 与无提示时的 9 次 500ms 错误提示轮询
    const preVerifyIdx = waits.length - 2 - ERROR_POLL_WAITS
    expect(waits[preVerifyIdx]).toBeGreaterThanOrEqual(3000)
    expect(waits[preVerifyIdx]).toBeLessThanOrEqual(5000)
    // 点 verify 后保持现有 2500-3500ms 随机等待
    expect(waits[preVerifyIdx + 1]).toBeGreaterThanOrEqual(2500)
    expect(waits[preVerifyIdx + 1]).toBeLessThanOrEqual(3500)
    for (const w of waits.slice(preVerifyIdx + 2)) expect(w).toBe(500)
  }, 30000)

  it('verify 后出现 select-more → 放宽阈值补选：第二次分类带 confidence 0.3、新格子被点、verify 点 2 次', async () => {
    const gridBuf = await makePngBuffer(300)
    let hint = ''
    const { page, captcha, logger, tileClicks, verifyClick } = makeDeps({
      gridScreenshotBuf: gridBuf,
      hintImpl: () => hint,
      onVerifyClick: (n) => { hint = n === 1 ? '请选择所有匹配的图片' : '' },
    })
    let solveCall = 0
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      solveCall++
      return solveCall === 1 ? { type: 'multi', objects: [0, 2] } : { type: 'multi', objects: [2, 4] }
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 分类 2 次：网格初次 + 补选；补选带 confidence 0.3 且 onLog 照常透传（成本记账）
    expect(captcha.solveGrid).toHaveBeenCalledTimes(2)
    expect((captcha.solveGrid as ReturnType<typeof vi.fn>).mock.calls[1][2]).toMatchObject({ confidence: 0.3, onLog: expect.any(Function) })
    // 补选只点本轮未点过的格子 4（2 已点过跳过）
    expect(tileClicks[4]).toHaveBeenCalledTimes(1)
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    expect(tileClicks[2]).toHaveBeenCalledTimes(1)
    expect(tileClicks[3]).not.toHaveBeenCalled()
    expect(verifyClick).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith({ hint: 'select-more' }, '九宫格选择不完整，放宽阈值补选')
  }, 30000)

  it('verify 后出现 incorrect → 不补选不重验：分类只 1 次、verify 只 1 次', async () => {
    const gridBuf = await makePngBuffer(300)
    let hint = ''
    const { page, captcha, logger, verifyClick } = makeDeps({
      gridScreenshotBuf: gridBuf,
      hintImpl: () => hint,
      onVerifyClick: () => { hint = '请重试' },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // incorrect 已刷题：Google 换题后本轮结束，由主循环下一轮处理（不补选、不重验）
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1)
    expect(verifyClick).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith({ hint: 'incorrect' }, '九宫格选择错误（Google 已刷题），返回主循环下一轮')
  }, 30000)

  it('select-more 持续出现 → 最多补选 SUPPLEMENT_MAX 次后返回（不再点第 4 次 verify）', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, verifyClick, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      hintImpl: () => '请选择所有匹配的图片',
    })
    let solveCall = 0
    ;(captcha.solveGrid as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      solveCall++
      return solveCall === 1 ? { type: 'multi', objects: [0, 2] } : { type: 'multi', objects: [4] }
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 初次分类 1 次 + 补选分类 2 次；verify 初次 + 2 次重验；补选只点新格子 4 一次
    expect(captcha.solveGrid).toHaveBeenCalledTimes(1 + SUPPLEMENT_MAX)
    expect(verifyClick).toHaveBeenCalledTimes(1 + SUPPLEMENT_MAX)
    expect(tileClicks[4]).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledTimes(SUPPLEMENT_MAX)
  }, 30000)

  it('点击后 class 无 selected 字样不重试点击：该格只点初次 1 次，warn 记录，流程继续点 verify（重试会取消已选中格）', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, tileClicks, verifyClick } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      // class 无 selected 字样（模拟点击未注册：Google 刷新响应慢/忽略程序化点击）
      tileBehaviors: { 0: { attrs: { class: 'rc-imageselect-tile' } } },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 不重试点击（重试会取消已选中格，真机 2026-09-09 观察）：该格只点初次 1 次
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    // 点击真未注册时由 select-more 补选兜底，本轮仍继续点验证
    expect(verifyClick).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith({ idx: 0 }, '九宫格该格点击未注册（class 无 selected 字样），不重试点击（select-more 兜底）')
  }, 30000)

  it('等验证按钮可见再点：verify 前 2 次轮询不可见（count 0）、第 3 次可见后才点（点击恰 1 次且时机在可见轮询之后）', async () => {
    const gridBuf = await makePngBuffer(300)
    const events: string[] = []
    let polls = 0
    const { page, captcha, logger, verifyClick } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0] },
      verifyCountImpl: async () => { polls++; events.push('poll'); return polls >= 3 ? 1 : 0 },
      onVerifyClick: () => { events.push('verify-click') },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // verify 只点 1 次，且发生在 3 次可见轮询之后（按钮不可见时点击 → 事件顺序错误在此失败）
    expect(verifyClick).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e === 'poll').length).toBe(3)
    expect(events.indexOf('verify-click')).toBeGreaterThan(events.lastIndexOf('poll'))
    // 等待序列：挑战 500 → 截图前 1500-2500 → 800 → 格子 0 点击后稳定 1500-2500
    // → 验证前 3000-5000 → 可见轮询 500×2 → 验证后 2500-3500 → 错误提示轮询 9×500
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits).toHaveLength(3 + 1 + 1 + 2 + 1 + ERROR_POLL_WAITS)
    expect(waits[0]).toBe(500)
    expect(waits[1]).toBeGreaterThanOrEqual(1500)
    expect(waits[1]).toBeLessThanOrEqual(2500)
    expect(waits[2]).toBe(800)
    expect(waits[3]).toBeGreaterThanOrEqual(1500)
    expect(waits[3]).toBeLessThanOrEqual(2500)
    expect(waits[4]).toBeGreaterThanOrEqual(3000)
    expect(waits[4]).toBeLessThanOrEqual(5000)
    expect(waits[5]).toBe(500)
    expect(waits[6]).toBe(500)
    expect(waits[7]).toBeGreaterThanOrEqual(2500)
    expect(waits[7]).toBeLessThanOrEqual(3500)
    for (const w of waits.slice(8)) expect(w).toBe(500)
  }, 30000)

  it('验证按钮 8s 恒不可见 → 补点本轮未选中格（class 不含 selected）→ 再等 5s 仍不可见 → 放弃本轮不点 verify', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger, tileClicks, verifyClick } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0, 2] },
      verifyIsVisibleImpl: async () => false,
      // 格 0 class 含 selected（已选中不补点）；格 2 无 selected（补点目标）
      tileBehaviors: { 2: { attrs: { class: 'rc-imageselect-tile' } } },
    })
    await expect(solveRecaptchaGrid(
      { page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never },
      { maxRounds: 1 },
    )).resolves.toBe('failed')
    // 补点只点未选中格：格 0 只初次 1 点，格 2 初次 + 补点共 2 点
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    expect(tileClicks[2]).toHaveBeenCalledTimes(2)
    // 放弃本轮：不点 verify
    expect(verifyClick).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('九宫格验证按钮未出现，补点本轮未选中格')
    expect(logger.warn).toHaveBeenCalledWith({ idx: 2 }, '九宫格补点未选中格')
    expect(logger.warn).toHaveBeenCalledWith('九宫格补点后验证按钮仍不可见，放弃本轮')
    // 等待序列含两段可见轮询：首段 15×500（8s 预算）+ 补点后 9×500（5s 预算）
    const waits = (page.waitForTimeout as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as number)
    expect(waits.filter((w) => w === 500).length).toBeGreaterThanOrEqual((VERIFY_VISIBLE_POLLS - 1) + (VERIFY_VISIBLE_RETRY_POLLS - 1))
  }, 30000)

  it('每轮结束输出 grid-round-state 状态快照日志（识别目标/点选格/错误提示/换图次数，数据收集用）', async () => {
    const gridBuf = await makePngBuffer(300)
    const { page, captcha, logger } = makeDeps({ gridScreenshotBuf: gridBuf, gridResult: { type: 'multi', objects: [0, 2] } })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(logger.info).toHaveBeenCalledWith({
      step: 'grid-round-state',
      prompt: '停车计时器',
      qid: '/m/015qbp',
      objects: [0, 2],
      hint: null,
      reloads: 0,
    }, '九宫格轮次状态')
  }, 30000)

  it('verify 后出现 incorrect → 轮次快照带 hint incorrect', async () => {
    const gridBuf = await makePngBuffer(300)
    let hint = ''
    const { page, captcha, logger } = makeDeps({
      gridScreenshotBuf: gridBuf,
      hintImpl: () => hint,
      onVerifyClick: () => { hint = '请重试' },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ step: 'grid-round-state', hint: 'incorrect' }), '九宫格轮次状态')
  }, 30000)

  it('点击诊断日志：点后全网格 src 快照对比输出 hitTiles/idx/前后 class（漂移命中邻居格一真机可定位）', async () => {
    const gridBuf = await makePngBuffer(300)
    // 每格点击前后各一次快照：格 0 点前后无变化（未命中）→ hitTiles=[]；
    // 格 2 点后快照中格 1 变 X（坐标漂移到邻居）+ 格 2 自身刷新 a2b → hitTiles=[1,2]
    let snapCall = 0
    const snapshots = [
      ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
      ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
      ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
      ['a0', 'X', 'a2b', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'],
    ]
    const { page, captcha, logger, tileClicks } = makeDeps({
      gridScreenshotBuf: gridBuf,
      gridResult: { type: 'multi', objects: [0, 2] },
      tileSnapshots: () => snapshots[Math.min(snapCall++, snapshots.length - 1)],
      tileBehaviors: {
        0: { attrs: { class: 'rc-imageselect-tile selected' } },
        1: { attrs: { class: 'rc-imageselect-tile' } },
        2: { attrs: { class: 'rc-imageselect-tile selected' } },
      },
    })
    await expect(solveRecaptchaGrid({ page: page as never, captcha: captcha as never, logger: logger as never, human: {} as never })).resolves.toBe('solved')
    // 每格一次诊断日志：格 0 快照无变化（未命中）→ hitTiles=[]；格 2 快照含邻居格 1 + 自身 → hitTiles=[1,2]
    expect(logger.info).toHaveBeenCalledWith({
      step: 'grid-click-diag',
      idx: 0,
      hitTiles: [],
      beforeClass: 'rc-imageselect-tile selected',
      afterClass: 'rc-imageselect-tile selected',
    }, '九宫格点击诊断')
    expect(logger.info).toHaveBeenCalledWith({
      step: 'grid-click-diag',
      idx: 2,
      hitTiles: [1, 2],
      beforeClass: 'rc-imageselect-tile selected',
      afterClass: 'rc-imageselect-tile selected',
    }, '九宫格点击诊断')
    // 非点选格 1 只被快照观测（坐标漂移记录进格 2 的 hitTiles 诊断数据），不被点选
    expect(tileClicks[0]).toHaveBeenCalledTimes(1)
    expect(tileClicks[1]).not.toHaveBeenCalled()
    expect(tileClicks[2]).toHaveBeenCalledTimes(1)
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
