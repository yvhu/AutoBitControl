import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Button, Table, type TableProps, Typography } from 'antd'
import { useThemeMode } from '../../theme/useThemeMode'
import { slugify } from './slug'

export interface CodeExpandState {
  expanded: boolean
  nonce: number
}

// 代码块展开态由页面工具栏统一驱动：工具栏每次点击递增 nonce，代码块在 nonce 变化时同步本地展开态
export const CodeExpandContext = createContext<CodeExpandState>({ expanded: false, nonce: 0 })

const SyntaxThemeContext = createContext<'light' | 'dark'>('light')

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node as { props?: { children?: ReactNode } }).props?.children)
  return ''
}

// 超过该行数的代码块默认折叠，并提供「展开」，避免长代码淹没正文
const CODE_COLLAPSE_LINES = 20

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const mode = useContext(SyntaxThemeContext)
  const { expanded, nonce } = useContext(CodeExpandContext)
  const isLong = code.split('\n').length > CODE_COLLAPSE_LINES
  const [open, setOpen] = useState(!isLong)
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>()
  // 首次渲染保留代码块自身的默认折叠态，仅在用户点击工具栏后才跟随全局展开态
  const firstRun = useRef(true)

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    setOpen(expanded)
  }, [expanded, nonce])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const handleCopy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => {
      /* 剪贴板不可用时静默失败 */
    })
  }

  return (
    <div className={isLong && !open ? 'doc-code doc-code--collapsed' : 'doc-code'}>
      <div className="doc-code-head">
        <span className="doc-code-lang">{lang || 'text'}</span>
        <span className="doc-code-actions">
          <Button className="doc-code-copy" type="text" size="small" onClick={handleCopy}>{copied ? '已复制' : '复制'}</Button>
          {isLong && (
            <Button className="doc-code-toggle" type="text" size="small" onClick={() => setOpen((value) => !value)}>
              {open ? '折叠' : '展开'}
            </Button>
          )}
        </span>
      </div>
      <div className={isLong && !open ? 'doc-code-body doc-code-body--collapsed' : 'doc-code-body'}>
        <SyntaxHighlighter
          language={lang || 'text'}
          style={mode === 'dark' ? oneDark : oneLight}
          customStyle={{ margin: 0, borderRadius: 0, background: 'transparent', padding: '14px 16px' }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  )
}

type HeadingProps = { children?: ReactNode }

// 标题 hover 时出现的「#」锚点：点击经内容区委托平滑滚动到自身
function HeadingAnchor({ id }: { id: string }) {
  return <a className="doc-anchor" href={`#${id}`} aria-label="锚点链接">#</a>
}

function H1({ children }: HeadingProps) {
  const id = slugify(textOf(children))
  return <Typography.Title level={3} id={id} className="doc-h1">{children}<HeadingAnchor id={id} /></Typography.Title>
}

function H2({ children }: HeadingProps) {
  const id = slugify(textOf(children))
  return <Typography.Title level={4} id={id} className="doc-h2">{children}<HeadingAnchor id={id} /></Typography.Title>
}

function H3({ children }: HeadingProps) {
  const id = slugify(textOf(children))
  return <Typography.Title level={5} id={id} className="doc-h3">{children}<HeadingAnchor id={id} /></Typography.Title>
}

// h4/h5/h6 用原生语义标签承载 id：搜索命中与锚点跳转依赖 id，纯样式标题不具备该能力
function H4({ children }: HeadingProps) {
  const id = slugify(textOf(children))
  return <h4 className="doc-h4" id={id}>{children}<HeadingAnchor id={id} /></h4>
}

function H5({ children }: HeadingProps) {
  const id = slugify(textOf(children))
  return <h5 className="doc-h5" id={id}>{children}<HeadingAnchor id={id} /></h5>
}

function H6({ children }: HeadingProps) {
  const id = slugify(textOf(children))
  return <h6 className="doc-h6" id={id}>{children}<HeadingAnchor id={id} /></h6>
}

type LinkProps = { href?: string; children?: ReactNode }

function Link({ href, children }: LinkProps) {
  return (
    <Typography.Link href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel={href?.startsWith('http') ? 'noreferrer' : undefined}>
      {children}
    </Typography.Link>
  )
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const match = /language-(\w+)/.exec(className ?? '')
  if (match) {
    return <CodeBlock lang={match[1]} code={String(children).replace(/\n$/, '')} />
  }
  return <Typography.Text code className="doc-inline-code">{children}</Typography.Text>
}

type MarkdownElement = { type?: unknown; props?: { children?: ReactNode } }

function tagOf(node: ReactNode): unknown {
  if (typeof node === 'object' && node !== null && 'type' in node) return (node as MarkdownElement).type
  return undefined
}

function cellText(node: ReactNode): string {
  return textOf(node).trim()
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  const rows: { header: boolean; cells: ReactNode[] }[] = []
  const collect = (node: ReactNode, inHead: boolean) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      node.forEach((n) => collect(n, inHead))
      return
    }
    const tag = tagOf(node)
    if (tag === 'thead') {
      collect((node as MarkdownElement).props?.children, true)
      return
    }
    if (tag === 'tbody') {
      collect((node as MarkdownElement).props?.children, false)
      return
    }
    if (tag === 'tr') {
      const child = (node as MarkdownElement).props?.children
      const cellNodes = Array.isArray(child) ? child : [child]
      rows.push({ header: inHead, cells: cellNodes.filter((c) => tagOf(c) === 'th' || tagOf(c) === 'td') })
    }
  }
  collect(children, false)
  const headerRow = rows.find((r) => r.header) ?? rows[0]
  const dataRows = rows.filter((r) => r !== headerRow)
  const columns: TableProps<Record<string, string>>['columns'] = (headerRow?.cells ?? []).map((cell, i) => ({
    title: cellText(cell),
    dataIndex: `c${i}`,
    key: `c${i}`,
  }))
  const dataSource = dataRows.map((row, i) => {
    const record: Record<string, string> = { key: String(i) }
    row.cells.forEach((cell, j) => {
      record[`c${j}`] = cellText(cell)
    })
    return record
  })
  return (
    <Table<Record<string, string>>
      size="small"
      bordered
      pagination={false}
      scroll={{ x: true }}
      columns={columns}
      dataSource={dataSource}
      style={{ margin: '12px 0' }}
    />
  )
}

// 组件定义放在模块级：行内箭头函数每次渲染都会产生新组件类型，导致标题节点整体重挂（破坏锚点引用与滚动监听）
const markdownComponents = {
  h1: H1,
  h2: H2,
  h3: H3,
  h4: H4,
  h5: H5,
  h6: H6,
  a: Link,
  code: Code,
  table: MarkdownTable,
}

export default function MarkdownView({ content }: { content: string }) {
  const { effective } = useThemeMode()

  return (
    <SyntaxThemeContext.Provider value={effective}>
      <Typography>
        <div className="doc-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => (/^(javascript|vbscript|data):/i.test(url) ? '' : url)}
            components={markdownComponents}
          >
            {content}
          </ReactMarkdown>
        </div>
      </Typography>
    </SyntaxThemeContext.Provider>
  )
}
