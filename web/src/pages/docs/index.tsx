import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, Col, Empty, Row, Spin, Tree, Typography } from 'antd'
import { fetchExampleSource, fetchExamples, fetchGuide } from '../../api/endpoints'
import MarkdownView from './markdown'
import { extractChapterTree, type DocNode } from './useDocTree'

const EXAMPLE_LABELS: Record<string, string> = {
  'example-checkin.ts': '每日签到',
  'faucet-example.ts': '领水水龙头',
  'mint-example.ts': '铸币 Mint',
}

const CODE_VIEW_STYLE: React.CSSProperties = {
  background: '#101A2E',
  border: '1px solid rgba(255,255,255,.08)',
  borderRadius: 10,
  overflow: 'hidden',
  fontFamily: 'Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.7,
}

function SourceView({ name, content }: { name: string; content?: string }) {
  const lines = (content ?? '').split('\n')
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>{name}</Typography.Title>
      <div style={CODE_VIEW_STYLE}>
        {lines.map((line, i) => (
          <div className="code-line" key={i} style={{ display: 'flex' }}>
            <span className="code-num" style={{ width: 44, textAlign: 'right', paddingRight: 12, color: '#5D6B84', flexShrink: 0, userSelect: 'none' }}>{i + 1}</span>
            <span className="code-text" style={{ whiteSpace: 'pre', color: '#EDF2FA' }}>{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DocsPage() {
  const guide = useQuery({ queryKey: ['docs-guide'], queryFn: fetchGuide })
  const examples = useQuery({ queryKey: ['docs-examples'], queryFn: fetchExamples })
  const [view, setView] = useState<'guide' | 'source'>('guide')
  const [sourceName, setSourceName] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([])
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const contentRef = useRef<HTMLDivElement>(null)
  const treeWrapRef = useRef<HTMLDivElement>(null)

  const source = useQuery({
    queryKey: ['docs-example-source', sourceName],
    queryFn: () => fetchExampleSource(sourceName!),
    enabled: view === 'source' && sourceName !== null,
  })

  const treeData = useMemo<DocNode[]>(() => {
    const chapters = guide.data ? extractChapterTree(guide.data.content) : []
    const exampleChildren: DocNode[] = (examples.data ?? []).map((f) => ({
      key: `src://${f.name}`,
      title: EXAMPLE_LABELS[f.name] ?? f.label,
    }))
    return [
      ...chapters,
      { key: 'examples', title: '🧩 任务示例', children: exampleChildren },
      { key: 'ext://api-docs', title: '📄 API 接口文档' },
    ]
  }, [guide.data, examples.data])

  useEffect(() => {
    const parents = treeData.filter((n) => n.children && n.children.length > 0).map((n) => n.key)
    setExpandedKeys((prev) => {
      const missing = parents.filter((k) => !prev.includes(k))
      return missing.length > 0 ? [...prev, ...missing] : prev
    })
  }, [treeData])

  useEffect(() => {
    if (view !== 'guide') return
    const content = contentRef.current
    if (!content) return
    // 手册 h1/h2/h3 经 Typography.Title 渲染为 h2/h3/h4（level 2/3/4）
    const headings = Array.from(content.querySelectorAll('h2[id], h3[id], h4[id]'))
    if (headings.length === 0) return
    const bandTop = () => window.innerHeight * 0.1
    const bandBottom = () => window.innerHeight * 0.25
    const update = () => {
      const top = bandTop()
      const bottom = bandBottom()
      let current: Element | null = null
      for (const h of headings) {
        const r = h.getBoundingClientRect()
        if (r.top <= bottom) {
          if (r.bottom > top) current = h
        } else {
          break
        }
      }
      if (!current) return
      const id = current.id
      setSelectedKeys([id])
      treeWrapRef.current
        ?.querySelector(`[data-doc-key="${id}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    }
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      setTimeout(() => {
        ticking = false
        update()
      }, 80)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    update()
    return () => window.removeEventListener('scroll', onScroll)
  }, [view, guide.data])

  const scrollToHeading = (key: string) => {
    setView('guide')
    setSelectedKeys([key])
    requestAnimationFrame(() => {
      document.getElementById(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const openSource = (name: string) => {
    setSourceName(name)
    setView('source')
    setSelectedKeys([`src://${name}`])
    window.scrollTo({ top: 0 })
  }

  const handleSelect: NonNullable<React.ComponentProps<typeof Tree>['onSelect']> = (keys) => {
    const key = String(keys[0] ?? '')
    if (key.startsWith('src://')) {
      openSource(key.slice('src://'.length))
    } else if (key.startsWith('ext://')) {
      window.open('/api-docs', '_blank')
      setSelectedKeys((prev) => [...prev])
    } else {
      scrollToHeading(key)
    }
  }

  const handleContentClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
    if (!a) return
    let href = a.getAttribute('href') ?? ''
    try {
      href = decodeURIComponent(href)
    } catch {
      /* 无编码的普通链接原样使用 */
    }
    if (href.startsWith('#') && href.length > 1) {
      e.preventDefault()
      const id = href.slice(1)
      setView('guide')
      setSelectedKeys([id])
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    } else if (href.startsWith('src://')) {
      e.preventDefault()
      openSource(href.slice('src://'.length))
    }
  }

  return (
    <Row gutter={12}>
      <Col style={{ flex: '0 0 260px', position: 'sticky', top: 16, alignSelf: 'flex-start', maxHeight: 'calc(100vh - 32px)', overflow: 'auto' }}>
        <Card size="small">
          <div ref={treeWrapRef}>
            {guide.isPending ? (
              <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
            ) : (
              <Tree
                treeData={treeData}
                selectedKeys={selectedKeys}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                onSelect={handleSelect}
                titleRender={(node) => <span data-doc-key={String(node.key)}>{String(node.title)}</span>}
              />
            )}
          </div>
        </Card>
      </Col>
      <Col style={{ flex: '1 1 0', minWidth: 0 }}>
        <Card size="small">
          <div ref={contentRef} onClick={handleContentClick}>
            {view === 'guide' ? (
              guide.isPending ? (
                <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
              ) : guide.isError || !guide.data ? (
                <Empty description="手册加载失败" />
              ) : (
                <MarkdownView content={guide.data.content} />
              )
            ) : source.isPending ? (
              <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
            ) : source.isError || !source.data ? (
              <Empty description="示例源码加载失败" />
            ) : (
              <SourceView name={sourceName ?? ''} content={source.data.content} />
            )}
          </div>
        </Card>
      </Col>
    </Row>
  )
}
