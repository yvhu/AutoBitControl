import { describe, it, expect } from 'vitest'
import { categoryColor, categoryLabel } from './hooks'

describe('categoryColor', () => {
  it('checkin 绿 / faucet 蓝 / mint 金 / other 灰', () => {
    expect(categoryColor('checkin')).toBe('#34D399')
    expect(categoryColor('faucet')).toBe('#38BDF8')
    expect(categoryColor('mint')).toBe('#FBBF24')
    expect(categoryColor('other')).toBe('#BAC5D9')
  })

  it('缺省（null）回退灰色', () => {
    expect(categoryColor(null)).toBe('#BAC5D9')
  })
})

describe('categoryLabel', () => {
  it('四类中文标签', () => {
    expect(categoryLabel('checkin')).toBe('签到')
    expect(categoryLabel('faucet')).toBe('领水')
    expect(categoryLabel('mint')).toBe('铸币')
    expect(categoryLabel('other')).toBe('其他')
  })

  it('缺省（null）回退「其他」', () => {
    expect(categoryLabel(null)).toBe('其他')
  })
})

import { triggerButton } from './index'

describe('triggerButton', () => {
  it('在途 → disabled + 「运行中」', () => {
    expect(triggerButton(true)).toEqual({ disabled: true, label: '运行中' })
  })
  it('非在途 → 可点 + 「立即触发」', () => {
    expect(triggerButton(false)).toEqual({ disabled: false, label: '立即触发' })
  })
})

import { groupTasks } from './hooks'
import type { TaskMetaView } from '../../types'

describe('groupTasks', () => {
  const t = (key: string, group: { key: string; name: string } | null) => ({ key, name: `任务${key}`, group }) as unknown as TaskMetaView

  it('按组内第一个任务的出现顺序分组', () => {
    const tasks = [t('a', { key: 'g2', name: '组2' }), t('b', { key: 'g1', name: '组1' }), t('c', { key: 'g2', name: '组2' })]
    const groups = groupTasks(tasks)
    expect(groups.map((g) => g.key)).toEqual(['g2', 'g1'])
    expect(groups[0].tasks.map((x) => x.key)).toEqual(['a', 'c'])
    expect(groups[1].tasks.map((x) => x.key)).toEqual(['b'])
  })

  it('未分组任务归入末尾伪分组（key 空串、name 未分组）', () => {
    const groups = groupTasks([t('a', { key: 'g1', name: '组1' }), t('b', null)])
    expect(groups.map((g) => g.key)).toEqual(['g1', ''])
    expect(groups[1].name).toBe('未分组')
    expect(groups[1].tasks.map((x) => x.key)).toEqual(['b'])
  })

  it('未分组任务出现在中间时也保证垫底', () => {
    const groups = groupTasks([t('a', { key: 'g1', name: '组1' }), t('b', null), t('c', { key: 'g2', name: '组2' })])
    expect(groups.map((g) => g.key)).toEqual(['g1', 'g2', ''])
    expect(groups[2].tasks.map((x) => x.key)).toEqual(['b'])
  })

  it('全部未分组返回单一伪分组', () => {
    const groups = groupTasks([t('a', null), t('b', null)])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('')
  })

  it('空数组返回空数组', () => {
    expect(groupTasks([])).toEqual([])
  })
})

import { GROUP_COLOR_MAP, groupColor, toggleKey } from './hooks'

describe('groupColor', () => {
  it('已知分组取固定色', () => {
    expect(groupColor('shelby', 0)).toBe('#1677FF')
    expect(groupColor('inception', 0)).toBe('#52c41a')
    expect(groupColor('portal', 0)).toBe('#faad14')
    expect(groupColor('arc', 0)).toBe('#722ed1')
    expect(groupColor('example', 0)).toBe('#8c8c8c')
  })

  it('未知分组按索引轮换回退色', () => {
    expect(groupColor('unknown-a', 0)).toBe('#13c2c2')
    expect(groupColor('unknown-b', 1)).toBe('#eb2f96')
  })

  it('索引超出回退色数组长度时取模轮换', () => {
    expect(groupColor('unknown-c', 6)).toBe('#13c2c2')
    expect(groupColor('unknown-d', 7)).toBe('#eb2f96')
  })

  it('GROUP_COLOR_MAP 五个已知分组齐全', () => {
    expect(Object.keys(GROUP_COLOR_MAP).sort()).toEqual(['arc', 'example', 'inception', 'portal', 'shelby'])
  })
})

describe('toggleKey', () => {
  it('不存在时追加到末尾', () => {
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('存在时移除且其余顺序不变', () => {
    expect(toggleKey(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
})
