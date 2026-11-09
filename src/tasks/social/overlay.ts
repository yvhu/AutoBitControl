/**
 * 社交任务通用弹窗关闭（tasks 层内部 helper）：关掉订阅/通知/Cookie 等阻挡弹窗
 * 依赖方向：仅依赖 ../base 的 TaskContext 类型与 patchright 的 Locator 类型
 * 页面操作：全部走 ctx.page（patchright Page：locator/evaluate/keyboard），不引入其它自动化库
 * 设计思路：只点「关闭/暂不/以后再说/接受 Cookie」等安全按钮，绝不点订阅/升级/安装；
 *          点击超时短、失败只告警，调用方任务不因弹窗失败。
 */
import type { Locator } from 'patchright'
import type { TaskContext } from '../base'

/** 可见弹窗/横幅根节点（任一存在才进入关闭流程） */
const OVERLAY_ROOTS = [
  '[role="dialog"]',
  '[data-testid="sheetDialog"]',
  '[data-testid="BottomBar"]',
  '[data-testid="interstitialGraphic"]',
  '[class*="cookie" i]',
  '[id*="cookie" i]',
]

/** 关闭按钮的 aria-label（按语言；弹窗关闭按钮常只有 aria-label 没有文本） */
const CLOSE_LABELS = [
  'Close', 'Dismiss',
  'Fermer', 'Schließen', '閉じる', '關閉', '关闭',
  'Cerrar', 'Fechar', 'Chiudi', 'Закрыть', 'Sluiten', 'Kapat', '닫기',
]

/** 关闭按钮的可点击文本（按语言；不包含订阅/升级/安装） */
const CLOSE_TEXTS = [
  'Close', 'Dismiss', 'Not now', 'Maybe later', 'No thanks',
  'Fermer', 'Pas maintenant', 'Plus tard', 'Non merci', 'Ignorer',
  'Schließen', 'Jetzt nicht', 'Später', 'Nein danke', 'Ausblenden',
  '閉じる', '後で', '今はしない', 'いいえ', 'スキップ', '非表示',
  '關閉', '稍後', '不用了', '略過', '隱藏',
  '关闭', '暂不', '以后再说', '跳过',
  'Cerrar', 'Ahora no', 'Más tarde', 'No, gracias', 'Ignorar',
  'Fechar', 'Agora não', 'Mais tarde', 'Não, obrigado',
  'Chiudi', 'Non ora', 'Più tardi', 'No grazie', 'Ignora',
  'Закрыть', 'Не сейчас', 'Позже', 'Нет, спасибо', 'Пропустить',
  'Sluiten', 'Niet nu', 'Later', 'Nee bedankt', 'Negeren',
  'Kapat', 'Şimdi değil', 'Daha sonra', 'Hayır teşekkürler', 'Yoksay',
  '닫기', '나중에', '지금 안 함', '아니요', '건너뛰기',
]

/** 安全关闭按钮（弹窗内的关闭/暂不/跳过；不包含订阅/升级） */
const SAFE_CLOSE_SELECTORS = [
  ...CLOSE_LABELS.map((label) => `[role="dialog"] button[aria-label="${label}"]`),
  ...CLOSE_LABELS.map((label) => `[data-testid="sheetDialog"] [aria-label="${label}"]`),
  ...CLOSE_TEXTS.map((text) => `[role="dialog"] button:has-text("${text}")`),
]

/** 安全 Cookie 按钮文本（接受或拒绝非必要均可清掉横幅；按语言） */
const COOKIE_TEXTS = [
  'Accept all cookies', 'Accept All', 'Reject non-essential',
  '接受全部 Cookie', '接受所有 Cookie', '拒绝非必要',
  'Tout accepter', 'Accepter tous les cookies', 'Refuser les cookies non essentiels',
  'Alle Cookies akzeptieren', 'Alle akzeptieren', 'Nicht notwendige Cookies ablehnen',
  'すべてのCookieを許可', '必須以外のCookieを拒否',
  '全部接受', '拒絕非必要 Cookie',
  'Aceptar todas las cookies', 'Rechazar las no esenciales',
  'Aceitar todos os cookies', 'Rejeitar não essenciais',
  'Accetta tutti i cookie', 'Rifiuta i cookie non essenziali',
  'Принять все файлы cookie', 'Отклонить необязательные',
  'Alle cookies accepteren', 'Niet-essentiële cookies weigeren',
  'Tüm çerezleri kabul et', 'Gerekli olmayan çerezleri reddet',
  '모든 쿠키 허용', '필수 쿠키만 허용',
]

/** 安全 Cookie 按钮 */
const SAFE_COOKIE_SELECTORS = COOKIE_TEXTS.map((text) => `button:has-text("${text}")`)

/** X 广告个性化插屏：开启个性化广告（用户可显式选择） */
export type XAdPersonalizationChoice = 'turn-on' | 'keep-less-relevant'

export interface DismissOverlaysOptions {
  /** X 广告个性化插屏选择；默认按用户要求点 Turn on personalized ads */
  xAdChoice?: XAdPersonalizationChoice
}

