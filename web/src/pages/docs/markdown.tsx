import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Collapse, Table, type TableProps, Typography } from 'antd'
import { slugify } from './slug'

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) return textOf((node as { props?: { children?: ReactNode } }).props?.children)
  return ''
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapse
      ghost
      activeKey={open ? ['code'] : []}
      onChange={(keys) => setOpen((Array.isArray(keys) ? keys : [keys]).length > 0)}
      items={[{
        key: 'code',
        label: <Typography.Text type="secondary" style={{ fontSize: 12 }}>{open ? '▾' : '▸'} {lang}</Typography.Text>,
        children: (
          <SyntaxHighlighter language={lang} style={oneDark} customStyle={{ borderRadius: 8, margin: 0 }}>
            {code}
          </SyntaxHighlighter>
        ),
      }]}
      style={{ margin: '8px 0' }}
    />
  )
}

type HeadingProps = { children?: ReactNode }

function H1({ children }: HeadingProps) {
  return <Typography.Title level={3} id={slugify(textOf(children))} style={{ margin: '24px 0 8px' }}>{children}</Typography.Title>
}

function H2({ children }: HeadingProps) {
  return <Typography.Title level={4} id={slugify(textOf(children))} style={{ margin: '28px 0 12px' }}>{children}</Typography.Title>
}

function H3({ children }: HeadingProps) {
  return <Typography.Title level={5} id={slugify(textOf(children))} style={{ margin: '20px 0 8px' }}>{children}</Typography.Title>
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
  return <Typography.Text code>{children}</Typography.Text>
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
  a: Link,
  code: Code,
  table: MarkdownTable,
}

export default function MarkdownView({ content }: { content: string }) {
  return (
    <Typography>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (/^(javascript|vbscript|data):/i.test(url) ? '' : url)}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </Typography>
  )
}
