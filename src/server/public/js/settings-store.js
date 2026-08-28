import { get } from './api.js'

let cache = null

// 拉取后端公开配置（只含非敏感项），全面板共享一份
export async function loadSettings() {
  if (!cache) {
    cache = get('/api/settings').catch((e) => {
      cache = null
      throw e
    })
  }
  return cache
}
