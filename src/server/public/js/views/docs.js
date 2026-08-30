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

// 标题锚点：marked 不生成标题 id，渲染后按目录约定补上（小写、去符号、空格转连字符、保留中文）
function injectHeadingIds(root) {
  root.querySelectorAll('h1, h2, h3').forEach(h => {
    if (h.id) return
    h.id = h.textContent.trim().toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
  })
}

// 源码视图：逐行带行号渲染（HTML 转义后展示）
function renderSource(content) {
  const lines = content.split('\n')
  return '<div class="code-view">' + lines.map((l, i) =>
    `<div class="code-line"><span class="code-num">${i + 1}</span><span class="code-text">${l.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])) || ' '}</span></div>`
  ).join('') + '</div>'
}

// 渲染文档页：左侧目录 + 右侧内容（首次进入默认打开手册）
export async function render() {
  const side = document.querySelector('#doc-side')
  const content = document.querySelector('#doc-content')
  side.innerHTML = `
    <div class="doc-tab on" data-doc="guide">📖 使用手册</div>
    <div class="doc-tab" data-doc="examples">🧩 任务示例</div>
    <div class="doc-tab" data-doc="example-checkin.ts" data-kind="source">例：每日签到</div>
    <div class="doc-tab" data-doc="faucet-example.ts" data-kind="source">例：领水水龙头</div>
    <div class="doc-tab" data-doc="mint-example.ts" data-kind="source">例：铸币 Mint</div>
  `
  side.querySelectorAll('.doc-tab').forEach(tab => tab.addEventListener('click', async () => {
    side.querySelectorAll('.doc-tab').forEach(t => t.classList.remove('on'))
    tab.classList.add('on')
    const kind = tab.dataset.kind
    if (kind === 'source') {
      const r = await get('/api/docs/examples/' + tab.dataset.doc)
      content.innerHTML = `<h2 style="margin-bottom:10px">${tab.dataset.doc}</h2><div class="doc-md">${renderSource(r.content)}</div>`
    } else if (tab.dataset.doc === 'examples') {
      const list = await get('/api/docs/examples')
      content.innerHTML = `<h2 style="margin-bottom:10px">任务示例</h2><div class="doc-md"><p>左侧选择示例文件查看带注释的完整源码。示例与 <code>docs/API-GUIDE.md</code> 配合阅读。</p><ul>${list.map(f => `<li><code>${f.name}</code></li>`).join('')}</ul></div>`
    } else {
      const r = await get('/api/docs/guide')
      await ensureMarked()
      content.innerHTML = `<div class="doc-md">${renderMarkdown(r.content)}</div>`
      injectHeadingIds(content)
    }
  }))
  const first = side.querySelector('[data-doc="guide"]')
  first.click()
}
