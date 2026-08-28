// 看板视图：统计卡片、状态矩阵与筛选（导出 state 供 app.js 的筛选控件读写）
import { get, post, esc } from '../api.js'

// 筛选状态（app.js 的按钮/下拉/输入框直接改这里再重渲染）
export const state = { filter: 'all', taskFilter: '', profileSearch: '' }

// 状态徽章样式映射：状态 → [样式类, 文案]
const PILLS = {
  success: ['ok', '成功'], failed: ['fail', '失败'], captcha_failed: ['cap', '验证码失败'],
  running: ['run', '执行中'], retry_wait: ['run', '重试中'], skipped: ['skip', '跳过'], pending: ['skip', '待执行'],
}

// 截图新标签页打开（路径经 encodeURIComponent 防注入）
function openImage(path) { window.open('/api/screenshots?path=' + encodeURIComponent(path), '_blank') }

// 渲染看板：拉仪表盘数据 + 任务列表，更新统计卡片与矩阵
export async function render({ date, setTasks }) {
  const data = await get('/api/dashboard?date=' + date)
  if (setTasks) setTasks(await get('/api/tasks'))
  const s = data.stats
  const done = s.success + s.failed + s.captchaFailed + s.skipped
  const pct = s.total ? Math.round(done / s.total * 100) : 0
  document.querySelector('#ring-complete').style.setProperty('--p', pct)
  document.querySelector('#ring-text').textContent = pct + '%'
  document.querySelector('#stat-complete').textContent = `${done} / ${s.total}`
  document.querySelector('#st-ok').textContent = s.success
  document.querySelector('#st-fail').textContent = s.failed
  document.querySelector('#st-cap').textContent = s.captchaFailed
  document.querySelector('#st-skip').textContent = s.skipped
  document.querySelector('#st-running').textContent = s.running
  document.querySelector('#st-profiles').textContent = `窗口 ${data.profilesTotal} / 启用 ${data.profilesEnabled}`
  document.querySelector('#st-capcost').textContent = '¥' + (data.captcha.totalCost / 1000).toFixed(2)
  document.querySelector('#st-capcount').textContent = data.captcha.count + ' 次'
  const total = s.total || 1
  document.querySelector('#bar-dist').innerHTML = `<div style="width:${s.success/total*100}%;background:#34D399"></div><div style="width:${s.failed/total*100}%;background:#F87171"></div><div style="width:${s.captchaFailed/total*100}%;background:#38BDF8"></div><div style="width:${s.skipped/total*100}%;background:#334155"></div>`
  const badge = document.querySelector('#badge-fail')
  badge.textContent = s.failed + s.captchaFailed
  badge.style.display = s.failed + s.captchaFailed > 0 ? '' : 'none'
  const sel = document.querySelector('#filter-task')
  const tasks = sel.dataset.tasks ? JSON.parse(sel.dataset.tasks) : []
  sel.innerHTML = '<option value="">全部任务</option>' + tasks.map(t => `<option value="${t.key}">${esc(t.name)}</option>`).join('')
  renderMatrix(data)
}

// 状态矩阵渲染：按筛选条件过滤运行记录，逐行拼 HTML（所有动态值经 esc 转义）
function renderMatrix(data) {
  const rows = data.runs.filter(r => {
    if (state.filter === 'failed' && !['failed','captcha_failed'].includes(r.status)) return false
    if (state.filter === 'success' && r.status !== 'success') return false
    if (state.filter === 'running' && !['running','retry_wait'].includes(r.status)) return false
    if (state.taskFilter && r.taskKey !== state.taskFilter) return false
    if (state.profileSearch && !r.profileName.includes(state.profileSearch)) return false
    return true
  })
  document.querySelector('#matrix').innerHTML = rows.map(r => {
    const [cls, label] = PILLS[r.status] ?? ['skip', r.status]
    const profile = data.profiles.find(p => p.id === r.profileId)
    const bitId = profile ? String(profile.bitbrowserId).slice(0, 8) : ''
    const num = String(r.profileId).padStart(2, '0')
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar">${num}</div><div><div>${esc(r.profileName)}</div><div style="font-size:10px;color:#64748B">${esc(bitId)}</div></div></div></td>
      <td>${esc(r.taskKey)}</td>
      <td><span class="pill ${cls}"><span class="d"></span>${label}</span></td>
      <td>${r.attempts}</td>
      <td class="err-text" title="${esc(r.error ?? '')}">${esc(r.error ?? '—')}</td>
      <td>${r.screenshot ? `<span class="link" onclick="window.open('/api/screenshots?path=${encodeURIComponent(r.screenshot)}')">🖼 查看</span>` : '—'}</td>
      <td><span class="link" onclick="window.abcRerun(${r.profileId}, '${esc(r.taskKey)}')">${['failed','captcha_failed'].includes(r.status) ? '重跑' : '执行'}</span></td>
    </tr>`
  }).join('')
}

// 触发当前筛选任务（全部启用窗口）
export async function triggerAll() {
  const taskKey = document.querySelector('#filter-task').value
  if (!taskKey) { alert('请先选择一个任务'); return }
  await post(`/api/tasks/${encodeURIComponent(taskKey)}/trigger`, {})
}

// 重跑当日全部失败（failed/captcha_failed）
export async function rerunFailed(date) {
  await post('/api/runs/rerun-failed', { date })
}
