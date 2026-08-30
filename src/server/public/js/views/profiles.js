// 窗口视图：窗口列表渲染 + 详情抽屉（密码设置/熔断重置）+ 行级操作
import { get, post, patch, esc } from '../api.js'
import { loadSettings } from '../settings-store.js'

// 渲染窗口表格（搜索框过滤名字/窗口 ID）
export async function render() {
  const settings = await loadSettings()
  const profiles = await get('/api/profiles')
  const data = await get('/api/dashboard')
  const q = document.querySelector('#profile-search').value.trim()
  document.querySelector('#profile-count').textContent = `${profiles.length} 个窗口 · 启用 ${profiles.filter(p => p.enabled).length}`
  const rows = profiles.filter(p => !q || p.name.includes(q) || p.bitbrowserId.includes(q))
  document.querySelector('#profile-table').innerHTML = rows.map(p => {
    const mine = data.runs.filter(r => r.profileId === p.id)
    const okCount = mine.filter(r => r.status === 'success').length
    const fail = mine.filter(r => ['failed','captcha_failed'].includes(r.status)).length
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="avatar">${String(p.id).padStart(2,'0')}</div><div><div>${esc(p.name)}</div><div style="font-size:10px;color:#64748B">${esc(p.bitbrowserId)}</div></div></div></td>
      <td><span style="color:#34D399">${okCount} ✓</span>${fail ? ` <span style="color:#F87171">${fail} ✗</span>` : ''}</td>
      <td><span style="color:${p.circuitBreakerCount > 0 ? '#FBBF24' : '#64748B'};font-size:11px">${p.circuitBreakerCount}/${settings.circuitBreakerThreshold}</span></td>
      <td><span class="toggle ${p.enabled ? '' : 'off'}" onclick="window.abcToggle(${p.id}, ${p.enabled ? 0 : 1})"></span></td>
      <td><span class="link" onclick="window.abcCopyId('${esc(p.bitbrowserId)}')">复制ID</span> · <span class="link" onclick="window.abcRunProfile(${p.id})">立即跑</span> · <span class="link" onclick="window.abcDrawer(${p.id})">详情</span></td>
    </tr>`
  }).join('')
}

// 打开详情弹窗：今日运行时间线 + 熔断状态
export async function openDrawer(id) {
  const profiles = await get('/api/profiles')
  const data = await get('/api/dashboard')
  const p = profiles.find(x => x.id === id)
  const mine = data.runs.filter(r => r.profileId === id)
  document.querySelector('#profile-drawer').style.display = 'flex'
  document.querySelector('#drawer-title').textContent = `详情 · ${p.name}`
  const PILLS = { success: ['ok', '成功'], failed: ['fail', '失败'], captcha_failed: ['cap', '验证码失败'], running: ['run', '执行中'], retry_wait: ['run', '重试中'], skipped: ['skip', '跳过'], pending: ['skip', '待执行'] }
  document.querySelector('#drawer-body').innerHTML = `
    <div style="border-left:2px solid #1E293B;padding-left:14px;display:flex;flex-direction:column;gap:10px;margin-bottom:12px">
      ${mine.length ? mine.map(r => {
        const [cls] = PILLS[r.status] ?? ['skip']
        const dot = { ok: '#34D399', fail: '#F87171', cap: '#38BDF8', run: '#FBBF24', skip: '#94A3B8' }[cls]
        return `<div style="position:relative;font-size:12px"><span style="position:absolute;left:-19px;top:5px;width:8px;height:8px;border-radius:50%;background:${dot}"></span>${esc(r.taskKey)} <span class="pill ${cls}"><span class="d"></span>${PILLS[r.status][1]}</span>${r.error ? ` · ${esc(r.error)}` : ''}</div>`
      }).join('') : '<div style="color:#64748B">今日暂无任务记录</div>'}
    </div>
    <div style="font-size:12px;color:#94A3B8;display:flex;gap:8px;align-items:center">
      钱包解锁密码：由环境变量 WALLET_PASSWORDS 配置（重启生效）
      <span class="link" style="margin-left:12px" onclick="window.abcResetBreaker(${p.id})">重置熔断</span>
    </div>`
}

// 启用/停用开关（行内 toggle 控件调用）
export async function toggle(id, enabled) { await patch(`/api/profiles/${id}`, { enabled: Boolean(enabled) }); await render() }
// 关闭详情弹窗
export function closeDrawer() { document.querySelector('#profile-drawer').style.display = 'none' }
// 整窗口立即跑全部任务
export async function runProfile(id) { await post(`/api/profiles/${id}/run`, {}); await render() }
// 重置熔断计数
export async function resetBreaker(id) { await post(`/api/profiles/${id}/breaker/reset`, {}); await render() }
// 同步比特浏览器窗口列表到 profiles 表（返回同步数量，调用方 toast 展示）
export async function syncProfiles() { const r = await post('/api/bitbrowser/sync', {}); await render(); return r.count }
