import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAX_ROUNDS_DEFAULT, solveRecaptchaGrid, findAnchorFrame, findChallengeFrame } from '../src/automation/captcha/grid'
import { CaptchaFailure } from '../src/integrations/captcha/provider'

// mock node:fs 写盘（grid-debug 诊断落盘只在真机有意义）
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(), mkdirSync: vi.fn(), existsSync: vi.fn(() => false), readdirSync: vi.fn(() => []), unlinkSync: vi.fn(),
}))
// mock jimp 读取：真实图片解码在单测用不到（单格确认走假图）
vi.mock('jimp', () => ({ default: { read: vi.fn(async () => ({ getWidth: () => 300, getHeight: () => 300, crop: function () { return this }, resize: async function () {}, getBufferAsync: async () => Buffer.from('png') })) } }))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface FakeTile {
  cls: string
  src: string
  /** 点击是否注册为选中（默认 true；false 模拟原生点击未注册） */
  register?: boolean
  /** 点击后图片刷新的新 src（模拟 Google 刷新格子整图；未设置不刷新） */
  refreshSrc?: string
  /** 该格被点击次数（断言用） */
  clicks: number
}
interface FakeFrameState {
  anchorChecked: boolean
  anchorClicked: boolean
  prompt: string
  /** 提示语前 N 次读取返回空（模拟 bframe DOM 晚于 frame 附着渲染）；默认 0 */
  promptEmptyReads: number
  /** 提示语已被读取次数（轮询断言用） */
  promptReads: number
  tiles: FakeTile[]
  verifyClicked: boolean
  /** verify 点击后是否让 anchor 变绿（模拟「选对才过」；多轮失败用例设 false） */
  verifySolves: boolean
  wrapperImg: { src: string; naturalWidth: number } | null
}

/** 构造 fake frame 世界：anchor frame + challenge bframe */
function makePage(state: FakeFrameState) {
  const anchorElem = {
    click: vi.fn(async () => { state.anchorClicked = true }),
    getAttribute: vi.fn(async (n: string) => (n === 'aria-checked' ? String(state.anchorChecked) : null)),
  }
  const anchorLoc = {
    first: () => anchorElem,
    nth: () => anchorElem,
  }
  const chLocator = (sel: string) => {
    const first = () => {
      if (sel.includes('.rc-imageselect-desc-wrapper')) {
        return { textContent: vi.fn(async () => {
          state.promptReads++
          return state.promptReads > state.promptEmptyReads ? state.prompt : ''
        }), count: async () => 0 }
      }
      if (sel === '#recaptcha-verify-button') {
        return { click: vi.fn(async () => { state.verifyClicked = true; if (state.verifySolves) state.anchorChecked = true }), count: async () => 0 }
      }
      if (sel === 'div.rc-image-tile-wrapper > img') {
        return { evaluate: vi.fn(async () => state.wrapperImg), count: async () => 0 }
      }
      if (sel.includes('table td')) {
        return {
          nth: (i: number) => {
            const t = state.tiles[i]
            return {
              click: vi.fn(async () => {
                t.clicks++
                // 首次点击触发图片刷新（src 变化不选中）；否则按 register 决定是否注册选中
                if (t.refreshSrc && t.src !== t.refreshSrc) { t.src = t.refreshSrc; return }
                if (t.register !== false) t.cls = (t.cls + ' selected').trim()
              }),
              getAttribute: vi.fn(async (n: string) => (n === 'class' ? t.cls : null)),
              locator: () => ({ first: () => ({ getAttribute: vi.fn(async (n: string) => (n === 'src' ? t.src : null)), screenshot: vi.fn(async () => Buffer.from('png')) }) }),
              evaluate: vi.fn(async () => ({ x: 50, y: 50 })),
            }
          },
        }
      }
      return { textContent: vi.fn(async () => ''), click: vi.fn(async () => {}), count: async () => 0 }
    }
    return {
      first: () => ({ ...first() }),
      nth: (i: number) => (sel.includes('table td') ? (first() as { nth: (n: number) => unknown }).nth(i) : first()),
    }
  }
  const anchorFrame = { url: () => 'https://www.google.com/recaptcha/enterprise/anchor?k=6LcV2', locator: () => anchorLoc }
  const chFrame = {
    url: () => 'https://www.google.com/recaptcha/enterprise/bframe?hl=zh-CN',
    locator: chLocator,
    // framePoint 用：frame 元素在页面坐标系的偏移（模拟 iframe 位于页面原点）
    frameElement: vi.fn(async () => ({ evaluate: vi.fn(async () => ({ x: 0, y: 0 })) })),
  }
  return {
    page: {
      frames: () => [anchorFrame, chFrame],
      waitForTimeout: async (ms: number) => { await sleep(Math.min(ms, 10)) },
      locator: () => anchorLoc,
    },
    anchorFrame,
    chFrame,
  }
}

