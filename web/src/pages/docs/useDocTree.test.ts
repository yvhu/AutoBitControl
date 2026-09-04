import { describe, it, expect } from 'vitest'
import { extractChapterTree } from './useDocTree'

describe('extractChapterTree', () => {
  it('h2 章嵌套 h3 节', () => {
    const md = [
      '# 手册标题',
      '## 1. 快速开始',
      '### 写一个任务',
      '### 验证',
      '## 2. TaskMeta 字段全解',
    ].join('\n')
    expect(extractChapterTree(md)).toEqual([
      { key: '1-快速开始', title: '1. 快速开始', children: [
        { key: '写一个任务', title: '写一个任务' },
        { key: '验证', title: '验证' },
      ] },
      { key: '2-taskmeta-字段全解', title: '2. TaskMeta 字段全解', children: [] },
    ])
  })

  it('无节章 children 为空数组；忽略 h1', () => {
    const md = ['# 标题', '## 名词表', '正文', '## 7. 调度'].join('\n')
    expect(extractChapterTree(md)).toEqual([
      { key: '名词表', title: '名词表', children: [] },
      { key: '7-调度', title: '7. 调度', children: [] },
    ])
  })

  it('CRLF 行尾（Windows 检出）也能提取章节', () => {
    const md = ['# 手册标题', '## 1. 快速开始', '### 写一个任务', '## 2. TaskMeta 字段全解'].join('\r\n')
    expect(extractChapterTree(md)).toEqual([
      { key: '1-快速开始', title: '1. 快速开始', children: [
        { key: '写一个任务', title: '写一个任务' },
      ] },
      { key: '2-taskmeta-字段全解', title: '2. TaskMeta 字段全解', children: [] },
    ])
  })

  it('跳过围栏代码块内形似标题的行', () => {
    const md = [
      '## 1. 快速开始',
      '```',
      '## 不是标题',
      '### 也不是节',
      '```',
      '### 真节',
    ].join('\n')
    expect(extractChapterTree(md)).toEqual([
      { key: '1-快速开始', title: '1. 快速开始', children: [
        { key: '真节', title: '真节' },
      ] },
    ])
  })
})
