import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Collapse, Empty, Progress, Segmented, Space, Table, Tag, Typography, theme } from 'antd'
import StatusPill from '../../components/StatusPill'
import type { BatchItem, RunRow } from '../../types'
import { useBatches, useBatchDetail, useTasks, useTriggerTask } from './hooks'
import { formatDuration } from './format'
import { splitBatches, batchProgress, batchTiming } from './groupBatches'

const RANGE_OPTIONS = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '全部', value: 'all' },
]

const STATUS_TAG: Array<{ key: keyof BatchItem['stats']; label: string; color: string; bg: string; border: string }> = [
  { key: 'success', label: '成功', color: '#52c41a', bg: '#f6ffed', border: '#b7eb8f' },
  { key: 'failed', label: '失败', color: '#ff4d4f', bg: '#fff2f0', border: '#ffccc7' },
  { key: 'captchaFailed', label: '验证码', color: '#13c2c2', bg: '#e6fffb', border: '#87e8de' },
  { key: 'running', label: '进行中', color: '#faad14', bg: '#fffbe6', border: '#ffe58f' },
  { key: 'retryWait', label: '重试中', color: '#fa8c16', bg: '#fff7e6', border: '#ffd591' },
  { key: 'pending', label: '待执行', color: '#8c8c8c', bg: '#fafafa', border: '#d9d9d9' },
]

const KIND_TAG: Record<BatchItem['kind'], { label: string; color: string }> = {
  bulk: { label: '批量 · 全部窗口', color: 'blue' },
  single: { label: '单窗口', color: 'default' },
  schedule: { label: '定时', color: 'purple' },
}

function runTime(v: string | null): string {
  return v ? (v.includes('T') ? v.slice(11, 23) : v.slice(11)) : '—'
}

function RunsTable({ runs, loading, taskNames }: { runs: RunRow[]; loading: boolean; taskNames: Record<string, string> }) {
  const trigger = useTriggerTask()
  return (
    <Table<RunRow>
      size="small"
      rowKey={(r) => `${r.id}-${r.taskKey}`}
      pagination={false}
      loading={loading}
      dataSource={runs}
      columns={[
        { title: '窗口', dataIndex: 'profileName', width: 150, render: (n: string, r) => (
          <span>{n}<div style={{ fontSize: 11, color: '#999' }}>{(r.bitbrowserId ?? '').slice(0, 8)}</div></span>
        ) },
        { title: '任务', dataIndex: 'taskKey', width: 130, render: (k: string) => taskNames[k] ?? k },
        { title: '开始', dataIndex: 'startedAt', width: 110, render: runTime },
        { title: '耗时', dataIndex: 'durationSec', width: 80, render: (s: number | null) => formatDuration(s) },
        { title: '状态', dataIndex: 'status', width: 100, render: (s: RunRow['status']) => <StatusPill status={s} /> },
        { title: '错误', dataIndex: 'error', ellipsis: true, render: (e: string | null) => (e ? <Typography.Text type="danger" ellipsis={{ tooltip: e }} style={{ maxWidth: 240 }}>{e}</Typography.Text> : '—') },
        { title: '截图', dataIndex: 'screenshot', width: 80, render: (s: string | null) => (s ? <Button type="link" size="small" onClick={() => window.open(`/api/screenshots?path=${encodeURIComponent(s)}`, '_blank')}>🖼</Button> : '—') },
        { title: '操作', width: 80, render: (_, r) => (
          <Button type="link" size="small" loading={trigger.isPending && trigger.variables?.bitbrowserId === r.bitbrowserId} disabled={!r.bitbrowserId || r.inFlight} onClick={() => { if (r.bitbrowserId) trigger.mutate({ key: r.taskKey, bitbrowserId: r.bitbrowserId }) }}>
            {r.status === 'failed' || r.status === 'captcha_failed' ? '重跑' : '执行'}
          </Button>
        ) },
      ]}
    />
  )
}

