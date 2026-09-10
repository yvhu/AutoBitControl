/**
 * reCAPTCHA 九宫格提示语 → 问题 ID 映射（automation/captcha 层）
 * 中英双语：官方中文表 + 官方 Python DEMO 英文表合并；未覆盖的提示语任务会失败，按日志扩充
 */
export const QUESTION_ID_MAP: Record<string, string> = {
  '出租车': '/m/0pg52', '巴士': '/m/01bjv', '公交车': '/m/01bjv', '校车': '/m/02yvhj',
  '摩托车': '/m/04_sv', '拖拉机': '/m/013xlm', '烟囱': '/m/01jk_4', '人行横道': '/m/014xcs',
  '红绿灯': '/m/015qff', '自行车': '/m/0199g', '停车计价表': '/m/015qbp', '停车计时器': '/m/015qbp',
  '汽车': '/m/0k4j', '车辆': '/m/0k4j', '桥': '/m/015kr', '船': '/m/019jd', '棕榈树': '/m/0cdl1',
  '山': '/m/09d_r', '山丘': '/m/09d_r', '消防栓': '/m/01pns0', '楼梯': '/m/01lynh',
  '过街人行道': '/m/014xcs', '人行道': '/m/014xcs', '小轿车': '/m/0k4j', '轿车': '/m/0k4j', '大巴': '/m/01bjv',
  '摩托': '/m/04_sv', '火车': '/m/07jdr', '卡车': '/m/07r04', '飞机': '/m/0cmf2', '商店': '/m/02y_9m3',
  '店面': '/m/02y_9m3', '店面门脸': '/m/02y_9m3', '邮箱': '/m/04w5f', '交通信号灯': '/m/015qff',
  'taxis': '/m/0pg52', 'taxi': '/m/0pg52', 'bus': '/m/01bjv', 'buses': '/m/01bjv', 'school bus': '/m/02yvhj',
  'motorcycles': '/m/04_sv', 'motorcycle': '/m/04_sv', 'tractors': '/m/013xlm', 'tractor': '/m/013xlm',
  'chimneys': '/m/01jk_4', 'chimney': '/m/01jk_4', 'crosswalks': '/m/014xcs', 'crosswalk': '/m/014xcs',
  'pedestrian crossings': '/m/014xcs', 'traffic lights': '/m/015qff', 'traffic light': '/m/015qff',
  'bicycles': '/m/0199g', 'bicycle': '/m/0199g', 'parking meters': '/m/015qbp', 'parking meter': '/m/015qbp',
  'cars': '/m/0k4j', 'car': '/m/0k4j', 'vehicles': '/m/0k4j', 'vehicle': '/m/0k4j',
  'bridges': '/m/015kr', 'bridge': '/m/015kr', 'boats': '/m/019jd', 'boat': '/m/019jd',
  'palm trees': '/m/0cdl1', 'palm tree': '/m/0cdl1', 'mountains or hills': '/m/09d_r', 'mountains': '/m/09d_r',
  'hills': '/m/09d_r', 'fire hydrant': '/m/01pns0', 'fire hydrants': '/m/01pns0', 'stairs': '/m/01lynh',
  'trucks': '/m/07r04', 'trains': '/m/07jdr', 'airplanes': '/m/0cmf2', 'mailboxes': '/m/04w5f', 'storefronts': '/m/02y_9m3',
}

/** 提示文字 → 问题 ID（先精确匹配，再子串包含；未覆盖返回 null） */
export function mapQuestionId(promptText: string): string | null {
  const t = promptText.trim()
  if (!t) return null
  if (QUESTION_ID_MAP[t]) return QUESTION_ID_MAP[t]
  for (const [key, id] of Object.entries(QUESTION_ID_MAP)) {
    if (t.includes(key)) return id
  }
  return null
}
