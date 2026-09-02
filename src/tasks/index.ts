/**
 * 任务注册表（tasks 层）：所有任务的集中登记与加载
 * 依赖方向：依赖各任务实现文件，被 app 顶层装配
 * 设计思路：新任务三步——新建文件实现 SiteTask → 在 ALL 数组登记 → 自动获得调度/API/面板能力
 */
import type { SiteTask } from './base'
import { ExampleCheckinTask } from './example-checkin'
import { FaucetExampleTask } from './faucet-example'
import { MintExampleTask } from './mint-example'
import { InceptionDachainTask } from './inception-dachain'
import { PortalRhunaTask } from './portal-rhuna'

// 全部任务实例（每个任务一个单例，跨调度器/API/队列共享状态）
const ALL: SiteTask[] = [new ExampleCheckinTask(), new FaucetExampleTask(), new MintExampleTask(), new InceptionDachainTask(), new PortalRhunaTask()]

/** 以 meta.key 为索引构建任务表（key 重复会覆盖——登记时注意唯一性） */
export function loadTasks(): Map<string, SiteTask> {
  const map = new Map<string, SiteTask>()
  for (const t of ALL) map.set(t.meta.key, t)
  return map
}
