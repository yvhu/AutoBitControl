# 批次卡结束时间/总耗时/重试中计数实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 批次卡片显示结束时间与总耗时，状态分布拆分「重试中」计数。

**Architecture:** 只读聚合层（db.ts）拆分 retry_wait 计数并新增 MAX(finished_at)，前端 schema 手补字段 + batchTiming 纯函数 + 卡片展示。零执行链路改动。

**Tech Stack:** TS 严格模式、libsql、React 18 + antd 5、vitest。

**Spec:** `docs/superpowers/specs/2026-09-04-run-batches-card-timing-design.md`

## Global Constraints

- 无分号、单引号、2 空格缩进、TS 严格模式；注释/日志/commit 中文
- 验证：`npm run typecheck` + `npm test` + `npm run test:web` 全过
- 测试不连真库（file::memory: / 纯函数单测）
- commit conventional 中文

---

### Task 1: 数据层聚合拆分 + 前端展示

**Files:**
- Modify: `src/infrastructure/db.ts`
- Modify: `web/src/api/schema.d.ts`
- Modify: `web/src/pages/dashboard/groupBatches.ts`
- Modify: `web/src/pages/dashboard/index.tsx`
- Test: `tests/db.test.ts`、`web/src/pages/dashboard/groupBatches.test.ts`

**Interfaces:**
- Produces:
  - `BatchStats` 增加 `retryWait: number`
  - `listBatchesForRange` 返回项增加 `lastFinishedAt: string | null`
  - `batchTiming(batch: BatchItem): { finished: boolean; durationSec: number | null }`

- [ ] **Step 1: 写失败测试**

tests/db.test.ts 的「listBatchesForRange 按时间倒序返回批次并聚合状态统计」用例中，给 b1 批次补一条 retry_wait 行并扩展断言：

```ts
    await db.upsertRun(p2.id, 't1', '2026-09-04', 1, 'retry_wait', { batchId: b1.id, finishedAt: '2026-09-04 08:05:00.000' })
    const list = await db.listBatchesForRange('2026-09-04', '2026-09-04')
    expect(list.map((b) => b.id)).toEqual([b2.id, b1.id])
    expect(list[1].stats.total).toBe(3)
    expect(list[1].stats.success).toBe(1)
    expect(list[1].stats.failed).toBe(1)
    expect(list[1].stats.retryWait).toBe(1)
    expect(list[1].stats.running).toBe(0)
    expect(list[1].lastFinishedAt).toBe('2026-09-04 08:05:00.000')
```

另加一个无行批次用例：

```ts
  it('无行的批次 lastFinishedAt 为 null', async () => {
    await db.createBatch('bulk', 't9', 'trigger-all', '2026-09-04 10:00:00.000')
    const list = await db.listBatchesForRange('2026-09-04', '2026-09-04')
    expect(list[0].lastFinishedAt).toBeNull()
    expect(list[0].stats.total).toBe(0)
  })
```

web/src/pages/dashboard/groupBatches.test.ts 加：

```ts
import { splitBatches, batchProgress, batchTiming } from './groupBatches'

describe('batchTiming 批次时间信息', () => {
  it('终态批次：finished=true 且耗时为 lastFinishedAt - createdAt', () => {
    const t = batchTiming(makeBatch({ createdAt: '2026-09-04 09:00:00.000', lastFinishedAt: '2026-09-04 09:26:10.000', stats: { total: 50, success: 43, failed: 3, captchaFailed: 2, skipped: 2, running: 0, pending: 0, retryWait: 0 } }))
    expect(t.finished).toBe(true)
    expect(t.durationSec).toBe(1570)
  })

  it('进行中/重试中/待执行批次：finished=false 且 durationSec=null', () => {
    for (const stats of [
      { total: 50, success: 10, failed: 0, captchaFailed: 0, skipped: 0, running: 3, pending: 37, retryWait: 0 },
      { total: 50, success: 10, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 5 },
    ]) {
      const t = batchTiming(makeBatch({ createdAt: '2026-09-04 09:00:00.000', lastFinishedAt: '2026-09-04 09:26:10.000', stats }))
      expect(t.finished).toBe(false)
      expect(t.durationSec).toBeNull()
    }
  })

  it('终态但缺 lastFinishedAt：durationSec=null', () => {
    const t = batchTiming(makeBatch({ createdAt: '2026-09-04 09:00:00.000', lastFinishedAt: null, stats: { total: 1, success: 1, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 } }))
    expect(t.finished).toBe(true)
    expect(t.durationSec).toBeNull()
  })
})
```

makeBatch 夹具（groupBatches.test.ts 已有）需补默认 `lastFinishedAt: null` 与 stats 默认加 `retryWait: 0`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/db.test.ts -t "批次"`
Run: `npm run test:web -- groupBatches`
Expected: FAIL（retryWait/lastFinishedAt 不存在；batchTiming 未导出）

- [ ] **Step 3: 实现 db.ts**

`BatchStats` 接口加 `retryWait: number`（在 `running: number` 后）。

`listBatchesForRange` SQL：

```sql
SELECT b.id, b.kind, b.task_key AS taskKey, b.source, b.created_at AS createdAt,
       r.status, COUNT(r.id) AS c, MAX(r.finished_at) AS lastFinishedAt
