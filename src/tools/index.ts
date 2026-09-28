/**
 * 工具注册表（tools 层）：面板工具中心的数据源
 * 依赖方向：无依赖，被 server 路由引用；新增工具在此登记，前端卡片按 key 扩展
 */
export interface ToolMeta {
  key: string
  name: string
  description: string
}

export const TOOLS: ToolMeta[] = [
  {
    key: 'file-assign',
    name: '文件随机分配',
    description: '按名称模板重命名指定文件夹内的文件，随机分配给 accounts.xlsx 各账号行并写回目标列',
  },
]
