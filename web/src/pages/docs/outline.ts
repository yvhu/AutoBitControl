/**
 * 手册大纲提取：按文档顺序输出 ## / ### / #### 标题及其归属章节，供右侧「目录」页内导航使用。
 * 依赖方向：仅依赖 slugify（锚点 id 契约与正文渲染一致）。
 */

import { slugify } from './slug'

export interface OutlineHeading {
  key: string
  title: string
  level: 2 | 3 | 4
  // 所属 ## 章节的 key；level 2 时等于自身 key，出现在任何 ## 之前时为空串
  chapterKey: string
}

// 逐行扫描，跳过围栏代码块；忽略 h1/h5/h6（不进入页内目录）
export function extractOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  let chapterKey = ''
  let inFence = false
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h2 = /^##\s+(.+)$/.exec(line)
    if (h2) {
      const title = h2[1].trim()
      chapterKey = slugify(title)
      headings.push({ key: chapterKey, title, level: 2, chapterKey })
      continue
    }
    const h3 = /^###\s+(.+)$/.exec(line)
    if (h3) {
      const title = h3[1].trim()
      headings.push({ key: slugify(title), title, level: 3, chapterKey })
      continue
    }
    const h4 = /^####\s+(.+)$/.exec(line)
    if (h4) {
      const title = h4[1].trim()
      headings.push({ key: slugify(title), title, level: 4, chapterKey })
    }
  }
  return headings
}
