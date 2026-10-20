/**
 * 并发认领测试 worker：在独立线程打开自己的 AppDb，等主线程发令后与另一线程同时 claim。
 * 依赖方向：tests → infrastructure（仅测试用）。
 * 用 .mjs + tsImport 启动，绕开 worker_threads 不加载 TypeScript 转译钩子的限制。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { tsImport } from 'tsx/esm/api'

const { url, date, nowMs, maxConcurrentWindows, limits, startSignal, timeoutMs = 5000 } = workerData
const { AppDb } = await tsImport('../../src/infrastructure/db.ts', import.meta.url)

let db
try {
  db = await AppDb.open(url)
  const signal = new Int32Array(startSignal)
  parentPort.postMessage({ type: 'ready' })
  // 有界等待：主线程迟迟不发令时返回错误，避免 worker 永久阻塞拖死测试
  if (Atomics.wait(signal, 0, 0, timeoutMs) === 'timed-out') {
    parentPort.postMessage({ type: 'error', message: `等待启动信号超时（${timeoutMs}ms）` })
    process.exitCode = 1
  } else {
    const rows = await db.claimDueRuns({
      date,
      nowMs,
      limits: new Map(limits),
      maxConcurrentWindows,
    })
    parentPort.postMessage({ type: 'result', rows: rows.map((row) => ({ id: row.id, profileId: row.profileId })) })
  }
} catch (e) {
  parentPort.postMessage({ type: 'error', message: (e && e.message) || String(e) })
  process.exitCode = 1
} finally {
  db?.close()
}
