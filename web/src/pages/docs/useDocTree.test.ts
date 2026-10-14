import { describe, it, expect } from 'vitest'
import { extractChapterTree, filterTree, findAncestorKeys, type DocNode } from './useDocTree'

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

describe('filterTree', () => {
  const tree: DocNode[] = [
    { key: '1-快速开始', title: '1. 快速开始', children: [
      { key: '写一个任务', title: '写一个任务' },
      { key: '验证', title: '验证' },
    ] },
    { key: 'examples', title: '🧩 任务示例', children: [
      { key: 'src://a', title: '每日签到' },
      { key: 'src://b', title: '领水水龙头' },
    ] },
    { key: 'ext://api-docs', title: '📄 API 接口文档' },
  ]

  it('空查询返回全部节点', () => {
    expect(filterTree(tree, '')).toEqual(tree)
    expect(filterTree(tree, '   ')).toEqual(tree)
  })

  it('子节点命中时保留父节点且只保留命中的子节点', () => {
    expect(filterTree(tree, '验证')).toEqual([
      { key: '1-快速开始', title: '1. 快速开始', children: [
        { key: '验证', title: '验证' },
      ] },
    ])
  })

  it('父节点命中时保留其全部子节点', () => {
    expect(filterTree(tree, '任务示例')).toEqual([
      { key: 'examples', title: '🧩 任务示例', children: [
        { key: 'src://a', title: '每日签到' },
        { key: 'src://b', title: '领水水龙头' },
      ] },
    ])
  })

  it('叶子节点命中正常保留', () => {
    expect(filterTree(tree, 'API')).toEqual([
      { key: 'ext://api-docs', title: '📄 API 接口文档' },
    ])
  })

  it('无命中返回空数组', () => {
    expect(filterTree(tree, '不存在')).toEqual([])
  })
})

describe('findAncestorKeys', () => {
  const tree: DocNode[] = [
    { key: '1-快速开始', title: '1. 快速开始', children: [
      { key: '写一个任务', title: '写一个任务' },
      { key: '验证', title: '验证' },
    ] },
    { key: 'examples', title: '🧩 任务示例', children: [
      { key: 'src://a', title: '每日签到' },
    ] },
    { key: 'ext://api-docs', title: '📄 API 接口文档' },
  ]

  it('子节点命中返回其父节点 key', () => {
    expect(findAncestorKeys(tree, '验证')).toEqual(['1-快速开始'])
    expect(findAncestorKeys(tree, 'src://a')).toEqual(['examples'])
  })

  it('顶层节点或无命中返回空数组', () => {
    expect(findAncestorKeys(tree, '1-快速开始')).toEqual([])
    expect(findAncestorKeys(tree, '不存在')).toEqual([])
  })

  it('支持多层嵌套返回自顶向下的祖先链', () => {
    const nested: DocNode[] = [
      { key: 'a', title: 'a', children: [
        { key: 'b', title: 'b', children: [
          { key: 'c', title: 'c' },
        ] },
      ] },
    ]
    expect(findAncestorKeys(nested, 'c')).toEqual(['a', 'b'])
  })
})
