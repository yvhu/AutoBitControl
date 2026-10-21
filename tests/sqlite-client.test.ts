import { describe, it, expect, vi, afterEach } from 'vitest'
import Database from 'libsql'
import { LocalSqliteClient } from '../src/infrastructure/sqlite-client'

let client: LocalSqliteClient | undefined

afterEach(() => {
  client?.close()
  client = undefined
  vi.restoreAllMocks()
})

describe('LocalSqliteClient · 原生内存泄漏回归', () => {
  it('同一 SQL 重复执行只 prepare 一次（避免每次查询新建原生语句）', async () => {
    const prepareSpy = vi.spyOn(Database.prototype, 'prepare')
    client = new LocalSqliteClient('file::memory:')
    await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    for (let i = 0; i < 50; i++) await client.execute({ sql: 'SELECT count(*) AS c FROM t WHERE v = ?', args: ['x'] })
    // 建表 1 次 + 查询 1 次（50 次执行复用同一条语句）
    expect(prepareSpy.mock.calls.filter(([sql]) => String(sql).includes('SELECT count(*)'))).toHaveLength(1)
  })

  it('执行结果与 @libsql/client 对齐：rows / rowsAffected / lastInsertRowid', async () => {
    client = new LocalSqliteClient('file::memory:')
    await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const ins = await client.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: ['a'] })
    expect(ins.rowsAffected).toBe(1)
    expect(ins.lastInsertRowid).toBe(1)
    const upd = await client.execute({ sql: "UPDATE t SET v = 'b' WHERE v = ?", args: ['a'] })
    expect(upd.rowsAffected).toBe(1)
    const rows = await client.execute('SELECT id, v FROM t')
    expect(rows.rows).toEqual([{ id: 1, v: 'b' }])
    expect(rows.rowsAffected).toBe(0)
  })
})

describe('LocalSqliteClient · 事务', () => {
  it('提交后可见，回滚后不可见，重复回滚幂等', async () => {
    client = new LocalSqliteClient('file::memory:')
    await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')

    const tx = await client.transaction('write')
    await tx.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: ['kept'] })
    await tx.commit()

    const rollbackTx = await client.transaction('write')
    await rollbackTx.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: ['dropped'] })
    await rollbackTx.rollback()
    await rollbackTx.rollback()

    const rows = await client.execute('SELECT v FROM t')
    expect(rows.rows).toEqual([{ v: 'kept' }])
  })

  it('事务期间发起的普通查询排队到事务结束后，不会混入事务', async () => {
    client = new LocalSqliteClient('file::memory:')
    await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')

    const tx = await client.transaction('write')
    await tx.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: ['pending'] })
    // 事务未结束前调用：应等锁，回滚后才执行，因此读不到未提交行
    const queuedRead = client.execute('SELECT count(*) AS c FROM t')
    await tx.rollback()
    const rows = await queuedRead
    expect(rows.rows).toEqual([{ c: 0 }])
  })

  it('事务对象 close 时未提交则回滚并释放锁', async () => {
    client = new LocalSqliteClient('file::memory:')
    await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')

    const tx = await client.transaction('write')
    await tx.execute({ sql: 'INSERT INTO t (v) VALUES (?)', args: ['x'] })
    tx.close()

    const rows = await client.execute('SELECT count(*) AS c FROM t')
    expect(rows.rows).toEqual([{ c: 0 }])
  })
})
