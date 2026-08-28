import { get } from './api.js'
import * as dashboard from './views/dashboard.js'
import * as profiles from './views/profiles.js'
import * as tasks from './views/tasks.js'
import * as settings from './views/settings.js'

const state = { date: localToday(), tasks: [] }
const TITLES = {
  dashboard: ['看板', '今日运行总览'],
  profiles: ['窗口', '窗口管理与详情'],
  tasks: ['任务', '任务定义与手动触发'],
  settings: ['设置', '运行参数（只读）'],
  docs: ['文档', 'API 手册与任务示例'],
}

function localToday() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` }

window.abcRerun = (profileId, taskKey) => { dashboard.rerunFailed(state.date).then(() => navigate('dashboard')) }
window.abcToggle = (id, enabled) => profiles.toggle(id, enabled)
window.abcRunProfile = (id) => profiles.runProfile(id)
window.abcDrawer = (id) => profiles.openDrawer(id)
window.abcPassword = (id) => profiles.setPassword(id)
window.abcResetBreaker = (id) => profiles.resetBreaker(id)
window.abcTriggerTask = (key) => tasks.triggerTask(key).then(() => navigate('tasks'))
window.abcRerunFailed = () => dashboard.rerunFailed(state.date).then(() => navigate('dashboard'))
window.abcTriggerAll = () => dashboard.triggerAll().then(() => navigate('dashboard'))
window.abcTestBitbrowser = () => settings.testBitbrowser()
window.abcBalance = () => settings.loadBalance()

export async function navigate(page) {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.page === page))
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('on', x.id === 'page-' + page))
  document.querySelector('#page-title').textContent = TITLES[page][0]
  document.querySelector('#crumb').textContent = TITLES[page][1]
  try {
    if (page === 'dashboard') {
      await dashboard.render({ date: state.date, setTasks: (t) => { state.tasks = t; document.querySelector('#filter-task').dataset.tasks = JSON.stringify(t) } })
    } else if (page === 'profiles') await profiles.render()
    else if (page === 'tasks') await tasks.render()
    else if (page === 'settings') { await settings.testBitbrowser(); await settings.loadBalance() }
    else if (page === 'docs') await docsRender()
  } catch (e) {
    console.error('页面渲染失败:', e)
  }
}

async function docsRender() {
  const mod = await import('./views/docs.js')
  await mod.render()
}

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
setInterval(() => navigate('dashboard'), 15000)
