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
  for (const line of markdown.split('\n')) {
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
