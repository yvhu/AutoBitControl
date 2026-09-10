import { describe, it, expect, vi, beforeEach } from 'vitest'
import { solveRecaptchaGrid, findAnchorFrame, findChallengeFrame } from '../src/automation/captcha/grid'
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
  /** 第 N 次点击起才注册选中（模拟点击过快未注册、补点自愈）；缺省 1（首次点击即注册） */
  registerOnClick?: number
  /** 点击后图片刷新的新 src（模拟 Google 刷新格子整图；未设置不刷新） */
  refreshSrc?: string
  /** 原生点击直接抛错（模拟 viewport 小窗口底部格子不可见；默认 false，抛错时 class 不变） */
  throwOnClick?: boolean
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
  /** verify 点击后是否让 anchor 变绿（模拟「选对才过」） */
  verifySolves: boolean
  /** 前 N 次 verify 点击不判定变绿（多轮失败用例：第 N+1 次 verify 才过）；缺省 0（首次即判定） */
  verifySolveDelay?: number
  /** verify 点击次数（断言用） */
  verifyClicks: number
  wrapperImg: { src: string; naturalWidth: number } | null
  /** '#rc-imageselect-target' 容器截图失败次数（模拟元素动画中截图抛错；默认 0 即一次成功） */
  targetShotFails: number
  /** 表格元素是否存在（缺省 true；截图优先表格，表格缺失回退容器） */
  hasTable: boolean
  /** 容器截图调用次数（断言用） */
  containerShotCalls: number
  /** 表格截图调用次数（断言用） */
  tableShotCalls: number
  /** readErrorHint 的错误提示状态：'select-more'/'incorrect' 走选择器探针，其余文本（如「请重试」）走 body 全帧匹配 */
  hintText: string
  /** 官方换图按钮点击是否真的换图（tile0 src 变化）；false 时 reload 判定失败转 skip */
  reloadChangesSrc: boolean
  /** 跳过按钮点击后切换的新提示语（未设置则换题不生效，下一轮还是旧提示语） */
  skipChangesPrompt: string
  /** 换图按钮点击次数（断言用） */
  reloadClicks: number
  /** 跳过按钮点击次数（断言用） */
  skipClicks: number
  /** 验证按钮是否可见（4x4 翻页分流：勾选后最后一页才出现；3x3 常驻恒可见。默认 true） */
  verifyVisible: boolean
  /** 「下一个」按钮是否可见（4x4 勾选后出现；默认 false） */
  nextVisible: boolean
  /** 「下一个」按钮点击次数（断言用） */
  nextClicks: number
  /** 「下一个」点击后切换的新提示语（4x4 翻页；未设置则翻页不换提示语） */
  nextPrompt: string
  /** 「下一个」按钮点击恒抛错（模拟选择器未命中/按钮不可点；true 时点击不计数不换题） */
  nextFails?: boolean
  /** verify 第一次点击抛错（模拟瞬时失败需重试一次；点击计数仍计入） */
  verifyThrowOnce?: boolean
  /** 换图按钮点击后切换的新提示语（3x3 未覆盖提示语换图后变已覆盖；未设置则提示语不变） */
  reloadChangesPrompt: string
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
        return { click: vi.fn(async () => {
          state.verifyClicks++
          if (state.verifyThrowOnce) { state.verifyThrowOnce = false; throw new Error('元素未可见，瞬时点击失败') }
          state.verifyClicked = true
          if (state.verifySolves && state.verifyClicks > (state.verifySolveDelay ?? 0)) state.anchorChecked = true
        }), count: async () => (state.verifyVisible ? 1 : 0), isVisible: async () => state.verifyVisible }
      }
      if (sel === '#rc-imageselect-target') {
        return {
          screenshot: vi.fn(async () => {
            state.containerShotCalls++
            if (state.targetShotFails > 0) { state.targetShotFails--; throw new Error('元素动画中截图失败') }
            return Buffer.from('png')
          }),
          count: async () => 0,
          evaluate: vi.fn(async () => ({})),
        }
      }
      if (sel === '#rc-imageselect-target table') {
        return {
          screenshot: vi.fn(async () => {
            state.tableShotCalls++
            if (state.targetShotFails > 0) { state.targetShotFails--; throw new Error('元素动画中截图失败') }
            return Buffer.from('png')
          }),
          count: async () => (state.hasTable ? 1 : 0),
        }
      }
      if (sel === 'div.rc-image-tile-wrapper > img') {
        return { evaluate: vi.fn(async () => state.wrapperImg), count: async () => 0 }
      }
      if (sel === '.rc-imageselect-incorrect-response') {
        return { count: async () => (state.hintText === 'incorrect' ? 1 : 0), textContent: vi.fn(async () => 'incorrect-response') }
      }
      if (sel === '.rc-imageselect-error-select-more') {
        return { count: async () => (state.hintText === 'select-more' ? 1 : 0), textContent: vi.fn(async () => '请选择所有匹配项') }
      }
      if (sel === 'body') {
        return { count: async () => 0, textContent: vi.fn(async () => state.hintText) }
      }
      if (sel === '#recaptcha-reload-button') {
        return { click: vi.fn(async () => {
          state.reloadClicks++
          if (state.reloadChangesSrc) state.tiles[0].src = `reloaded-${state.reloadClicks}`
          if (state.reloadChangesPrompt) state.prompt = state.reloadChangesPrompt
        }), count: async () => 0 }
      }
      if (sel.includes('跳过') || sel.includes('Skip')) {
        return { click: vi.fn(async () => { state.skipClicks++; if (state.skipChangesPrompt) state.prompt = state.skipChangesPrompt }), count: async () => 0 }
      }
      if (sel.includes('下一个') || sel.includes('Next')) {
        return { click: vi.fn(async () => {
          if (state.nextFails) throw new Error('按钮不可点击')
          state.nextClicks++; if (state.nextPrompt) state.prompt = state.nextPrompt; state.verifyVisible = true
        }), count: async () => (state.nextVisible ? 1 : 0) }
      }
      if (sel.includes('table td')) {
        return {
          nth: (i: number) => {
            const t = state.tiles[i]
            return {
              click: vi.fn(async () => {
                if (t.throwOnClick) throw new Error('元素不在可视区')
                t.clicks++
                // 首次点击触发图片刷新（src 变化不选中）；否则按 register/registerOnClick 决定是否注册选中
                if (t.refreshSrc && t.src !== t.refreshSrc) { t.src = t.refreshSrc; return }
                if (t.register !== false && t.clicks >= (t.registerOnClick ?? 1)) t.cls = (t.cls + ' selected').trim()
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
      count: async () => (sel.includes('table td') ? state.tiles.length : 0),
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

const baseState = (tileCount = 9): FakeFrameState => ({
  anchorChecked: false, anchorClicked: false, prompt: '停车计时器', promptEmptyReads: 0, promptReads: 0,
  tiles: Array.from({ length: tileCount }, () => ({ cls: '', src: 'img-0', clicks: 0 })),
  verifyClicked: false, verifySolves: true, verifyClicks: 0,
  wrapperImg: { src: 'data:image/png;base64,QUJD', naturalWidth: 300 },
  targetShotFails: 0, hasTable: true, containerShotCalls: 0, tableShotCalls: 0,
  hintText: '', reloadChangesSrc: false, reloadChangesPrompt: '', skipChangesPrompt: '', reloadClicks: 0, skipClicks: 0,
  verifyVisible: true, nextVisible: false, nextClicks: 0, nextPrompt: '',
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

  it('官方全流程：原生整图分类 → 点格 → 确认循环（同结果不补点）→ 验证 → aria-checked 变绿 → solved', async () => {
    const state = baseState()
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    // 3x3 主分类 + 验证前确认循环再分类（fake 同结果 → 无补点 → break）
    expect(classify).toHaveBeenCalledTimes(2)
    const [b64, qid] = classify.mock.calls[0]
    expect(qid).toBe('/m/015qbp')
    expect(typeof b64).toBe('string')
    expect(classify.mock.calls[0][2]).toBe(0.5)
    expect(state.tiles[0].cls).toContain('selected')
    expect(state.tiles[1].cls).toContain('selected')
    expect(state.tiles[2].cls).toContain('selected')
    expect(state.verifyClicked).toBe(true)
  })

  it('分类 confidence：3x3 传 0.5（官方返所有大于分值格）；4x4 不传（指定无意义）', async () => {
    const state3 = baseState()
    const classify3 = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await solveRecaptchaGrid(makeDeps(state3, classify3) as never)
    expect(classify3.mock.calls[0][2]).toBe(0.5)
    const state4 = baseState(16)
    const classify4 = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await solveRecaptchaGrid(makeDeps(state4, classify4) as never)
    expect(classify4.mock.calls[0][2]).toBeUndefined()
  })

  it('3x3 确认循环：第二轮分类返回新未选格 → 补点该格 → 验证成功', async () => {
    const state = baseState()
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [0, 1, 2] })
      .mockResolvedValue({ type: 'multi', objects: [0, 1, 2, 5] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(state.tiles[5].cls).toContain('selected')
    expect(state.verifyClicked).toBe(true)
    expect(classify.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('4x4 下一页分流：验证按钮不可见 → 点「下一个」翻页（换提示语）→ 下一轮分类 → 验证可见 → 成功', async () => {
    const state = baseState(16)
    state.verifyVisible = false
    state.nextVisible = true
    state.nextPrompt = '红绿灯'
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(state.nextClicks).toBeGreaterThanOrEqual(1)
    expect(classify.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(classify.mock.calls[1][1]).toBe('/m/015qff')
    expect(state.verifyClicked).toBe(true)
  })

  it('分类空数组：不硬点，官方换图按钮换图后下一轮分类成功（classify ≥2 次）', async () => {
    const state = baseState()
    state.reloadChangesSrc = true
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [] })
      .mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(state.reloadClicks).toBeGreaterThanOrEqual(1)
    expect(state.verifyClicked).toBe(true)
  })

  it('分类少格不再硬拦：3x3 确认循环补点漏识别格 → 验证成功', async () => {
    const state = baseState()
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [0, 1] })
      .mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(state.reloadClicks).toBe(0)
    expect(state.tiles[2].cls).toContain('selected')
    expect(state.verifyClicked).toBe(true)
  })

  it('select-more + 目标格有未选中（点击过快未注册）：补点该格 → 再 verify → solved', async () => {
    const state = baseState()
    state.hintText = 'select-more'
    state.verifySolveDelay = 1
    state.tiles[1].registerOnClick = 2
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    // 该格被补点第二次（第一次点击未注册）
    expect(state.tiles[1].clicks).toBe(2)
    expect(state.tiles[1].cls).toContain('selected')
    // verify 点了两次（首次失败 + 补点后重验）
    expect(state.verifyClicks).toBe(2)
  })

  it('select-more + 已点格子全部选中（平台分类没找全）：换图 → 下一轮 → solved', async () => {
    const state = baseState()
    state.hintText = 'select-more'
    state.verifySolveDelay = 1
    state.reloadChangesSrc = true
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    // 主分类 + 确认循环（第 1 轮）→ 换图 → 主分类 + 确认循环（第 2 轮）
    expect(classify).toHaveBeenCalledTimes(4)
    expect(state.reloadClicks).toBeGreaterThanOrEqual(1)
    expect(state.verifyClicks).toBe(2)
  })

  it('incorrect 选错提示：换图 → 下一轮 → solved', async () => {
    const state = baseState()
    state.hintText = 'incorrect'
    state.verifySolveDelay = 1
    state.reloadChangesSrc = true
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(4)
    expect(state.reloadClicks).toBeGreaterThanOrEqual(1)
  })

  it('try-again（body 全帧匹配「请重试」）：换图 → 下一轮 → solved', async () => {
    const state = baseState()
    state.hintText = '请重试'
    state.verifySolveDelay = 1
    state.reloadChangesSrc = true
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(4)
    expect(state.reloadClicks).toBeGreaterThanOrEqual(1)
  })

  it('未覆盖提示语：3x3 点刷新换图（换图后提示语已覆盖）→ solved；4x4 点跳过换题 → solved', async () => {
    const state3 = baseState()
    state3.prompt = '潜水艇'
    state3.reloadChangesSrc = true
    state3.reloadChangesPrompt = '停车计时器'
    const classify3 = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state3, classify3) as never)).resolves.toBe('solved')
    expect(state3.reloadClicks).toBeGreaterThanOrEqual(1)
    expect(classify3.mock.calls[0][1]).toBe('/m/015qbp')
    const state4 = baseState(16)
    state4.prompt = '潜水艇'
    state4.skipChangesPrompt = '停车计时器'
    const classify4 = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state4, classify4) as never)).resolves.toBe('solved')
    expect(state4.skipClicks).toBeGreaterThanOrEqual(1)
    expect(classify4.mock.calls[0][1]).toBe('/m/015qbp')
  })

  it('未覆盖提示语连续 5 次（3x3 刷新不换题 / 4x4 跳过不换题）→ 抛错交任务重试换窗口', async () => {
    const state3 = baseState()
    state3.prompt = '潜水艇'
    state3.reloadChangesSrc = false
    const classify3 = vi.fn()
    await expect(solveRecaptchaGrid(makeDeps(state3, classify3) as never)).rejects.toThrow(/连续未覆盖/)
    expect(classify3).not.toHaveBeenCalled()
    const state4 = baseState(16)
    state4.prompt = '潜水艇'
    state4.skipChangesPrompt = ''
    const classify4 = vi.fn()
    await expect(solveRecaptchaGrid(makeDeps(state4, classify4) as never)).rejects.toThrow(/连续未覆盖/)
    expect(classify4).not.toHaveBeenCalled()
  })

  it('4x4 验证按钮未出现且下一个按钮连续 5 次点击失败 → 抛错交任务重试换窗口', async () => {
    const state = baseState(16)
    state.verifyVisible = false
    state.nextVisible = true
    state.nextFails = true
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).rejects.toThrow(/连续点击失败/)
    // 每轮主分类一次（4x4 无验证前确认循环），5 轮后抛错
    expect(classify).toHaveBeenCalledTimes(5)
  })

  it('verify 点击瞬时失败：等 1s 重试一次后成功 → solved', async () => {
    const state = baseState()
    state.verifyThrowOnce = true
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(state.verifyClicks).toBeGreaterThanOrEqual(2)
    expect(state.verifyClicked).toBe(true)
  })

  it('挑战 frame 消失（frames 只剩 anchor）且未变绿：重点锚点 3 次无法恢复 → 抛错交任务重试换窗口', async () => {
    const state = baseState()
    const { anchorFrame } = makePage(state)
    const deps = {
      page: { frames: () => [anchorFrame], waitForTimeout: async (ms: number) => { await sleep(Math.min(ms, 10)) }, locator: () => anchorFrame.locator() } as never,
      provider: { platform: 'test', solveToken: vi.fn(), classifyGrid: vi.fn(), getBalance: vi.fn().mockResolvedValue(100000) } as never,
      logger: { info: vi.fn(), warn: vi.fn() } as never,
      human: { clickAt: vi.fn() } as never,
    }
    await expect(solveRecaptchaGrid(deps as never)).rejects.toThrow(/挑战无法恢复/)
    // 重点锚点确实被重试点击过
    expect(state.anchorClicked).toBe(true)
  })

  it('图片质量拒收：换图后下一轮重新截图再分类求解成功', async () => {
    const state = baseState()
    const classify = vi.fn()
      .mockRejectedValueOnce(new CaptchaFailure('yescaptcha 创建任务失败: ERROR_GARBAGE_SAMPLE'))
      .mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    // 主分类拒收 → 换图 → 主分类 + 确认循环
    expect(classify).toHaveBeenCalledTimes(3)
    expect(state.verifyClicked).toBe(true)
  })

  it('整图 img 缺失回退容器截图：首次截图失败 1s 后重试成功，分类照常进行', async () => {
    const state = baseState()
    state.wrapperImg = null
    state.targetShotFails = 1
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    const logger = { info: vi.fn(), warn: vi.fn() }
    const deps = { ...makeDeps(state, classify), logger } as never
    await expect(solveRecaptchaGrid(deps)).resolves.toBe('solved')
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(String) }), '九宫格网格截图失败（元素可能动画中），1 秒后重试一次')
    expect(classify).toHaveBeenCalledTimes(2)
    expect(classify.mock.calls[0][1]).toBe('/m/015qbp')
    expect(state.verifyClicked).toBe(true)
  })

  it('fallback 截图优先表格元素（3x3 底部边线不裁切）；表格缺失回退容器', async () => {
    const state1 = baseState()
    state1.wrapperImg = null
    const classify1 = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state1, classify1) as never)).resolves.toBe('solved')
    expect(state1.tableShotCalls).toBeGreaterThanOrEqual(1)
    expect(state1.containerShotCalls).toBe(0)
    const state2 = baseState()
    state2.wrapperImg = null
    state2.hasTable = false
    const classify2 = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state2, classify2) as never)).resolves.toBe('solved')
    expect(state2.containerShotCalls).toBeGreaterThanOrEqual(1)
    expect(state2.tableShotCalls).toBe(0)
  })

  it('整图 img 缺失且容器截图前两次失败：第 3 次成功 → 分类继续（截图重试 3 次）', async () => {
    const state = baseState()
    state.wrapperImg = null
    state.targetShotFails = 2
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    const logger = { info: vi.fn(), warn: vi.fn() }
    const deps = { ...makeDeps(state, classify), logger } as never
    await expect(solveRecaptchaGrid(deps)).resolves.toBe('solved')
    // 首次截图 3 次尝试（前 2 失败第 3 成功）+ 验证前确认循环再截 1 次
    expect(state.tableShotCalls).toBeGreaterThanOrEqual(3)
    expect(state.reloadClicks).toBe(0)
    expect(classify).toHaveBeenCalledTimes(2)
    expect(state.verifyClicked).toBe(true)
  })

  it('整图 img 缺失且容器截图三次均失败 → 刷新换图后重试直至成功（rev3.1 不再抛错）', async () => {
    const state = baseState()
    state.wrapperImg = null
    state.targetShotFails = 3
    state.reloadChangesSrc = true
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    const logger = { info: vi.fn(), warn: vi.fn() }
    const deps = { ...makeDeps(state, classify), logger } as never
    await expect(solveRecaptchaGrid(deps)).resolves.toBe('solved')
    expect(state.reloadClicks).toBeGreaterThanOrEqual(1)
    // 下一轮主分类 + 确认循环
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it('提示语首读为空（bframe 晚渲染）：轮询后读到再分类，求解成功', async () => {
    const state = baseState()
    state.promptEmptyReads = 1
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(state.promptReads).toBeGreaterThan(1)
    expect(classify).toHaveBeenCalledTimes(2)
    expect(classify.mock.calls[0][1]).toBe('/m/015qbp')
  })

  it('余额低于上限抛 CaptchaFailure（不烧点数）', async () => {
    const state = baseState()
    const deps = makeDeps(state, vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] }))
    ;(deps.provider as never as { getBalance: ReturnType<typeof vi.fn> }).getBalance.mockResolvedValue(10)
    await expect(solveRecaptchaGrid(deps as never, { maxCostPerTask: 1500 })).rejects.toBeInstanceOf(CaptchaFailure)
  })

  it('点击未注册：坐标拟人兜底重试一次后放弃该格，轮次继续走完', async () => {
    const state = baseState()
    state.tiles[0].register = false
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
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

  it('原生点击抛错（viewport 小窗口底部格子不可见，真机窗口 16）：坐标兜底点击选中，轮次正常完成', async () => {
    const state = baseState()
    state.tiles[0].throwOnClick = true
    const classify = vi.fn().mockResolvedValue({ type: 'multi', objects: [0, 1, 2] })
    const human = { clickAt: vi.fn(async () => { state.tiles[0].cls = (state.tiles[0].cls + ' selected').trim() }) }
    const logger = { info: vi.fn(), warn: vi.fn() }
    const deps = { ...makeDeps(state, classify), human, logger } as never
    await expect(solveRecaptchaGrid(deps)).resolves.toBe('solved')
    expect(human.clickAt).toHaveBeenCalledTimes(1)
    expect(human.clickAt).toHaveBeenCalledWith(50, 50)
    expect(logger.warn).toHaveBeenCalledWith({ idx: 0, err: expect.any(String) }, '九宫格格子原生点击失败，尝试坐标拟人兜底')
    expect(state.tiles[0].cls).toContain('selected')
    expect(state.verifyClicked).toBe(true)
  })

  it('点击后图片刷新：单格 1x1 确认分类 hasObject=true 再点一次确认（2 点记账）', async () => {
    const state = baseState()
    state.tiles[0].refreshSrc = 'new-img'
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [0, 1, 2] })
      .mockResolvedValue({ type: 'single', hasObject: true })
    const onLog = vi.fn()
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never, { onLog })).resolves.toBe('solved')
    // 主分类 + 单格确认 + 3x3 验证前确认循环（single 结果 → break）
    expect(classify).toHaveBeenCalledTimes(3)
    expect(typeof classify.mock.calls[1][0]).toBe('string')
    expect(classify.mock.calls[1][1]).toBe('/m/015qbp')
    expect(state.tiles[0].clicks).toBe(2)
    expect(state.tiles[0].src).toBe('new-img')
    expect(state.tiles[0].cls).toContain('selected')
    // 记账走 onLog（不传 provider.classifyGrid）：主网格 6 点、单格 1x1 2 点（TILE_COST_POINTS）、确认循环 6 点
    expect(onLog).toHaveBeenNthCalledWith(1, 'test', 'recaptcha_v2_grid', true, 6)
    expect(onLog).toHaveBeenNthCalledWith(2, 'test', 'recaptcha_v2_grid', true, 2)
    expect(onLog).toHaveBeenNthCalledWith(3, 'test', 'recaptcha_v2_grid', true, 6)
  })

  it('点击后图片刷新：单格 1x1 确认分类 hasObject=false 不再点击', async () => {
    const state = baseState()
    state.tiles[0].refreshSrc = 'new-img'
    const classify = vi.fn()
      .mockResolvedValueOnce({ type: 'multi', objects: [0, 1, 2] })
      .mockResolvedValue({ type: 'single', hasObject: false })
    await expect(solveRecaptchaGrid(makeDeps(state, classify) as never)).resolves.toBe('solved')
    expect(classify).toHaveBeenCalledTimes(3)
    expect(state.tiles[0].clicks).toBe(1)
    expect(state.tiles[0].cls).not.toContain('selected')
  })
})
