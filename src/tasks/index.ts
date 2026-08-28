import type { SiteTask } from './base'
import { ExampleCheckinTask } from './example-checkin'

const ALL: SiteTask[] = [new ExampleCheckinTask()]

export function loadTasks(): Map<string, SiteTask> {
  const map = new Map<string, SiteTask>()
  for (const t of ALL) map.set(t.meta.key, t)
  return map
}
