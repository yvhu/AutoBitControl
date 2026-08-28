// 任务视图：任务卡片列表渲染与触发
import { get, post, esc } from '../api.js'

// 钱包图标与分类徽章映射
const WALLET_ICON = { metamask: '<div class="wallet-ico mm">🦊</div>', petra: '<div class="wallet-ico pt">🐍</div>' }
const CATEGORY_BADGE = { checkin: ['签到', '#34D399'], faucet: ['领水', '#38BDF8'], mint: ['铸币', '#FBBF24'], other: ['其他', '#94A3B8'] }

// 渲染任务卡片：名称/key/调度/钱包/重试/验证码/备注/来源页/触发按钮
export async function render() {
  const tasks = await get('/api/tasks')
  document.querySelector('#task-cards').innerHTML = tasks.map(t => {
    const icon = WALLET_ICON[t.wallet] ?? '<div class="wallet-ico" style="background:#33415522">▣</div>'
    const sched = t.schedule === null ? '手动触发' : typeof t.schedule === 'string' ? `cron ${t.schedule}` : `cron ${t.schedule.stagger[0]}-${t.schedule.stagger[1]} 错峰`
    const cat = CATEGORY_BADGE[t.category] ?? ['其他', '#94A3B8']
    return `<div class="task-card" style="${t.deprecated ? 'opacity:.45' : t.enabled === false ? 'opacity:.45' : ''}">
      ${icon}
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px">${esc(t.name)} <span style="color:#64748B;font-weight:400">${esc(t.key)}</span>
          <span class="pill skip" style="margin-left:6px"><span class="d" style="background:${cat[1]}"></span>${cat[0]}</span>
          ${t.deprecated ? '<span class="pill skip" style="margin-left:6px"><span class="d"></span>已失效</span>' : ''}
          ${t.enabled === false ? '<span class="pill skip" style="margin-left:6px"><span class="d"></span>已停用</span>' : ''}
        </div>
        <div class="meta">⏱ ${esc(sched)} · 钱包 ${esc(t.wallet ?? '无')} · 重试 ${t.retry?.max ?? '默认'} 次 · 验证码 ${t.captcha?.auto === false ? '关' : '自动'}${t.lastUpdated ? ` · 更新于 ${esc(t.lastUpdated)}` : ''}</div>
        ${t.note ? `<div class="meta" style="color:#94A3B8">📝 ${esc(t.note)}</div>` : ''}
        ${t.sourceUrl ? `<div class="meta"><span class="link" onclick="window.open('${esc(t.sourceUrl)}')">🔗 来源页</span></div>` : ''}
      </div>
      ${t.enabled ? `<button class="btn primary sm" onclick="window.abcTriggerTask('${esc(t.key)}')">立即触发</button>` : ''}
    </div>`
  }).join('')
}

// 触发单个任务（全部启用窗口）
export async function triggerTask(key) { await post(`/api/tasks/${encodeURIComponent(key)}/trigger`, {}) }
