// 面板主模块：路由导航、全局状态、页面视图调度与事件绑定（入口文件）
import { get, post } from './api.js'
import { loadSettings } from './settings-store.js'
import * as dashboard from './views/dashboard.js'
import * as profiles from './views/profiles.js'
import * as tasks from './views/tasks.js'
import * as settings from './views/settings.js'

// 全局状态：当前查看日期与任务列表（供筛选下拉与行级重跑使用）
const state = { date: localToday(), tasks: [] }
let currentPage = 'dashboard'
// 各页面的标题与面包屑文案
const TITLES = {
  dashboard: ['看板', '今日运行总览'],
  profiles: ['窗口', '窗口管理与详情'],
  tasks: ['任务', '任务定义与手动触发'],
  settings: ['设置', '运行参数（只读）'],
  docs: ['文档', 'API 手册与任务示例'],
}

// 本地时区"今天"（与后端 todayStr 口径一致）
function localToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }

// 行级操作：单窗口单任务触发（RESTful 语义，非整日重跑）
// 下面这些 window.abcXxx 供 innerHTML 拼出的 onclick 调用（全局命名空间暴露）
window.abcRerun = async (profileId, taskKey) => {
  const profiles = await get('/api/profiles')
  const p = profiles.find(x => x.id === profileId)
  if (!p) return
  await post(`/api/tasks/${encodeURIComponent(taskKey)}/trigger`, { bitbrowserId: p.bitbrowserId })
  navigate('dashboard')
}
window.abcToggle = (id, enabled) => profiles.toggle(id, enabled)
window.abcRunProfile = (id) => profiles.runProfile(id)
window.abcDrawer = (id) => profiles.openDrawer(id)
window.abcPassword = (id) => profiles.setPassword(id)
window.abcResetBreaker = (id) => profiles.resetBreaker(id)
window.abcTriggerTask = (key) => tasks.triggerTask(key).then(() => navigate('tasks'))
window.abcToggleTask = (key, enabled) => tasks.toggleTask(key, enabled)
window.abcRerunFailed = () => dashboard.rerunFailed(state.date).then(() => navigate('dashboard'))
window.abcTriggerAll = () => dashboard.triggerAll().then(() => navigate('dashboard'))
window.abcTestBitbrowser = () => settings.testBitbrowser()
window.abcBalance = () => settings.loadBalance()

// 页面导航：切导航高亮、切页面显隐、按页面类型渲染对应视图
export async function navigate(page) {
  currentPage = page
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.page === page))
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('on', x.id === 'page-' + page))
  document.querySelector('#page-title').textContent = TITLES[page][0]
  document.querySelector('#crumb').textContent = TITLES[page][1]
  try {
    if (page === 'dashboard') {
      await dashboard.render({ date: state.date, setTasks: (t) => { state.tasks = t; document.querySelector('#filter-task').dataset.tasks = JSON.stringify(t) } })
    } else if (page === 'profiles') await profiles.render()
    else if (page === 'tasks') await tasks.render()
    else if (page === 'settings') { await settings.renderSettingsInfo(); await settings.testBitbrowser(); await settings.loadBalance() }
    else if (page === 'docs') await docsRender()
  } catch (e) {
    console.error('页面渲染失败:', e)
  }
}

// 文档页按需动态加载（marked 依赖体积大，不常看文档则不加载）
async function docsRender() {
  const mod = await import('./views/docs.js')
  await mod.render()
}

// 事件绑定：导航点击 + 看板筛选控件（筛选状态存 dashboard.state）
document.querySelectorAll('.nav-item').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)))
document.querySelector('#seg-filter').addEventListener('click', e => {
  if (!e.target.dataset.f) return
  document.querySelectorAll('#seg-filter span').forEach(x => x.classList.remove('on'))
  e.target.classList.add('on')
  dashboard.state.filter = e.target.dataset.f
  navigate('dashboard')
})
document.querySelector('#filter-task').addEventListener('change', e => { dashboard.state.taskFilter = e.target.value; navigate('dashboard') })
document.querySelector('#filter-profile').addEventListener('input', e => { dashboard.state.profileSearch = e.target.value; navigate('dashboard') })
document.querySelector('#profile-search').addEventListener('input', () => profiles.render())

navigate('dashboard')
// 侧栏版本/时区来自后端公开设置（启动时填一次，失败保持占位符）
loadSettings().then(s => {
  document.querySelector('#side-version').textContent = 'v' + s.version
  document.querySelector('#side-timezone').textContent = s.timezone
}).catch(() => {})
// 顶栏全局状态芯片：启动即刷新（比特浏览器连接状态 + yescaptcha 余额）
settings.testBitbrowser().catch(() => {})
settings.loadBalance().catch(() => {})
// 15 秒轮询：仅当停留在看板页时刷新数据，不劫持其他页面的导航
setInterval(() => {
  if (currentPage === 'dashboard') navigate('dashboard')
}, 15000)
