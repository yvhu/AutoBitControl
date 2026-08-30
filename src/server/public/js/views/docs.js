// 文档视图：手册（markdown 渲染）与示例源码（代码视图）的双栏浏览
import { get } from '../api.js'

let markedLoaded = null

// 懒加载 marked 库（一次加载缓存，加载失败静默——回退纯文本展示）
function ensureMarked() {
  if (markedLoaded) return markedLoaded
  markedLoaded = new Promise(resolve => {
    if (window.marked) { resolve(); return }
    const s = document.createElement('script')
    s.src = '/js/vendor/marked.min.js'
    s.onload = () => resolve()
    s.onerror = () => resolve()
    document.head.appendChild(s)
  })
  return markedLoaded
}

// markdown 渲染（marked 未就绪时回退为转义后的 pre 文本）
function renderMarkdown(content) {
  if (window.marked) {
    return window.marked.parse(content)
  }
  return '<pre>' + content.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])) + '</pre>'
}

// 代码块折叠：手册里的代码框默认收起，点击头部展开/收起（头部标注语言）
function makeCodeBlocksCollapsible(root) {
  root.querySelectorAll('.doc-md pre').forEach(pre => {
    const code = pre.querySelector('code')
    const langMatch = code?.className.match(/language-([\w-]+)/)
    const lang = langMatch ? langMatch[1] : '代码'
    const wrap = document.createElement('div')
    wrap.className = 'code-collapse'
    const head = document.createElement('div')
    head.className = 'code-collapse-head'
    head.textContent = `▸ ${lang}`
    pre.parentNode.insertBefore(wrap, pre)
    wrap.appendChild(head)
    wrap.appendChild(pre)
    head.addEventListener('click', () => {
      const collapsed = pre.style.display === 'none'
      pre.style.display = collapsed ? '' : 'none'
      head.textContent = `${collapsed ? '▾' : '▸'} ${lang}`
    })
    pre.style.display = 'none'
  })
}

// 标题锚点：marked 不生成标题 id，渲染后按目录约定补上（小写、去符号、空格转连字符、保留中文）
function injectHeadingIds(root) {
  root.querySelectorAll('h1, h2, h3').forEach(h => {
    if (h.id) return
    h.id = h.textContent.trim().toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
  })
}

// 从渲染后的标题（h2 章 / h3 节）提取嵌套树结构
function extractChapterTree(root) {
  const chapters = []
  let current = null
  root.querySelectorAll('h2, h3').forEach(h => {
    if (h.tagName === 'H2') {
      current = { title: h.textContent.trim(), id: h.id, children: [] }
      chapters.push(current)
    } else if (current) {
      current.children.push({ title: h.textContent.trim(), id: h.id, children: [] })
    }
  })
  return chapters
}

// 示例文件的友好显示名（树节点用）
const EXAMPLE_LABELS = {
  'example-checkin.ts': '每日签到',
  'faucet-example.ts': '领水水龙头',
  'mint-example.ts': '铸币 Mint',
}

let scrollSpy = null

// 滚动联动：正文滚到哪个标题，树里对应条目自动高亮并滚动到树的可视区内（目录跟随内容）
function attachScrollSpy(side, content) {
  scrollSpy?.disconnect()
  const headings = [...content.querySelectorAll('.doc-md h2, .doc-md h3')]
  if (headings.length === 0 || !('IntersectionObserver' in window)) return
  scrollSpy = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue
      side.querySelectorAll('.doc-toc-item').forEach(x => x.classList.remove('on'))
      const item = side.querySelector(`[data-target="${en.target.id}"]`)
      if (item) {
        item.classList.add('on')
        item.scrollIntoView({ block: 'nearest' })
      }
    }
  }, { rootMargin: '-10% 0px -75% 0px' })
  headings.forEach(h => scrollSpy.observe(h))
}

function detachScrollSpy() {
  scrollSpy?.disconnect()
  scrollSpy = null
}