const AD_TURN_ON_TEXTS = [
  'Turn on personalized ads',
  'Activer les publicités personnalisées',
  'Personalisierte Anzeigen aktivieren', 'Personalisierte Werbung aktivieren',
  'パーソナライズ広告をオンにする', 'パーソナライズされた広告をオンにする',
  '開啟個人化廣告', '开启个性化广告',
  'Activar anuncios personalizados',
  'Ativar anúncios personalizados',
  'Attiva annunci personalizzati',
  'Включить персонализированную рекламу',
  'Gepersonaliseerde advertenties inschakelen',
  'Kişiselleştirilmiş reklamları aç',
  '맞춤 광고 켜기',
]
const AD_OPT_OUT_TEXTS = [
  'Keep less relevant ads',
  'Conserver des publicités moins pertinentes', 'Garder des publicités moins pertinentes',
  'Weniger relevante Anzeigen beibehalten', 'Weniger relevante Werbung beibehalten',
  '関連性の低い広告を表示', '関連性の低い広告を維持',
  '保留相關性較低的廣告', '保留相关性较低的广告',
  'Mantener anuncios menos relevantes',
  'Manter anúncios menos relevantes',
  'Mantieni annunci meno pertinenti',
  'Оставить менее релевантную рекламу',
  'Minder relevante advertenties behouden',
  'Daha az alakalı reklamları koru',
  '관련성 낮은 광고 유지',
]
const AD_TURN_ON_SELECTORS = AD_TURN_ON_TEXTS.map((text) => `button:has-text("${text}")`)
const AD_OPT_OUT_SELECTORS = AD_OPT_OUT_TEXTS.map((text) => `button:has-text("${text}")`)

const MAX_ATTEMPTS = 2 // 单次检查最多关闭两个弹窗
const CLICK_TIMEOUT_MS = 2500 // 关闭按钮点击超时（避免被遮罩拖满 30 秒）
const SETTLE_MS = 700 // 关闭后等待动画/下一次检查
const ESCAPE_SETTLE_MS = 500 // Esc 兜底后的等待

/**
 * 关闭当前可见的阻挡弹窗（订阅/通知/Cookie 等）。
 * @param ctx 任务上下文
 * @param opts 广告个性化插屏选择（默认 Turn on personalized ads）
 * @returns 实际成功关闭的弹窗数量（失败只告警，不抛错）
 */
export async function dismissBlockingOverlays(ctx: TaskContext, opts: DismissOverlaysOptions = {}): Promise<number> {
  const adSelectors = (opts.xAdChoice ?? 'turn-on') === 'turn-on' ? AD_TURN_ON_SELECTORS : AD_OPT_OUT_SELECTORS
  let dismissed = 0
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!(await hasBlockingOverlay(ctx))) break
    const button = await firstVisibleOnPage(ctx, [...SAFE_CLOSE_SELECTORS, ...adSelectors, ...SAFE_COOKIE_SELECTORS])
    if (!button) break
    const text = await readOverlayText(ctx)
    try {
      await button.click({ timeout: CLICK_TIMEOUT_MS })
      dismissed++
      ctx.log.info({ step: 'overlay', window: ctx.profile.name, text }, '已关闭弹窗')
    } catch (e) {
      ctx.log.warn({ step: 'overlay', window: ctx.profile.name, err: (e as Error).message }, '关闭弹窗失败，跳过')
      break
    }
    await ctx.page.waitForTimeout(SETTLE_MS)
  }
  // 没有安全按钮但仍有弹窗：按 Esc 兜底一次（社交任务没有必须保留的弹窗）
  if (await hasBlockingOverlay(ctx)) {
    await ctx.page.keyboard.press('Escape').catch(() => {})
    await ctx.page.waitForTimeout(ESCAPE_SETTLE_MS)
  }
  return dismissed
}

/** 弹窗期间禁止滚动：有弹窗时关闭并等待它消失，超时返回 false */
export async function ensureNoBlockingOverlay(
  ctx: TaskContext,
  opts: DismissOverlaysOptions = {},
  timeoutMs = 10000,
): Promise<boolean> {
  if (!(await hasBlockingOverlay(ctx))) return true
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    await dismissBlockingOverlays(ctx, opts)
    if (!(await hasBlockingOverlay(ctx))) return true
    await ctx.page.waitForTimeout(500)
  }
  ctx.log.warn({ step: 'overlay', window: ctx.profile.name, text: await readOverlayText(ctx) }, '弹窗持续存在，暂停滚动')
  return false
}

/** 是否存在可见的弹窗/横幅根节点（一次组合查询，供滚动前拦截） */
export async function hasBlockingOverlay(ctx: TaskContext): Promise<boolean> {
  try {
    const selector = OVERLAY_ROOTS.map((root) => `${root}:visible`).join(', ')
    return (await ctx.page.locator(selector).count()) > 0
  } catch {
    return false
  }
}

/** 在一组选择器里返回首个可见元素；都不存在返回 null（查询异常按不存在处理） */
async function firstVisibleOnPage(ctx: TaskContext, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    try {
      const locator = ctx.page.locator(selector).first()
      if ((await locator.count()) === 0) continue
      if (await locator.isVisible()) return locator
    } catch {
      // 单个选择器异常不影响其它候选
    }
  }
  return null
}

/** 读弹窗文本片段（用于日志定位；查询异常返回空串） */
async function readOverlayText(ctx: TaskContext): Promise<string> {
  try {
    return (await ctx.page.evaluate(() => {
      const root = document.querySelector('[role="dialog"], [data-testid="sheetDialog"], [data-testid="BottomBar"]')
      return (root?.textContent ?? '').trim().slice(0, 200)
    })) as string
  } catch {
    return ''
  }
}
