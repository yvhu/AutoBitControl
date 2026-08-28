// 设置视图：比特浏览器连接测试与打码余额展示
import { get, post } from '../api.js'
import { loadSettings } from '../settings-store.js'

// 渲染运行参数信息（来自后端公开配置，无硬编码）
export async function renderSettingsInfo() {
  const s = await loadSettings()
  document.querySelector('#set-bb-url').textContent = s.bitbrowserApiBase
  document.querySelector('#set-exec').textContent = `并发 ${s.concurrency} · 探活 ${s.probeUrl} · 时区 ${s.timezone}`
}

// 测试比特浏览器连接（同时刷新设置页状态行与顶栏全局芯片）
export async function testBitbrowser() {
  const data = await post('/api/bitbrowser/test', {})
  document.querySelector('#set-bb-dot').className = 'dot ' + (data.ok ? 'ok' : 'err')
  document.querySelector('#set-bb-text').textContent = data.ok ? '已连接' : '连接失败'
  document.querySelector('#chip-bitbrowser').innerHTML = `<span class="dot ${data.ok ? 'ok' : 'err'}"></span>比特浏览器${data.ok ? '已连接' : '未连接'}`
}

// 加载打码余额（同时刷新设置页与顶栏全局芯片）
export async function loadBalance() {
  const data = await get('/api/captcha/balance')
  document.querySelector('#set-balance').textContent = data.configured ? `${data.points.toLocaleString()} 点（¥${data.yuan}）` : '未配置 Key'
  document.querySelector('#chip-balance').innerHTML = `<span class="dot ${data.configured ? 'ok' : 'err'}"></span>yescaptcha ${data.configured ? `${(data.points / 1000).toFixed(2)} 元` : '未配置'}`
}
