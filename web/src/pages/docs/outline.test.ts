import { describe, it, expect } from 'vitest'
import { extractOutline } from './outline'

describe('extractOutline', () => {
  it('按文档顺序输出 h2/h3/h4 并标注层级与归属章节', () => {
    const md = [
      '# 手册标题',
      '## 1. 快速开始',
      '### 写一个任务',
      '#### openPage(ctx)',
      '## 2. TaskMeta 字段全解',
      '### 2.1 meta',
    ].join('\n')
    expect(extractOutline(md)).toEqual([
      { key: '1-快速开始', title: '1. 快速开始', level: 2, chapterKey: '1-快速开始' },
      { key: '写一个任务', title: '写一个任务', level: 3, chapterKey: '1-快速开始' },
      { key: 'openpagectx', title: 'openPage(ctx)', level: 4, chapterKey: '1-快速开始' },
      { key: '2-taskmeta-字段全解', title: '2. TaskMeta 字段全解', level: 2, chapterKey: '2-taskmeta-字段全解' },
      { key: '21-meta', title: '2.1 meta', level: 3, chapterKey: '2-taskmeta-字段全解' },
    ])
  })

  it('忽略 h1/h5/h6', () => {
    const md = ['# 一级', '## 章', '##### 五级', '###### 六级'].join('\n')
    expect(extractOutline(md)).toEqual([
      { key: '章', title: '章', level: 2, chapterKey: '章' },
    ])
  })

  it('跳过围栏代码块内形似标题的行', () => {
    const md = [
      '## 章',
      '```',
      '### 不是标题',
      '#### 也不是',
      '```',
      '### 真节',
    ].join('\n')
    expect(extractOutline(md)).toEqual([
      { key: '章', title: '章', level: 2, chapterKey: '章' },
      { key: '真节', title: '真节', level: 3, chapterKey: '章' },
    ])
  })

  it('CRLF 行尾也能提取', () => {
    const md = ['## 章', '### 节'].join('\r\n')
    expect(extractOutline(md)).toEqual([
      { key: '章', title: '章', level: 2, chapterKey: '章' },
      { key: '节', title: '节', level: 3, chapterKey: '章' },
    ])
  })

  it('章节之前出现的小节归属为空串', () => {
    const md = ['### 孤立节', '## 章'].join('\n')
    expect(extractOutline(md)).toEqual([
      { key: '孤立节', title: '孤立节', level: 3, chapterKey: '' },
      { key: '章', title: '章', level: 2, chapterKey: '章' },
    ])
  })
})
