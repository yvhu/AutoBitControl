import { describe, it, expect } from 'vitest'
import { buildTaskInfo } from './hooks'
import type { TaskMetaView } from '../../types'

describe('buildTaskInfo', () => {
  it('名称与分组名映射', () => {
    const tasks = [
      { key: 'a', name: '任务A', group: { key: 'g1', name: '组1' } },
      { key: 'b', name: '任务B', group: null },
    ] as unknown as TaskMetaView[]
    expect(buildTaskInfo(tasks)).toEqual({
      a: { name: '任务A', groupName: '组1' },
      b: { name: '任务B', groupName: null },
    })
  })

  it('空数组返回空映射', () => {
    expect(buildTaskInfo([])).toEqual({})
  })
})
