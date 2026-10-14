import { describe, it, expect } from 'vitest'
import { searchGuide } from './search'

describe('searchGuide', () => {
  it('空查询返回空数组', () => {
    expect(searchGuide('## 1. 快速开始\n正文', '')).toEqual([])
    expect(searchGuide('## 1. 快速开始\n正文', '   ')).toEqual([])
  })

  it('标题命中：返回 slugify 后的 id 与标题', () => {
    const md = ['## 1. 快速开始', '正文内容', '## 2. TaskMeta 字段全解'].join('\n')
    expect(searchGuide(md, 'TaskMeta')).toEqual([
      { id: '2-taskmeta-字段全解', title: '2. TaskMeta 字段全解', snippet: '' },
    ])
  })

  it('正文命中：snippet 为命中的整行（去除首尾空白）', () => {
    const md = ['## 1. 快速开始', '  这里讲 TaskMeta 的字段  ', '## 2. 其他'].join('\n')
    expect(searchGuide(md, 'TaskMeta')).toEqual([
      { id: '1-快速开始', title: '1. 快速开始', snippet: '这里讲 TaskMeta 的字段' },
    ])
  })

  it('跳过围栏代码块内的命中', () => {
    const md = [
      '## 1. 快速开始',
      '```ts',
      'const TaskMeta = 1',
      '## 假标题',
      '```',
      '普通正文',
    ].join('\n')
    expect(searchGuide(md, 'TaskMeta')).toEqual([])
  })

  it('无命中返回空数组', () => {
    const md = ['## 1. 快速开始', '正文'].join('\n')
    expect(searchGuide(md, '不存在的词')).toEqual([])
  })

  it('大小写不敏感', () => {
    const md = ['## taskmeta 说明'].join('\n')
    expect(searchGuide(md, 'TASKMETA')).toEqual([
      { id: 'taskmeta-说明', title: 'taskmeta 说明', snippet: '' },
    ])
  })

  it('标题命中优先于正文命中，只返回一条', () => {
    const md = ['## TaskMeta 字段', '这里也提到 TaskMeta'].join('\n')
    expect(searchGuide(md, 'TaskMeta')).toEqual([
      { id: 'taskmeta-字段', title: 'TaskMeta 字段', snippet: '' },
    ])
  })

  it('snippet 超过 60 字符时截断并追加省略号', () => {
    const long = '甲'.repeat(80)
    const md = ['## 标题', long].join('\n')
    const [hit] = searchGuide(md, '甲')
    expect(hit.snippet).toBe('甲'.repeat(60) + '…')
  })

  it('四级及更深标题（####/######）同样命中并返回 slugify id', () => {
    const md = ['#### wallet.ensureLoggedIn', '正文内容', '###### 深层小节', '更多正文'].join('\n')
    expect(searchGuide(md, 'wallet')).toEqual([
      { id: 'walletensureloggedin', title: 'wallet.ensureLoggedIn', snippet: '' },
    ])
    expect(searchGuide(md, '深层小节')).toEqual([
      { id: '深层小节', title: '深层小节', snippet: '' },
    ])
  })
})
