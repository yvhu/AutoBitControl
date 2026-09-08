/**
 * 单实例守卫（infrastructure 层）：锁文件 + PID 存活检测，保证同一数据库文件同时只有一个后端实例
 * 依赖方向：纯 Node 内置模块（fs/process/path），不依赖任何项目层；被 src/app.ts 装配
 * 设计思路：wx 原子创建锁文件（Windows 等价 CREATE_NEW，并发抢锁只有一个成功）→ 写入本进程 PID；
 * 文件已存在则按 PID 存活探测区分：存活 → 抛 SingleInstanceError（快速失败）；
 * 已死 → 判定残留锁（taskkill /F、断电等场景），删除后重试一次接管
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 取锁失败（已有存活实例持有）：携带锁路径与占用者 PID（holderPid 为 null 表示读取失败） */
export class SingleInstanceError extends Error {
  constructor(readonly lockPath: string, readonly holderPid: number | null) {
    super(`另一个实例正在运行（PID: ${holderPid ?? '未知'}，锁文件: ${lockPath}）`)
  }
}

/** 测试注入项：pid 与存活探测默认取真实进程 */
export interface AcquireOptions {
  pid?: number
  probe?: (pid: number) => boolean
}

/** 默认存活探测：kill(pid, 0) —— ESRCH=进程不存在（已死），EPERM 等一律按存活处理 */
function defaultProbe(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** 读取锁文件中的持有者 PID；不存在/内容非法返回 null */
export function readHolderPid(lockPath: string): number | null {
  try {
    const n = parseInt(readFileSync(lockPath, 'utf-8').trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** 由数据库路径推导锁文件路径（同目录 app.lock，相对/绝对原样透传；:memory: 等无目录场景兜底 data/app.lock） */
export function singleInstanceLockPath(dbPath: string): string {
  if (dbPath.startsWith('file:')) dbPath = dbPath.slice('file:'.length)
  if (!dbPath || dbPath === ':memory:') return join('data', 'app.lock')
  return join(dirname(dbPath), 'app.lock')
}

/**
 * 获取单实例锁：成功返回 release 句柄；已有存活实例持有则抛 SingleInstanceError
 * 残留锁（持有者已死）删除后重试一次；重试仍冲突（并发接管竞态）抛错由调用方处理
 */
export function acquireSingleInstanceLock(lockPath: string, opts: AcquireOptions = {}): { release(): void } {
  const myPid = opts.pid ?? process.pid
  const probe = opts.probe ?? defaultProbe
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, String(myPid))
      closeSync(fd)
      return { release: () => releaseLock(lockPath, myPid) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holderPid = readHolderPid(lockPath)
      if (holderPid !== null && probe(holderPid)) {
        throw new SingleInstanceError(lockPath, holderPid)
      }
      // 残留锁：删除后重试一次（删除失败/竞态由下一次循环的 EEXIST 分支收口）
      try {
        unlinkSync(lockPath)
      } catch {
        // 锁已被他人删除，继续重试
      }
    }
  }
  throw new SingleInstanceError(lockPath, null)
}

/** 释放锁：只删「内容为自己 PID」的文件（防误删接管者的新锁）；文件已不存在等异常忽略 */
function releaseLock(lockPath: string, myPid: number): void {
  try {
    if (readHolderPid(lockPath) === myPid) unlinkSync(lockPath)
  } catch {
    // 释放失败忽略：残留锁由下次启动的存活探测接管
  }
}
