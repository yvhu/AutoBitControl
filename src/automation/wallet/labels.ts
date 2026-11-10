/**
 * 钱包弹窗多语言按钮文案（automation/wallet 层）：各适配器共享的可见文案与选择器生成
 * 依赖方向：纯常量与纯函数，无运行时依赖；被 config-adapter / petra / subwallet 依赖
 * 设计思路：MetaMask 有稳定 data-testid 不需要文案；无 testid 的钱包（Petra/SubWallet）必须按可见文案定位，
 *   这里集中维护 en/zh-CN/zh-TW/ja/ru/vi/fr/de 候选，避免每个适配器各写一套、漏语言。
 *   交易类文案（confirm/approve）仍由各适配器保守分类，不能因为多语言候选放宽安全边界。
 */

/** 钱包弹窗按钮文案分组：一组文案对应一种用户可见意图 */
export interface WalletButtonLabels {
  /** 解锁按钮 */
  unlock: string[]
  /** 连接/授权按钮 */
  connect: string[]
  /** 多步流程的下一步按钮 */
  next: string[]
  /** 消息签名按钮 */
  sign: string[]
  /** 确认按钮（签名与交易可能共用） */
  confirm: string[]
  /** 批准按钮（授权/交易确认常见） */
  approve: string[]
}

/** 共享多语言按钮文案：英文置首，保证既有选择器顺序与单测稳定 */
export const WALLET_BUTTON_LABELS: WalletButtonLabels = {
  unlock: [
    'Unlock',
    '解锁',
    '解鎖',
    'ロック解除',
    'Разблокировать',
    'Mở khóa',
    'Déverrouiller',
    'Entsperren',
    '确认',
    '確認',
  ],
  connect: [
    'Connect',
    '连接',
    '連接',
    '連線',
    '接続',
    'Подключить',
    'Kết nối',
    'Connecter',
    'Verbinden',
  ],
  next: [
    'Next',
    '下一步',
    '次へ',
    'Далее',
    'Tiếp theo',
    'Suivant',
    'Weiter',
  ],
  sign: [
    'Sign',
    'Sign In',
    '签名',
    '簽名',
    '署名',
    'Подписать',
    'Ký',
    'Signer',
    'Signieren',
  ],
  confirm: [
    'Confirm',
    '确认',
    '確認',
    '確認する',
    'Подтвердить',
    'Xác nhận',
    'Confirmer',
    'Bestätigen',
  ],
  approve: [
    'Approve',
    '批准',
    '核准',
    '承認',
    'Одобрить',
    'Phê duyệt',
    'Approuver',
    'Genehmigen',
  ],
}

/** 去重并保持顺序：合并多组文案时不产生重复选择器 */
export function uniqueTexts(texts: string[]): string[] {
  return [...new Set(texts)]
}

/** 把文案数组转成 `button:has-text("...")` 选择器数组（去重后仍保持英文优先） */
export function buttonSelectors(texts: string[]): string[] {
  return uniqueTexts(texts).map((text) => `button:has-text("${text}")`)
}

/** 确认/批准合并后的完整文案（部分钱包签名与交易共用同一个按钮） */
export const WALLET_CONFIRM_TEXTS: string[] = uniqueTexts([
  ...WALLET_BUTTON_LABELS.confirm,
  ...WALLET_BUTTON_LABELS.approve,
])
