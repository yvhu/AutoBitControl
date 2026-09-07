/**
 * 文件随机分配类型（tools 层）：模板/计划/执行参数
 * 依赖方向：无依赖，被 name-template/planner/applier 与 server 路由引用
 */
export type EnglishCase = 'lower' | 'upper' | 'mixed'

/** 插入位置：replace=替换文件名、before=文件名前、after=文件名后、after-position=指定位置后、after-text=指定文本后 */
export type PositionType = 'replace' | 'before' | 'after' | 'after-position' | 'after-text'

export interface EnglishComponent {
  count: number
  caseMode: EnglishCase
}

export interface DigitsComponent {
  count: number
}

export interface SpecialComponent {
  count: number
  charset: string
}

export interface PositionConfig {
  type: PositionType
  /** after-position: 原 stem 中插入位置（1 起）；after-text: 定位文本 */
  value?: string | number
}

/** 名称模板：组件为 null 表示不启用该组件；生成串 = 英文 + 数字 + 特殊字符顺序拼接 */
export interface FileAssignTemplate {
  english: EnglishComponent | null
  digits: DigitsComponent | null
  special: SpecialComponent | null
  position: PositionConfig
}

/** 单行分配计划（与账号表数据行一一对应） */
export interface AssignRow {
  /** xlsx 行号（1 起，第 1 行为表头） */
  rowNumber: number
  /** 展示用窗口标识：窗口名称列 / 窗口列 / 行号兜底 */
  window: string
  oldName: string
  newName: string
  newPath: string
}

/** 预览返回的分配计划 */
export interface AssignPlan {
  accountsCount: number
  filesCount: number
  plan: AssignRow[]
}

/** 执行参数：plan 为预览阶段回传的计划 */
export interface ApplyParams {
  sourceDir: string
  column: string
  plan: AssignRow[]
  xlsxPath: string
}

export interface ApplyResult {
  renamedCount: number
  updatedRows: number
}