function BatchCard({ batch, taskNames, defaultOpen }: { batch: BatchItem; taskNames: Record<string, string>; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const detail = useBatchDetail(open ? batch.id : null)
  const { done, pct } = batchProgress(batch)
  const timing = batchTiming(batch)
  const stats = batch.stats
  // 最新批次开始运行时（defaultOpen 由 false→true）自动展开；用户手动收起不受影响
  const prevDefaultOpen = useRef(defaultOpen)
  useEffect(() => {
    if (defaultOpen && !prevDefaultOpen.current) setOpen(true)
    prevDefaultOpen.current = defaultOpen
  }, [defaultOpen])
  return (
    <Card size="small" style={{ marginBottom: 12, border: defaultOpen ? '1px solid #91caff' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <b>{batch.createdAt.slice(11, 16)}</b>
        <Tag color={KIND_TAG[batch.kind].color}>{KIND_TAG[batch.kind].label}</Tag>
        <span style={{ fontWeight: 600 }}>{taskNames[batch.taskKey] ?? batch.taskKey}</span>
        <span style={{ color: '#999', fontSize: 12 }}>{open ? '▼ 收起' : '▶ 展开窗口明细'}</span>
        <span style={{ marginLeft: 'auto', color: '#999', fontSize: 12 }}>
          {timing.finished && timing.durationSec != null
            ? `${batch.lastFinishedAt!.slice(11, 16)} 结束 · 耗时 ${formatDuration(timing.durationSec)}`
            : '进行中'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <Progress percent={pct} size="small" style={{ flex: 1, minWidth: 120, margin: 0 }} format={() => null} />
        <span style={{ fontSize: 12, color: '#666' }}>{done}/{stats.total}</span>
        {STATUS_TAG.filter((t) => stats[t.key] > 0).map((t) => (
          <Tag key={t.key} style={{ color: t.color, background: t.bg, borderColor: t.border, margin: 0 }}>{t.label} {stats[t.key]}</Tag>
        ))}
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          {detail.data
            ? <RunsTable runs={detail.data.runs} loading={false} taskNames={taskNames} />
            : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detail.isPending ? '加载中…' : '暂无运行记录'} />}
        </div>
      )}
    </Card>
  )
}

function SingleBatchRow({ batch, taskNames }: { batch: BatchItem; taskNames: Record<string, string> }) {
  const detail = useBatchDetail(batch.id)
  const trigger = useTriggerTask()
  return (
    <Table<RunRow>
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={detail.data?.runs ?? []}
      loading={detail.isPending}
      locale={{ emptyText: detail.isPending ? '加载中…' : '暂无记录' }}
      columns={[
        { title: '时间', width: 80, render: () => batch.createdAt.slice(11, 16) },
        { title: '任务', width: 120, render: () => taskNames[batch.taskKey] ?? batch.taskKey },
        { title: '窗口', dataIndex: 'profileName', width: 130, render: (n: string, r) => (
          <span>{n}<div style={{ fontSize: 11, color: '#999' }}>{(r.bitbrowserId ?? '').slice(0, 8)}</div></span>
        ) },
        { title: '状态', dataIndex: 'status', width: 100, render: (s: RunRow['status']) => <StatusPill status={s} /> },
        { title: '错误', dataIndex: 'error', ellipsis: true, render: (e: string | null) => (e ? <Typography.Text type="danger" ellipsis={{ tooltip: e }} style={{ maxWidth: 220 }}>{e}</Typography.Text> : '—') },
        { title: '操作', width: 80, render: (_, r) => (
          <Button type="link" size="small" loading={trigger.isPending && trigger.variables?.bitbrowserId === r.bitbrowserId} disabled={!r.bitbrowserId || r.inFlight} onClick={() => { if (r.bitbrowserId) trigger.mutate({ key: batch.taskKey, bitbrowserId: r.bitbrowserId }) }}>
            {r.status === 'failed' || r.status === 'captcha_failed' ? '重跑' : '执行'}
          </Button>
        ) },
      ]}
    />
  )
}

export default function DashboardPage() {
  const { token } = theme.useToken()
  const [range, setRange] = useState('today')
  const batches = useBatches(range)
  const tasks = useTasks()

  const taskNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const t of tasks.data ?? []) map[t.key] = t.name
    return map
  }, [tasks.data])

  const { bulk, single } = useMemo(() => splitBatches(batches.data?.batches ?? []), [batches.data])
  const data = batches.data
  const costYuan = ((data?.captchaToday.totalCost ?? 0) / 1000).toFixed(2)
  const unbatched = data?.unbatched ?? []

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card size="small">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>运行批次</span>
          <Segmented value={range} onChange={(v) => setRange(String(v))} options={RANGE_OPTIONS} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, color: token.colorTextSecondary, fontSize: 13 }}>
            <span>⚡ 实时运行 <b style={{ color: '#faad14' }}>{data?.running ?? 0}</b></span>
            <span>💴 今日打码 <b>¥{costYuan}</b><span style={{ fontSize: 11 }}> / {data?.captchaToday.count ?? 0} 次</span></span>
          </div>
        </div>
      </Card>

      {bulk.length === 0 && single.length === 0 && unbatched.length === 0 ? (
        <Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行批次" /></Card>
      ) : (
        bulk.map((b, i) => <BatchCard key={b.id} batch={b} taskNames={taskNames} defaultOpen={i === 0 && !!data?.running} />)
      )}

      {(single.length > 0 || unbatched.length > 0) && (
        <Card size="small" style={{ borderStyle: 'dashed' }}>
          <Collapse
            ghost
            size="small"
            items={[
              ...(single.length > 0 ? [{
                key: 'single',
                label: <span style={{ color: token.colorTextSecondary }}>📦 单窗口散批 ×{single.length}</span>,
                children: single.map((b) => <SingleBatchRow key={b.id} batch={b} taskNames={taskNames} />),
              }] : []),
              ...(unbatched.length > 0 ? [{
                key: 'unbatched',
                label: <span style={{ color: token.colorTextSecondary }}>🗂 未分批历史 ×{unbatched.length}</span>,
                children: <RunsTable runs={unbatched} loading={false} taskNames={taskNames} />,
              }] : []),
            ]}
          />
        </Card>
      )}
    </Space>
  )
}