FROM batches b LEFT JOIN runs r ON r.batch_id = b.id
WHERE date(b.created_at) >= COALESCE(date(?), '0000-01-01') AND date(b.created_at) <= date(?)
GROUP BY b.id, r.status
ORDER BY b.created_at DESC, b.id DESC
```

组装循环改：

```ts
    const list: Array<BatchRow & { stats: BatchStats; lastFinishedAt: string | null }> = []
    const byId = new Map<number, BatchRow & { stats: BatchStats; lastFinishedAt: string | null }>()
    for (const r of rows) {
      const id = Number(r.id)
      let item = byId.get(id)
      if (!item) {
        item = {
          id,
          kind: String(r.kind) as 'bulk' | 'single',
          taskKey: String(r.taskKey),
          source: String(r.source),
          createdAt: String(r.createdAt),
          lastFinishedAt: r.lastFinishedAt === null || r.lastFinishedAt === undefined ? null : String(r.lastFinishedAt),
          stats: { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0, retryWait: 0 },
        }
        byId.set(id, item)
        list.push(item)
      }
      const n = Number(r.c)
      item.stats.total += n
      const s = String(r.status) as RunStatus
      if (s === 'success') item.stats.success += n
      else if (s === 'failed') item.stats.failed += n
      else if (s === 'captcha_failed') item.stats.captchaFailed += n
      else if (s === 'skipped') item.stats.skipped += n
      else if (s === 'running') item.stats.running += n
      else if (s === 'retry_wait') item.stats.retryWait += n
      else if (s === 'pending') item.stats.pending += n
    }
    return list
```

注意：多状态分组下每个分组的 lastFinishedAt 是该组的 MAX，不是全批次的 MAX——同批多组会取到各组 MAX 中最大者即全局 MAX 吗？不会自动合并。**修正**：组装时不逐组覆盖，而是在 item 创建后对该批的所有分组行做合并取最大值。稳妥做法：JS 侧记录 per-batch max：

```ts
      // lastFinishedAt：同批多状态分组的 MAX 取全局最大值（分组聚合不会跨组合并）
      const v = r.lastFinishedAt === null || r.lastFinishedAt === undefined ? null : String(r.lastFinishedAt)
      if (v && (item.lastFinishedAt === null || v > item.lastFinishedAt)) item.lastFinishedAt = v
```

（字典序比较与 wall-clock 固定宽度格式兼容。）

函数返回类型签名：`Promise<Array<BatchRow & { stats: BatchStats; lastFinishedAt: string | null }>>`。

文件头 BatchStats 注释补一句 retryWait 语义。

- [ ] **Step 4: 实现前端**

schema.d.ts 批次项 stats 加：

```ts
                                    running?: number;
                                    retryWait?: number;
                                    pending?: number;
```

批次项加（stats 同层）：

```ts
                                lastFinishedAt?: string | null;
```

groupBatches.ts 加：

```ts
/** 批次时间信息：finished = 无任何在途（running/pending/retryWait 全 0）；耗时 = lastFinishedAt - createdAt（秒取整，任一缺失返回 null） */
export function batchTiming(batch: BatchItem): { finished: boolean; durationSec: number | null } {
  const s = batch.stats
  const finished = s.running === 0 && s.pending === 0 && s.retryWait === 0
  if (!finished || !batch.lastFinishedAt) return { finished, durationSec: null }
  const end = new Date(batch.lastFinishedAt.replace(' ', 'T')).getTime()
  const start = new Date(batch.createdAt.replace(' ', 'T')).getTime()
  const sec = Math.round((end - start) / 1000)
  return { finished, durationSec: Number.isFinite(sec) ? sec : null }
}
```

index.tsx：
- import 加 `batchTiming`
- STATUS_TAG 数组在 pending 前加 `{ key: 'retryWait', label: '重试中', color: '#fa8c16', bg: '#fff7e6', border: '#ffd591' }`
- BatchCard 内：

```tsx
  const timing = batchTiming(batch)
```

标题行右侧 span 改为：

```tsx
        <span style={{ marginLeft: 'auto', color: '#999', fontSize: 12 }}>
          {timing.finished && timing.durationSec != null
            ? `${batch.lastFinishedAt!.slice(11, 16)} 结束 · 耗时 ${formatDuration(timing.durationSec)}`
            : '进行中'}
        </span>
```

注意：标题行已有「▼ 收起/▶ 展开」文案（marginLeft:auto 处），把该文案并入或改布局——检查现状后把收起/展开文案保留在任务名旁，右侧显示时间信息。具体：原 `<span style={{ color: '#999', fontSize: 12 }}>{open ? '▼ 收起' : '▶ 展开窗口明细'}</span>` 移到任务名后（去掉 auto margin），时间信息 span 加 `marginLeft: 'auto'`。

- [ ] **Step 5: 验证**

Run: `npm run typecheck`
Run: `npm test`
Run: `npm run test:web`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/infrastructure/db.ts tests/db.test.ts web/src/api/schema.d.ts web/src/pages/dashboard/groupBatches.ts web/src/pages/dashboard/groupBatches.test.ts web/src/pages/dashboard/index.tsx
git commit -m "feat: 批次卡显示结束时间/总耗时与重试中计数"
```
