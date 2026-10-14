import { slugify } from './slug'

export interface SearchHit {
  id: string
  title: string
  snippet: string
}

interface Section {
  title: string
  id: string
  lines: string[]
}

const SNIPPET_MAX = 60

// 手册全文检索：跳过围栏代码块，命中标题或章节正文的标题各返回一条（按出现顺序）
export function searchGuide(markdown: string, query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const sections: Section[] = []
  let current: Section | null = null
  let inFence = false

  for (const rawLine of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = /^(#{1,6})\s+(.+)$/.exec(rawLine)
    if (heading) {
      const title = heading[2].trim()
      current = { title, id: slugify(title), lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(rawLine)
  }

  const hits: SearchHit[] = []
  for (const section of sections) {
    if (section.title.toLowerCase().includes(q)) {
      hits.push({ id: section.id, title: section.title, snippet: '' })
      continue
    }
    const matched = section.lines.find((line) => line.toLowerCase().includes(q))
    if (matched !== undefined) {
      hits.push({ id: section.id, title: section.title, snippet: makeSnippet(matched) })
    }
  }
  return hits
}

function makeSnippet(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > SNIPPET_MAX ? trimmed.slice(0, SNIPPET_MAX) + '…' : trimmed
}
