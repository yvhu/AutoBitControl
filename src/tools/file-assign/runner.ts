/**
 * 计划自动分配执行器（tools 层）：preview → apply → 数据源重载 的串联封装
 * 依赖方向：依赖 ./planner ./applier ./types；被 app.ts 装配、注入 engine/scheduler（engine 不依赖 tools 运行时）
 */
import { preparePreview } from './planner'
import type { ApplyParams, ApplyResult, FileAssignConfig } from './types'

/** 执行器依赖：xlsxPath 为全局配置；apply 与 reload 由 app.ts 提供真实实现（测试可替换） */
export interface FileAssignRunnerDeps {
  xlsxPath: string
  apply(params: ApplyParams): Promise<ApplyResult>
  reload(): Promise<void>
}

/** 构建分配执行器：校验预览（不落盘）→ 执行改名与写回 → 重载数据源；任一步失败向上抛（Scheduler 捕获后跳过依赖文件的任务） */
export function buildFileAssignRunner(deps: FileAssignRunnerDeps): (config: FileAssignConfig) => Promise<void> {
  return async (config) => {
    const plan = await preparePreview({ sourceDir: config.sourceDir, column: config.column, template: config.template, xlsxPath: deps.xlsxPath })
    await deps.apply({ sourceDir: config.sourceDir, column: config.column, plan: plan.plan, xlsxPath: deps.xlsxPath })
    await deps.reload()
  }
}