const makeDeps = (state: FakeFrameState, classify: ReturnType<typeof vi.fn>) => ({
  page: makePage(state).page as never,
  provider: { platform: 'test', solveToken: vi.fn(), classifyGrid: classify, getBalance: vi.fn().mockResolvedValue(100000) } as never,
  logger: { info: vi.fn(), warn: vi.fn() } as never,
  human: { clickAt: vi.fn() } as never,
})

const baseState = (): FakeFrameState => ({
  anchorChecked: false, anchorClicked: false, prompt: '停车计时器', promptEmptyReads: 0, promptReads: 0,
  tiles: Array.from({ length: 9 }, () => ({ cls: '', src: 'img-0', clicks: 0 })),
  verifyClicked: false, verifySolves: true,
  wrapperImg: { src: 'data:image/png;base64,QUJD', naturalWidth: 300 },
})

describe('findAnchorFrame / findChallengeFrame', () => {
  it('siteKeyExclude 排除常驻 v3 锚点', () => {
    const page = { frames: () => [
      { url: () => 'https://www.google.com/recaptcha/enterprise/anchor?k=6LcV3' },
      { url: () => 'https://www.google.com/recaptcha/enterprise/anchor?k=6LcV2' },
    ] }
    const f = findAnchorFrame(page as never, '6LcV3')
    expect(f?.url().includes('6LcV2')).toBe(true)
  })

  it('api2 与 enterprise 都识别', () => {
    const page = { frames: () => [{ url: () => 'https://www.google.com/recaptcha/api2/bframe?k=6LcV2' }] }
    expect(findChallengeFrame(page as never)).not.toBeNull()
  })
})

