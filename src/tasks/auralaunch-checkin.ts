/**
 * Auralaunch 签到任务：每日签到 + AI 答题（QUIZ FOR THE DAY）
 * 站点：https://beta.auralaunch.org/incentives
 * 执行流程：打开任务页 → 自适应钱包登录 → （若出现）今日答题弹窗：
 *          读题干+选项 → 问 AI（命中本地缓存则跳过）→ 点击答案 → 截「quiz-answer」存证 → 提交 → 等弹窗关闭
 *          → 若出现「Claim」按钮则点击领取（等成功提示作成功断言 + 存证截图），否则任务结束
 * 设计：run 内直接用 ../api 能力函数；答题答案按「题干」缓存在进程内存，同题跨窗口复用
 * 时间预算：timeoutSec 180s、retry.max 2 次 / 退避 600s
 */
import { SiteTask, type TaskContext, type TaskMeta } from './base'
import { openPage, connectWallet, click, waitFor, getText, answerQuiz, takeScreenshot } from '../api'

// 答题弹窗选择器（对应该站点 DOM）：
//   .modal-content 根节点内的 h3 标题 / h6 题干 / .mt-4 下的选项 div / Submit 按钮
const QUIZ_ROOT = '.modal-content'
const QUIZ_HEADER = `${QUIZ_ROOT} h3:has-text("QUIZ FOR THE DAY")` // 可见即代表答题弹窗已出现
const QUIZ_QUESTION = `${QUIZ_ROOT} h6` // 题干
const QUIZ_OPTIONS = `${QUIZ_ROOT} .mt-4 > div` // 4 个可点选项
const QUIZ_SUBMIT = `${QUIZ_ROOT} button:has-text("Submit Answer")` // 提交按钮
const CLAIM_BTN = 'button.daily-claim-button' // 答完题后的每日「Claim」领取按钮（可能不出现）

/**
 * 答题答案缓存：题干 → AI 答案（字母）。
 * 模块级 Map => 同一后端进程内所有窗口共享；进程重启清空（不落盘）。
 * 目的：同一道题（题干文本相同）只问一次 AI，其余窗口直接复用答案，省额度。
 */
const quizAnswerCache = new Map<string, string>()

/**
 * 按答案字母点击对应选项（缓存命中时使用）。
 * 从句首提取首个字母 A/B/C… → 转下标；解析不出或越界则随机兜底（与 answerQuiz 同策略）。
 */
async function clickOptionByAnswer(ctx: TaskContext, optionSelector: string, answer: string): Promise<void> {
  const loc = ctx.page.locator(optionSelector)
  const n = await loc.count()
  if (n === 0) throw new Error(`未找到选项元素: ${optionSelector}`)
  const m = answer.toUpperCase().match(/[A-Z]/)
  const idx = m ? m[0].charCodeAt(0) - 65 : -1
  const pick = idx >= 0 && idx < n ? idx : Math.floor(Math.random() * n)
  await loc.nth(pick).click()
  ctx.log.info({ step: 'quiz', window: ctx.profile.name, answer, pick }, '已点击答题选项')
}

/**
 * 读完题干 → 命中缓存直接点；未命中则用 answerQuiz 问 AI（其内部会点击选项）并写入缓存。
 * 只缓存可信答案：answerQuiz 兜底随机作答（fallback=true）时答案不可信，不写入缓存，避免错误扩散。
 * 日志带 source 字段区分答案来源：cache（缓存）/ ai（AI）/ ai-fallback（AI 解析失败随机作答）。
 */
async function answerQuizCached(ctx: TaskContext, questionSelector: string, optionSelector: string): Promise<void> {
  const question = await getText(ctx, questionSelector)
  const cached = quizAnswerCache.get(question)
  if (cached) {
    ctx.log.info({ step: 'quiz', window: ctx.profile.name, source: 'cache', question, answer: cached }, '答题答案来源：本地缓存（同题复用，未调用 AI）')
    await clickOptionByAnswer(ctx, optionSelector, cached)
    return
  }
  // answerQuiz：读选项文本 → 问 AI → 解析字母 → 点击对应选项
  const res = await answerQuiz(ctx, { question, options: { selector: optionSelector }, match: 'letter' })
  if (!res.fallback) {
    quizAnswerCache.set(question, res.answer)
    ctx.log.info({ step: 'quiz', window: ctx.profile.name, source: 'ai', question, answer: res.answer }, '答题答案来源：AI（已写入本地缓存）')
  } else {
    ctx.log.warn({ step: 'quiz', window: ctx.profile.name, source: 'ai-fallback', question }, '答题答案来源：AI 解析失败，已随机作答（未写入缓存）')
  }
}

