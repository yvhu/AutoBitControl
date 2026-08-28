import type { SiteTask } from './base'
import { ExampleCheckinTask } from './example-checkin'
import { FaucetExampleTask } from './faucet-example'
import { MintExampleTask } from './mint-example'

const ALL: SiteTask[] = [new ExampleCheckinTask(), new FaucetExampleTask(), new MintExampleTask()]

export function loadTasks(): Map<string, SiteTask> {
  const map = new Map<string, SiteTask>()
  for (const t of ALL) map.set(t.meta.key, t)
  return map
}
