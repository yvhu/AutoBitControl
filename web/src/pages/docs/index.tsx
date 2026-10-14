import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AutoComplete, Button, Drawer, Empty, FloatButton, Input, Spin, Splitter, Tree, Typography, theme as antdTheme } from 'antd'
import { MenuOutlined } from '@ant-design/icons'
import { fetchExampleSource, fetchExamples, fetchGuide } from '../../api/endpoints'
import MarkdownView, { CodeExpandContext } from './markdown'
import { extractChapterTree, filterTree, type DocNode } from './useDocTree'
import { PANEL_MAX_SIZE, PANEL_MIN_SIZE, persistPanelSize, readStoredPanelSize } from './panelSize'
import { extractOutline, type OutlineHeading } from './outline'
import { searchGuide } from './search'
import { useMediaQuery } from './useMediaQuery'
import './docs.css'

const EXAMPLE_LABELS: Record<string, string> = {
  'example-checkin.ts': '每日签到',
  'faucet-example.ts': '领水水龙头',
  'mint-example.ts': '铸币 Mint',
}

const EXPANDED_STORAGE_KEY = 'docs:expanded'

const CODE_VIEW_STYLE: React.CSSProperties = {
  background: '#101A2E',
  border: '1px solid rgba(255,255,255,.08)',
  borderRadius: 10,
  overflow: 'hidden',
  fontFamily: 'Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.7,
}

// 允许在 style 上写自定义 CSS 变量（CSSProperties 关闭了索引签名）
type StyleWithVars = React.CSSProperties & Record<string, string | number>

function readStoredExpanded(): React.Key[] | null {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as React.Key[]) : null
  } catch {
    return null
  }
}

