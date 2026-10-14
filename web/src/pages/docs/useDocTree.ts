import { slugify } from './slug'

export interface DocNode {
  key: string
  title: string
  children?: DocNode[]
}

export function extractChapterTree(markdown: string): DocNode[] {
  const chapters: DocNode[] = []
  let current: DocNode | null = null
  let inFence = false
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h2 = /^##\s+(.+)$/.exec(line)
    const h3 = /^###\s+(.+)$/.exec(line)
    if (h2) {
      current = { key: slugify(h2[1]), title: h2[1].trim(), children: [] }
      chapters.push(current)
    } else if (h3 && current) {
      current.children!.push({ key: slugify(h3[1]), title: h3[1].trim() })
    }
  }
  return chapters
}

// 按标题过滤目录：父节点命中保留全部子节点，子节点命中则只保留命中的子节点
export function filterTree(nodes: DocNode[], query: string): DocNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes
  const result: DocNode[] = []
  for (const node of nodes) {
    const selfMatch = node.title.toLowerCase().includes(q)
    const children = selfMatch
      ? node.children
      : (node.children ?? []).filter((child) => child.title.toLowerCase().includes(q))
    if (selfMatch || (children !== undefined && children.length > 0)) {
      result.push(children !== undefined ? { ...node, children } : { ...node })
    }
  }
  return result
}

// 定位某节点的祖先链（自顶向下），用于选中/滚动时展开所在章
export function findAncestorKeys(nodes: DocNode[], key: string): string[] {
  for (const node of nodes) {
    if (!node.children || node.children.length === 0) continue
    if (node.children.some((child) => child.key === key)) return [node.key]
    const deeper = findAncestorKeys(node.children, key)
    if (deeper.length > 0) return [node.key, ...deeper]
  }
  return []
}