// 渲染整棵左侧目录树（手册章节 + 任务示例文件），支持展开/收起与点击跳转
function buildDocTree(side, content, chapters, examples) {
  const scrollToId = (id) => {
    side.querySelectorAll('.doc-toc-item').forEach(x => x.classList.remove('on'))
    side.querySelector(`[data-target="${id}"]`)?.classList.add('on')
    const target = document.getElementById(id)
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // 渲染手册正文（markdown 缓存于 guideMarkdown，切回时重新渲染以恢复标题 id/折叠块/滚动联动）
  const renderGuide = async () => {
    content.innerHTML = `<div class="doc-md">${renderMarkdown(guideMarkdown)}</div>`
    injectHeadingIds(content)
    makeCodeBlocksCollapsible(content)
    content.dataset.view = 'guide'
    attachScrollSpy(side, content)
  }
  const node = (title, id, children, depth) => `
    <div class="doc-tree-node" data-depth="${depth}">
      <div class="doc-toc-item" data-target="${id}">
        ${children.length > 0 ? '<span class="doc-tree-arrow">▾</span>' : '<span class="doc-tree-dot"></span>'}
        <span class="doc-tree-label">${title}</span>
      </div>
      <div class="doc-tree-children">${children.map(c => node(c.title, c.id, c.children, depth + 1)).join('')}</div>
    </div>`
  const treeHtml = chapters.map(c => node(c.title, c.id, c.children, 0)).join('')
    + node('▣ 任务示例', '__examples__', examples.map(f => ({ title: EXAMPLE_LABELS[f.name] ?? f.label, id: `__src_${f.name}`, children: [] })), 0)
  side.innerHTML = `<div class="doc-tree">${treeHtml}</div>`

  // 点击叶子/章节标题：跳转正文；任务示例文件切换到源码视图
  side.querySelectorAll('.doc-toc-item').forEach(el => el.addEventListener('click', async () => {
    const id = el.dataset.target
    if (id === '__examples__') {
      detachScrollSpy()
      const list = await get('/api/docs/examples')
      content.innerHTML = `<h2 style="margin-bottom:10px">任务示例</h2><div class="doc-md"><p>左侧选择示例文件查看带注释的完整源码。示例与 <code>docs/API-GUIDE.md</code> 配合阅读。</p><ul>${list.map(f => `<li><code>${f.name}</code></li>`).join('')}</ul></div>`
      content.dataset.view = 'examples'
      window.scrollTo({ top: 0 })
      scrollToId(id)
      return
    }
    if (id.startsWith('__src_')) {
      detachScrollSpy()
      const name = id.slice('__src_'.length)
      const r = await get('/api/docs/examples/' + name)
      content.innerHTML = `<h2 style="margin-bottom:10px">${name}</h2><div class="doc-md">${renderSource(r.content)}</div>`
      content.dataset.view = 'source'
      window.scrollTo({ top: 0 })
      scrollToId(id)
      return
    }
    // 手册章节：当前不是手册视图时先还原手册正文（否则目标标题不存在、点了没反应）
    if (content.dataset.view !== 'guide') await renderGuide()
    scrollToId(id)
  }))

  // 章节的展开/收起（箭头点击只折叠，不跳转）
  side.querySelectorAll('.doc-tree-arrow').forEach(arrow => arrow.addEventListener('click', (e) => {
    e.stopPropagation()
    const children = arrow.closest('.doc-tree-node').querySelector(':scope > .doc-tree-children')
    const collapsed = children.style.display === 'none'
    children.style.display = collapsed ? '' : 'none'
    arrow.textContent = collapsed ? '▾' : '▸'
  }))
}

// 源码视图：逐行带行号渲染（HTML 转义后展示）
function renderSource(content) {
  const lines = content.split('\n')
  return '<div class="code-view">' + lines.map((l, i) =>
    `<div class="code-line"><span class="code-num">${i + 1}</span><span class="code-text">${l.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])) || ' '}</span></div>`
  ).join('') + '</div>'
}

// 手册 markdown 原文缓存（切到示例/源码视图后再点章节时，用于重新渲染手册正文）
let guideMarkdown = ''

// 渲染文档页：整个左侧是树形目录（手册章节树 + 任务示例文件），右侧为内容区
export async function render() {
  const side = document.querySelector('#doc-side')
  const content = document.querySelector('#doc-content')
  const examples = await get('/api/docs/examples')
  const r = await get('/api/docs/guide')
  await ensureMarked()
  guideMarkdown = r.content
  content.innerHTML = `<div class="doc-md">${renderMarkdown(guideMarkdown)}</div>`
  injectHeadingIds(content)
  makeCodeBlocksCollapsible(content)
  content.dataset.view = 'guide'
  buildDocTree(side, content, extractChapterTree(content), examples)
  attachScrollSpy(side, content)
}