export class AuralaunchCheckinTask extends SiteTask {
  meta: TaskMeta = {
    key: 'auralaunch-checkin', // 全局唯一任务键（面板/API/数据库均以此索引）
    name: 'Auralaunch签到',
    group: { key: 'auralaunch', name: '签到' }, // 任务分组（面板按组展示）
    url: 'https://beta.auralaunch.org/incentives', // 落地页
    sourceUrl: 'https://cryptorank.io/zh/drophunting/aura-protocolorg-activity1261', // 任务来源说明链接（面板展示用）
    note: 'auralaunch签到：包含ai答题，每日签到',
    category: 'checkin', // 任务类别：签到
    lastUpdated: '2026-10-09',
    enabled: false, // 默认关闭：不参与定时/批量触发，调试时手动触发或用 task:run
    wallet: 'metamask', // 使用的钱包类型（决定登录/签名走哪个适配器）
    timeoutSec: 180, // 单任务整体超时秒数
    retry: { max: 2, backoffSec: 600 }, // 失败最多再试 2 次，每次退避 600s（不占窗）
  }

  /**
   * 执行流程：打开任务页 → 自适应钱包登录 → 今日答题（若有）→ 出现 Claim 则领取，否则结束。
   * @param ctx 任务上下文（page/log/task 等运行时数据）
   */
  async run(ctx: TaskContext): Promise<void> {
    await openPage(ctx, this.meta.url, { closeOtherTabs: true })

    // 自适应钱包登录：自动找连接按钮、自动检测站内钱包列表、静默连接/自动签名（详见 docs/API-GUIDE 第 4 章）
    await connectWallet(ctx, {
      wallet: 'metamask',
      connected: { text: '0x' },
      disconnected: 'Connect Wallet',
      connect: 'button.connect-wallet-button',
      walletOption: { selector: '[data-testid="rk-wallet-option-metaMask"]' },
    })

    // 今日答题弹窗（可能有、可能没有）：出现则读题 → 问 AI（或命中缓存）→ 点答案 → 提交
    if (await waitFor(ctx, { selector: QUIZ_HEADER }, { budgetMs: 5000 })) {
      // 1) 拿答案并点击选项：命中缓存直接点；未命中由 answerQuiz 问 AI 后点击
      await answerQuizCached(ctx, QUIZ_QUESTION, QUIZ_OPTIONS)
      // 答题存证：点完答案、提交前截（此时弹窗仍显示题干与选中项；提交后弹窗可能立即关闭）
      await takeScreenshot(ctx, 'quiz-answer')
      // 2) 提交答案
      await click(ctx, QUIZ_SUBMIT)
      // 3) 等弹窗关闭作为提交落定信号；未关闭仅告警，不阻断后续步骤
      if (!(await waitFor(ctx, { hidden: QUIZ_HEADER }, { budgetMs: 15000 }))) {
        ctx.log.warn({ step: 'quiz', window: ctx.profile.name }, '答题弹窗未在预算内关闭（提交结果未知）')
      }
    }

    // 答完题后：若出现每日「Claim」按钮则领取；没有则不领取，当前任务就此结束
    // 用 waitFor 等它出现（可见）；出现→点它，未出现→直接结束（幂等/今日无可领）
    if (await waitFor(ctx, { selector: CLAIM_BTN }, { budgetMs: 5000 })) {
      await click(ctx, CLAIM_BTN)
      // 成功断言：出现「You have successfully claimed … points!」提示即领取成功
      // （文案含动态积分，用子串匹配；assert:true 时超时抛错 → 任务失败进入重试）
      await waitFor(ctx, { text: 'You have successfully claimed' }, { assert: true, budgetMs: 15000 })
      await takeScreenshot(ctx, 'claim-success') // 领取成功弹窗单独存证（框架结束时还会自动截一张 success）
      ctx.log.info({ step: 'claim', window: ctx.profile.name }, '已点击 Claim 并确认领取成功')
    } else {
      ctx.log.info({ step: 'claim', window: ctx.profile.name }, '未出现 Claim 按钮，任务结束')
    }
  }
}
