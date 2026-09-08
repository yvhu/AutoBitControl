import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireSingleInstanceLock, readHolderPid, singleInstanceLockPath, SingleInstanceError } from '../src/infrastructure/single-instance'

const aliveProbe = () => true
const deadProbe = () => false

describe('single-instance 锁', () => {
  const dirs: string[] = []
  const mk = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'single-instance-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('首次取锁成功，锁文件写入本进程 PID', () => {
    const p = join(mk(), 'app.lock')
    const h = acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('4242')
    h.release()
  })

  it('锁被存活进程持有 → 抛 SingleInstanceError 且带占用 PID', () => {
    const p = join(mk(), 'app.lock')
    writeFileSync(p, '1111')
    expect(() => acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })).toThrow(SingleInstanceError)
    try {
      acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })
    } catch (e) {
      expect(e).toBeInstanceOf(SingleInstanceError)
      expect((e as SingleInstanceError).holderPid).toBe(1111)
      expect((e as SingleInstanceError).lockPath).toBe(p)
    }
    // 持有者文件不被篡改
    expect(readFileSync(p, 'utf-8')).toBe('1111')
  })

  it('死进程残留锁 → 删除接管成功', () => {
    const p = join(mk(), 'app.lock')
    writeFileSync(p, '999999999')
    const h = acquireSingleInstanceLock(p, { pid: 4242, probe: deadProbe })
    expect(readFileSync(p, 'utf-8')).toBe('4242')
    h.release()
  })

  it('release 删除自己的锁文件', () => {
    const p = join(mk(), 'app.lock')
    const h = acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })
    h.release()
    expect(existsSync(p)).toBe(false)
  })

  it('release 不删已被接管的新锁（文件内容不是自己 PID）', () => {
    const p = join(mk(), 'app.lock')
    const h = acquireSingleInstanceLock(p, { pid: 4242, probe: aliveProbe })
    writeFileSync(p, '9999')
    h.release()
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe('9999')
  })

  it('readHolderPid 内容非法或不存在时返回 null', () => {
    const p = join(mk(), 'app.lock')
    expect(readHolderPid(p)).toBeNull()
    writeFileSync(p, 'not-a-number')
    expect(readHolderPid(p)).toBeNull()
  })

  it('singleInstanceLockPath 由 dbPath 推导（file: 前缀剥离、:memory: 兜底）', () => {
    expect(singleInstanceLockPath('data/app.db')).toBe(join('data', 'app.lock'))
    expect(singleInstanceLockPath('file:data/app.db')).toBe(join('data', 'app.lock'))
    expect(singleInstanceLockPath(':memory:')).toBe(join('data', 'app.lock'))
  })
})