// 把滚动容器滚动到指定节点：仅调整容器自身 scrollTop，绝不带动整页
function keepVisible(container: HTMLElement | null, selector: string) {
  const nodeEl = container?.querySelector<HTMLElement>(selector)
  if (!container || !nodeEl) return
  const containerRect = container.getBoundingClientRect()
  const nodeRect = nodeEl.getBoundingClientRect()
  if (nodeRect.top < containerRect.top) {
    container.scrollTop -= containerRect.top - nodeRect.top
  } else if (nodeRect.bottom > containerRect.bottom) {
    container.scrollTop += nodeRect.bottom - containerRect.bottom
  }
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
  const { token } = antdTheme.useToken()
  const guide = useQuery({ queryKey: ['docs-guide'], queryFn: fetchGuide })
  const examples = useQuery({ queryKey: ['docs-examples'], queryFn: fetchExamples })
  const [view, setView] = useState<'guide' | 'source'>('guide')
  const [sourceName, setSourceName] = useState<string | null>(null)
  // 当前滚动到的标题 id：同时驱动左侧章节高亮与右侧「目录」页内高亮
  const [activeId, setActiveId] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const isNarrow = useMediaQuery('(max-width: 900px)')
  // localStorage 只在挂载时读一次：lazy 初始化取得记忆值，供默认展开态与「是否已初始化」判断共用
  const [storedExpanded] = useState(readStoredExpanded)
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>(() => storedExpanded ?? [])
  const [treeFilter, setTreeFilter] = useState('')
  const [searchValue, setSearchValue] = useState('')
  const [codeExpanded, setCodeExpanded] = useState(false)
  const [codeNonce, setCodeNonce] = useState(0)
  const [panelSize] = useState(readStoredPanelSize)
  const contentRef = useRef<HTMLDivElement>(null)
  // 左侧目录自身的滚动容器：滚动跟随只调整它的 scrollTop，绝不用 scrollIntoView（会带动整页）
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
  const tocScrollRef = useRef<HTMLUListElement>(null)
  // 首次进入且本地无记忆时，默认展开所有章节；有记忆时尊重用户上次的展开态
  const expandedInitialized = useRef<boolean>(storedExpanded !== null)

  const docVars = useMemo<StyleWithVars>(() => ({
    '--doc-border': token.colorBorderSecondary,
    '--doc-blockquote-bg': token.colorFillQuaternary,
    '--doc-fill': token.colorFillTertiary,
    '--doc-code-bg': token.colorFillTertiary,
    '--doc-primary': token.colorPrimary,
    '--doc-text-secondary': token.colorTextSecondary,
  }), [token])

  const source = useQuery({
    queryKey: ['docs-example-source', sourceName],
    queryFn: () => fetchExampleSource(sourceName!),
    enabled: view === 'source' && sourceName !== null,
  })

  // 左侧菜单只列顶层章节（##）；子小节交由右侧「目录」承载，底部保留示例与 API 入口
  const treeData = useMemo<DocNode[]>(() => {
    const chapters = (guide.data ? extractChapterTree(guide.data.content) : [])
      .map((chapter) => ({ key: chapter.key, title: chapter.title }))
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

  // 页内大纲：当前章节（##）下的 h3/h4 小节即右侧「目录」条目
  const outline = useMemo(() => (guide.data ? extractOutline(guide.data.content) : []), [guide.data])
  const outlineByKey = useMemo(() => new Map(outline.map((heading) => [heading.key, heading])), [outline])
  const activeChapterKey = activeId ? (outlineByKey.get(activeId)?.chapterKey ?? '') : ''
  const tocItems = useMemo(
    () => outline.filter((heading) => heading.level > 2 && heading.chapterKey === activeChapterKey),
    [outline, activeChapterKey],
  )

  const filteredTree = useMemo(() => filterTree(treeData, treeFilter), [treeData, treeFilter])

  const visibleExpandedKeys = useMemo<React.Key[]>(() => {
    if (!treeFilter.trim()) return expandedKeys
    const matchedParents = filteredTree.filter((n) => n.children && n.children.length > 0).map((n) => n.key)
    return Array.from(new Set<string>([...expandedKeys.map(String), ...matchedParents.map(String)]))
  }, [expandedKeys, filteredTree, treeFilter])

  const treeSelectedKeys = useMemo<React.Key[]>(() => {
    if (view === 'source' && sourceName) return [`src://${sourceName}`]
    return activeChapterKey ? [activeChapterKey] : []
  }, [view, sourceName, activeChapterKey])

  useEffect(() => {
    if (expandedInitialized.current) return
    const parents = treeData.filter((n) => n.children && n.children.length > 0).map((n) => n.key)
    if (parents.length === 0) return
    expandedInitialized.current = true
    setExpandedKeys(parents)
  }, [treeData])

  useEffect(() => {
    if (!expandedInitialized.current) return
    try {
      localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expandedKeys))
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, [expandedKeys])

  const manualTitle = useMemo(() => {
    const matched = /^#\s+(.+)$/m.exec(guide.data?.content ?? '')
    return matched ? matched[1].trim() : '使用手册'
  }, [guide.data])

  const searchHits = useMemo(
    () => (guide.data ? searchGuide(guide.data.content, searchValue) : []),
    [guide.data, searchValue],
  )

  const searchOptions = useMemo(
    () => searchHits.map((hit) => ({
      value: hit.id,
      label: (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.5 }}>
          <span>{hit.title}</span>
          {hit.snippet && <span style={{ fontSize: 12, opacity: 0.65 }}>{hit.snippet}</span>}
        </div>
      ),
    })),
    [searchHits],
  )

  // 滚动联动：按大纲顺序定位当前标题，驱动左右两侧高亮并让高亮项保持在各自容器可视区
  useEffect(() => {
    if (view !== 'guide' || outline.length === 0) return
    const update = () => {
      const bottom = window.innerHeight * 0.25
      let current: OutlineHeading | null = null
      for (const heading of outline) {
        const el = document.getElementById(heading.key)
        if (!el) continue
        if (el.getBoundingClientRect().top <= bottom) current = heading
        else break
      }
      if (!current) current = outline[0]
      setActiveId(current.key)
      keepVisible(sidebarScrollRef.current, `[data-doc-key="${current.chapterKey}"]`)
      keepVisible(tocScrollRef.current, `[data-toc-key="${current.key}"]`)
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
  }, [view, outline])

  const scrollToHeading = (key: string) => {
    setView('guide')
    setActiveId(key)
    setNavOpen(false)
    requestAnimationFrame(() => {
      document.getElementById(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const toggleAllCode = () => {
    setCodeExpanded((prev) => !prev)
    setCodeNonce((n) => n + 1)
  }

  const codeExpandValue = useMemo(() => ({ expanded: codeExpanded, nonce: codeNonce }), [codeExpanded, codeNonce])

  const openSource = (name: string) => {
    setSourceName(name)
    setView('source')
    setActiveId('')
    setNavOpen(false)
    window.scrollTo({ top: 0 })
  }

  const handleSelect: NonNullable<React.ComponentProps<typeof Tree>['onSelect']> = (keys) => {
    const key = String(keys[0] ?? '')
    if (key.startsWith('src://')) {
      openSource(key.slice('src://'.length))
    } else if (key.startsWith('ext://')) {
      window.open('/api-docs', '_blank')
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
      scrollToHeading(href.slice(1))
    } else if (href.startsWith('src://')) {
      e.preventDefault()
      openSource(href.slice('src://'.length))
    }
  }

  const sidebar = (
    <aside className="doc-sidebar">
      <div className="doc-sidebar-inner">
        <Input
          className="doc-sidebar-filter"
          allowClear
          placeholder="筛选章节"
          value={treeFilter}
          onChange={(e) => setTreeFilter(e.target.value)}
        />
        <div className="doc-sidebar-scroll" ref={sidebarScrollRef}>
          {guide.isPending ? (
            <div className="doc-sidebar-loading"><Spin /></div>
          ) : (
            <Tree
              className="doc-tree"
              treeData={filteredTree}
              selectedKeys={treeSelectedKeys}
              expandedKeys={visibleExpandedKeys}
              onExpand={(keys) => setExpandedKeys(keys)}
              onSelect={handleSelect}
              titleRender={(node) => (
                <span className="doc-tree-title" data-doc-key={String(node.key)} title={String(node.title)}>
                  {String(node.title)}
                </span>
              )}
            />
          )}
        </div>
      </div>
    </aside>
  )

  const article = (
    <CodeExpandContext.Provider value={codeExpandValue}>
      <div className="doc-article">
        {view === 'guide' && (
          <div className="doc-toolbar">
            <Typography.Title level={4} ellipsis className="doc-toolbar-title">{manualTitle}</Typography.Title>
            <AutoComplete
              className="doc-toolbar-search"
              value={searchValue}
              options={searchOptions}
              onChange={setSearchValue}
              onSelect={(value) => scrollToHeading(String(value))}
              placeholder="搜索手册章节…"
              allowClear
              notFoundContent={searchValue.trim() ? '无匹配章节' : null}
            />
            <Button onClick={toggleAllCode}>{codeExpanded ? '全部折叠' : '全部展开'}</Button>
          </div>
        )}
        <div className="doc-content" ref={contentRef} onClick={handleContentClick}>
          {view === 'guide' ? (
            guide.isPending ? (
              <div className="doc-loading"><Spin /></div>
            ) : guide.isError || !guide.data ? (
              <Empty description="手册加载失败" />
            ) : (
              <MarkdownView content={guide.data.content} />
            )
          ) : source.isPending ? (
            <div className="doc-loading"><Spin /></div>
          ) : source.isError || !source.data ? (
            <Empty description="示例源码加载失败" />
          ) : (
            <SourceView name={sourceName ?? ''} content={source.data.content} />
          )}
        </div>
      </div>
    </CodeExpandContext.Provider>
  )

  const toc = view === 'guide' && tocItems.length > 0 ? (
    <nav className="doc-toc" aria-label="目录">
      <div className="doc-toc-title">目录</div>
      <ul className="doc-toc-list" ref={tocScrollRef}>
        {tocItems.map((item) => (
          <li
            key={item.key}
            className={`doc-toc-item doc-toc-item--h${item.level}${item.key === activeId ? ' doc-toc-item--active' : ''}`}
          >
            <a data-toc-key={item.key} onClick={() => scrollToHeading(item.key)}>{item.title}</a>
          </li>
        ))}
      </ul>
    </nav>
  ) : null

  if (isNarrow) {
    return (
      <>
        <div className="doc-page" style={docVars}>
          <div className="doc-narrow-bar">
            <Button icon={<MenuOutlined />} onClick={() => setNavOpen(true)}>目录</Button>
            <Typography.Text strong ellipsis className="doc-narrow-title">{manualTitle}</Typography.Text>
          </div>
          <div className="doc-main">{article}</div>
        </div>
        <Drawer open={navOpen} onClose={() => setNavOpen(false)} placement="left" width={280} title="文档章节" styles={{ body: { padding: 0 } }}>
          {sidebar}
        </Drawer>
        <FloatButton.BackTop />
      </>
    )
  }

  return (
    <>
      {/* --doc-* 变量定义在最外层：左侧目录、右侧正文与「目录」共享同一套配色，随明暗主题变化 */}
      <div className="doc-page" style={docVars}>
        <Splitter className="doc-splitter" onResizeEnd={(sizes) => persistPanelSize(sizes[0])}>
          <Splitter.Panel
            defaultSize={panelSize}
            min={PANEL_MIN_SIZE}
            max={PANEL_MAX_SIZE}
            collapsible
            style={{ overflow: 'visible' }}
          >
            {sidebar}
          </Splitter.Panel>
          <Splitter.Panel style={{ overflow: 'visible' }}>
            <div className="doc-main">
              {article}
              {toc}
            </div>
          </Splitter.Panel>
        </Splitter>
      </div>
      <FloatButton.BackTop />
    </>
  )
}
