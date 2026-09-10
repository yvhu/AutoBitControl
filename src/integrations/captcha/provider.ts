/**
 * 鎵撶爜骞冲彴鎶借薄鎺ュ彛锛坕ntegrations 灞傦級锛氬钩鍙版棤鍏冲绾︼紝automation 灞傚彧渚濊禆姝ゆ枃浠? * 渚濊禆鏂瑰悜锛氫笉渚濊禆浠讳綍椤圭洰妯″潡锛岃 integrations/captcha 鍚勫钩鍙板疄鐜颁笌 automation/captcha 渚濊禆
 * 璁捐鎬濊矾锛氬悇鎵撶爜骞冲彴 API 宸紓锛堜换鍔＄被鍨嬪悕/璁よ瘉/杩斿洖缁撴瀯锛夌敱骞冲彴瀛愮洰褰曡嚜琛屾秷鍖栵紝
 * 瀵瑰缁熶竴瀹炵幇 CaptchaProvider锛涙湭鏉ユ帴鍏?capsolver/2captcha 绛?= 鏂板骞冲彴瀛愮洰褰?+ config 鍒囨崲
 */
/** token 绫婚獙璇佺爜绫诲瀷锛坰olveToken 鏀寔锛沬mage 绫诲瀷瀹樻柟涓?body 鍙傛暟涓斿悓姝?寮傛鍙屽舰鎬侊紝鏈涓嶈縼绉伙紝瑙佽鍒掓牳瀵规€昏〃锛?*/
export type TokenCaptchaKind = 'turnstile' | 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha'
/** 鍏ㄩ儴楠岃瘉鐮佺被鍨嬶紙鍚節瀹牸鍥剧墖鍒嗙被锛屼粎鐢ㄤ簬璁拌处/鏃ュ織锛?*/
export type CaptchaKind = TokenCaptchaKind | 'recaptcha_v2_grid'

/** 椤甸潰楠岃瘉鐮佹娴嬬粨鏋?*/
export interface CaptchaDetected {
  kind: TokenCaptchaKind
  sitekey: string | null
}

/** 鎵撶爜涓氬姟澶辫触锛堜綑棰濅笉瓒?瑙ｉ瓒呮椂/鏃?sitekey 绛夛級锛泈indow-runner 浠ユ鍖哄垎 captcha_failed 缁堟€?*/
export class CaptchaFailure extends Error {}

/** 涔濆鏍煎垎绫荤粨鏋滐細multi = 闇€瑕佺偣鍑荤殑鏍煎瓙搴忓彿锛?x3 涓?0-8锛?x4 涓?0-15锛夛紱single = 鍗曞浘鏄惁鍚洰鏍?*/
export type GridResult = { type: 'multi'; objects: number[] } | { type: 'single'; hasObject: boolean }

/** 鍚勭被鍨嬪崟娆¤В棰樹及绠楃偣鏁帮紙1 鐐?= 楼0.001锛涚偣鏁版寜 yescaptcha 瀹樻柟浠锋牸琛紝瑙佽鍒掓牳瀵规€昏〃锛?*/
export const ESTIMATED_COST_POINTS: Record<CaptchaKind, number> = {
  turnstile: 25,
  recaptcha_v2: 15,
  recaptcha_v3: 20,
  hcaptcha: 30,
  recaptcha_v2_grid: 6,
}

/** 鎵撶爜鎴愭湰璁拌处鍥炶皟锛坧latform 鐢ㄤ簬澶氬钩鍙拌璐﹀尯鍒嗭級 */
export type CaptchaLogFn = (platform: string, kind: string, ok: boolean, costPoints: number) => void

/** 鎵撶爜骞冲彴缁熶竴鎺ュ彛 */
export interface CaptchaProvider {
  /** 骞冲彴鏍囪瘑锛堝 'yescaptcha'锛夛紝璁拌处涓庢棩蹇楀尯鍒嗙敤 */
  readonly platform: string
  /**
   * token 绫昏В棰橈細鍒涘缓浠诲姟 鈫?杞缁撴灉 鈫?杩斿洖 token
   * @param kind 楠岃瘉鐮佺被鍨嬶紙鍐冲畾骞冲彴浠诲姟绫诲瀷涓?solution 鍙栧€煎瓧娈碉級
   * @param sitekey 绔欑偣 sitekey锛堢己澶辩敱瀹炵幇鎶?CaptchaFailure锛?   * @param pageUrl 瑙﹀彂楠岃瘉鐮佺殑椤甸潰鍦板潃
   * @param extra 閫忎紶缁欏钩鍙颁换鍔′綋鐨勯檮鍔犲弬鏁帮紙瀹樻柟鍙€夊弬鏁板師鏍烽€忎紶锛歳ecaptcha_v2 鐨?isInvisible銆?   *   recaptcha_v3 鐨?pageAction銆乭captcha 鐨?userAgent/isInvisible/rqdata锛?   */
  solveToken(kind: TokenCaptchaKind, sitekey: string | null, pageUrl: string, extra?: Record<string, unknown>): Promise<string>
  /**
   * 涔濆鏍煎浘鐗囧垎绫伙細鎻愪氦缃戞牸/鍗曟牸鍥撅紙宸茬缉鏀惧埌瀹樻柟鏍囧噯灏哄鐨?Base64锛屾棤 data: 鍓嶇紑锛変笌闂 ID
   * @param image 鍥剧墖 Base64锛堟棤 data: 鍓嶇紑锛涘畼鏂硅姹傛爣鍑嗗ぇ灏?100x100/300x300/450x450锛?   * @param questionId 闂 ID锛堝畼鏂硅姹備互 /m/ 寮€澶达級
   * @param confidence 缃俊搴﹂槇鍊硷紙瀹樻柟 int 闈炲繀濉紱3x3 鎸囧畾鍚庤繑鍥炴墍鏈夊ぇ浜庡垎鍊肩殑缁撴灉锛?x4/1x1 鎸囧畾鏃犳剰涔夛級
   */
  classifyGrid(image: string, questionId: string, confidence?: number): Promise<GridResult>
  /** 鏌ヨ璐︽埛浣欓锛堢偣锛?*/
  getBalance(): Promise<number>
}