describe('solveRecaptchaGrid 求解循环', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('无锚点 frame 返回 none', async () => {
    const deps = { ...makeDeps(baseState(), vi.fn()), page: { frames: () => [], waitForTimeout: async () => {}, locator: () => ({ first: () => ({ click: vi.fn(), getAttribute: vi.fn() }) }) } as never }
    await expect(solveRecaptchaGrid(deps as never)).resolves.toBe('none')
  })

  it('点锚点后一键通过（未出图）返回 solved 且不分类', async () => {
    const state = baseState()
    state.anchorChecked = true
    const classify = vi.fn()
    // 一键通过场景没有 bframe：frames 只含 anchor frame
    const { anchorFrame } = makePage(state)
    const deps = {
      page: { frames: () => [anchorFrame], waitForTimeout: async () => {}, locator: () => anchorFrame.locator() } as never,
      provider: { platform: 'test', solveToken: vi.fn(), classifyGrid: classify, getBalance: vi.fn().mockResolvedValue(100000) } as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      human: { clickAt: vi.fn() } as never,
    }
    await expect(solveRecaptchaGrid(deps as never)).resolves.toBe('solved')
    expect(classify).not.toHaveBeenCalled()
  })

  it('官方全流程：原生整图分类 → 点格 → 验证 → aria-checked 变绿 → solved', async () => {
    const state = baseState()
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(1)
    const [b64, qid] = classify.mock.calls[0]
    expect(qid).toBe('/m/015qbp')
    expect(typeof b64).toBe('string')
    expect(state.tiles[0].cls).toContain('selected')
    expect(state.tiles[2].cls).toContain('selected')
    expect(state.verifyClicked).toBe(true)
  })

  it('分类不传 confidence（官方 DEMO 默认阈值）', async () => {
    const state = baseState()
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0] })
    await solveRecaptchaGrid(makeDeps(state, classify) as never)
    expect(classify.mock.calls[0][2]).toBeUndefined()
  })

  it('主分类返回空数组：记 warn 跳过本轮，下一轮重分类', async () => {
    const state = baseState()
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [] })
      .mockResolvedValue({ type: 'multi', objects: [0] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it('提示语未覆盖映射抛错', async () => {
    const state = baseState()
    state.prompt = '潜水艇'
    await expect(solveRecaptchaGrid(makeDeps(state, vi.fn()) as never)).rejects.toThrow(/未覆盖/)
  })

  it('提示语首读为空（bframe 晚渲染）：轮询后读到再分类，求解成功', async () => {
    const state = baseState()
    state.promptEmptyReads = 1
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(state.promptReads).toBeGreaterThan(1)
    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify.mock.calls[0][1]).toBe('/m/015qbp')
  })

  it('多轮未通过（verifySolves=false，aria-checked 恒 false）达到 maxRounds=3 返回 failed', async () => {
    const state = baseState()
    state.verifySolves = false
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('failed')
    expect(classify.mock.calls.length).toBe(MAX_ROUNDS_DEFAULT)
  })

  it('maxRounds 透传生效（1 轮不过即 failed）', async () => {
    const state = baseState()
    state.verifySolves = false
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never, { maxRounds: 1 })).resolves.toBe('failed')
  })

  it('余额低于上限抛 CaptchaFailure（不烧点数）', async () => {
    const state = baseState()
    const deps = makeDeps(state, vi.fn().mockResolvedValue({ type: 'multi', objects: [0] }))
    ;(deps.provider as never as { getBalance: ReturnType<typeof vi.fn> }).getBalance.mockResolvedValue(10)
    await expect(solveRecaptchaGrid(deps as never, { maxCostPerTask: 1500 })).rejects.toBeInstanceOf(CaptchaFailure)
  })

  it('点击未注册：坐标拟人兜底重试一次后放弃该格，轮次继续走完', async () => {
    const state = baseState()
    state.tiles[0].register = false
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0] })
    const human = { clickAt: vi.fn() }
    const logger = { info: vi.fn(), warn: vi.fn() }
    const deps = { ...makeDeps(state, classify), human, logger } as never
    await expect(solveRecaptchaGrid(deps)).resolves.toBe('solved')
    expect(human.clickAt).toHaveBeenCalledTimes(1)
    expect(human.clickAt).toHaveBeenCalledWith(50, 50)
    expect(logger.warn).toHaveBeenCalledWith({ idx: 0 }, '九宫格该格点击未注册，坐标拟人点击兜底重试一次')
    expect(logger.warn).toHaveBeenCalledWith({ idx: 0 }, '九宫格该格点击仍未注册（放弃该格，交由下一轮兜底）')
    expect(state.tiles[0].clicks).toBe(1)
    expect(state.verifyClicked).toBe(true)
  })

  it('点击后图片刷新：单格 1x1 确认分类 hasObject=true 再点一次确认（2 点记账）', async () => {
    const state = baseState()
    state.tiles[0].refreshSrc = 'new-img'
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [0] })
      .mockResolvedValue({ type: 'single', hasObject: true })
    const onLog = vi.fn()
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never, { onLog })).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(2)
    expect(typeof classify.mock.calls[1][0]).toBe('string')
    expect(classify.mock.calls[1][1]).toBe('/m/015qbp')
    expect(state.tiles[0].clicks).toBe(2)
    expect(state.tiles[0].src).toBe('new-img')
    expect(state.tiles[0].cls).toContain('selected')
    // 记账走 onLog（不传 provider.classifyGrid）：主网格 6 点、单格 1x1 2 点（TILE_COST_POINTS）
    expect(onLog).toHaveBeenNthCalledWith(1, 'test', 'recaptcha_v2_grid', true, 6)
    expect(onLog).toHaveBeenNthCalledWith(2, 'test', 'recaptcha_v2_grid', true, 2)
  })

  it('点击后图片刷新：单格 1x1 确认分类 hasObject=false 不再点击', async () => {
    const state = baseState()
    state.tiles[0].refreshSrc = 'new-img'
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [0] })
      .mockResolvedValue({ type: 'single', hasObject: false })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(2)
    expect(state.tiles[0].clicks).toBe(1)
    expect(state.tiles[0].cls).not.toContain('selected')
  })
})
