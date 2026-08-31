import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// 与后端共用项目根 config/.env：WEB_PORT 决定 /api 代理目标，VITE_PORT 决定前端 dev 端口（默认 5173）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../config', '')
  const target = `http://127.0.0.1:${env.WEB_PORT || '3000'}`
  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      proxy: {
        '/api': { target, changeOrigin: true },
        '/api-docs': { target, changeOrigin: true },
        '/screenshots': { target, changeOrigin: true },
      },
    },
    build: { outDir: 'dist' },
  }
})
