import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Collapse, Empty, Segmented, Space, Table, Tag, Typography, theme } from 'antd'
import StatusPill from '../../components/StatusPill'
import ConfirmButton from '../../components/ConfirmButton'
import type { BatchItem, RunRow } from '../../types'
import { useBatches, useBatchDetail, useTasks, useTriggerTask, useStopBatch, useStopRun, useRerunBatch, batchInFlight, buildTaskInfo, type TaskInfoMap } from './hooks'
import { formatDuration, formatDateTime, formatEta, failureKindLabel } from './format'
import { splitBatches, batchProgress, batchTiming, canRerunFailed, hasRecentActivity, latestOnly, isRunActionable, runActionTarget } from './groupBatches'
import StatsBar from './StatsBar'
import DiagModal from './DiagModal'
import RunArtifactsModal from './RunArtifactsModal'
import RerunFailedModal from './RerunFailedModal'

const RANGE_OPTIONS = [
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '全部', value: 'all' },
]

const KIND_TAG: Record<BatchItem['kind'], { label: string; color: string }> = {
  bulk: { label: '批量 · 全部窗口', color: 'blue' },
  single: { label: '单窗口', color: 'default' },
  schedule: { label: '定时', color: 'purple' },
}

function batchTag(batch: BatchItem): { label: string; color: string } {
  if (batch.source === 'rerun-failed') return { label: '批量 · 重跑失败', color: 'orange' }
  return KIND_TAG[batch.kind]
}

function runTime(v: string | null): string {
  return v ? (v.includes('T') ? v.slice(11, 23) : v.slice(11)) : '—'
}

function TaskName({ info, fallback }: { info: { name: string; groupName: string | null } | undefined; fallback: string }) {
  if (!info) return <>{fallback}</>
  return (
    <span>
      {info.name}
      {info.groupName && <span style={{ color: '#999', fontSize: 11, marginLeft: 4 }}>{info.groupName}</span>}
    </span>
  )
}

function DiagButton({ runId, screenshot }: { runId: number; screenshot: string | null }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="link" size="small" onClick={() => setOpen(true)}>诊断</Button>
      <DiagModal runId={runId} open={open} onClose={() => setOpen(false)} screenshot={screenshot} />
    </>
  )
}

function ScreenshotButton({ runId }: { runId: number }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); setOpen(true) }}>截图</Button>
      <RunArtifactsModal runId={runId} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

function RunActionCell({ run }: { run: RunRow }) {
  const trigger = useTriggerTask()
  const stop = useStopRun()
  const rerun = useRerunBatch()
  if (!isRunActionable(run)) return <Tag>历史轮次 · slot {run.slot}</Tag>
  if (run.inFlight) {
    return (
      <ConfirmButton
        type="link"
        size="small"
        danger
        confirm={{ title: `停止窗口「${run.profileName}」的任务？`, okText: '停止' }}
        loading={stop.isPending && stop.variables === run.id}
        onConfirm={() => stop.mutate(run.id)}
      >
        停止
      </ConfirmButton>
    )
  }
  const failed = run.status === 'failed' || run.status === 'captcha_failed'
  const target = runActionTarget(run)
  const busy = target === 'batch'
    ? rerun.isPending && rerun.variables?.batchId === run.batchId && rerun.variables?.runIds[0] === run.id
    : trigger.isPending && trigger.variables?.bitbrowserId === run.bitbrowserId
  return (
    <Button
      type="link"
      size="small"
      loading={busy}
      disabled={!run.bitbrowserId}
      onClick={() => {
        if (!run.bitbrowserId) return
        if (target === 'batch' && run.batchId != null) rerun.mutate({ batchId: run.batchId, runIds: [run.id] })
        else trigger.mutate({ key: run.taskKey, bitbrowserId: run.bitbrowserId })
      }}
    >
      {failed ? '重跑' : '执行'}
    </Button>
  )
}

function RunsTable({ runs, loading, taskInfo }: { runs: RunRow[]; loading: boolean; taskInfo: TaskInfoMap }) {
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
        { title: '任务', dataIndex: 'taskKey', width: 130, render: (k: string) => <TaskName info={taskInfo[k]} fallback={k} /> },
        { title: '开始', dataIndex: 'startedAt', width: 110, render: runTime },
        {
          title: '预计开始',
          dataIndex: 'notBeforeMs',
          width: 90,
          render: (ms: number | null | undefined, r) =>
            r.status === 'pending' || r.status === 'retry_wait' ? formatEta(ms) : '—',
        },
        { title: '耗时', dataIndex: 'durationSec', width: 80, render: (s: number | null) => formatDuration(s) },
        { title: '状态', dataIndex: 'status', width: 100, render: (s: RunRow['status']) => <StatusPill status={s} /> },
        { title: '失败类型', dataIndex: 'failureKind', width: 100, render: (k: RunRow['failureKind']) => (k ? failureKindLabel(k) : '—') },
        { title: '错误', dataIndex: 'error', ellipsis: true, render: (e: string | null) => (e ? <Typography.Text type="danger" ellipsis={{ tooltip: e }} style={{ maxWidth: 240 }}>{e}</Typography.Text> : '—') },
        { title: '截图', width: 80, render: (_, r) => <ScreenshotButton runId={r.id} /> },
        { title: '操作', width: 130, render: (_, r) => (
          <Space size={0}>
            {r.status === 'failed' && <DiagButton runId={r.id} screenshot={r.screenshot} />}
            <RunActionCell run={r} />
          </Space>
        ) },
      ]}
    />
  )
}

function BatchCard({ batch, taskInfo, defaultOpen }: { batch: BatchItem; taskInfo: TaskInfoMap; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const detail = useBatchDetail(open ? batch.id : null)
  const stop = useStopBatch()
  const [rerunOpen, setRerunOpen] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const { done } = batchProgress(batch)
  const timing = batchTiming(batch)
  const stats = batch.stats
  const failedCount = stats.failed + stats.captchaFailed
  const tag = batchTag(batch)
  const allRuns = detail.data?.runs ?? []
  const latestRuns = latestOnly(allRuns)
  // 最新批次开始运行时（defaultOpen 由 false→true）自动展开；用户手动收起不受影响
  const prevDefaultOpen = useRef(defaultOpen)
  useEffect(() => {
    if (defaultOpen && !prevDefaultOpen.current) setOpen(true)
    prevDefaultOpen.current = defaultOpen
  }, [defaultOpen])
  return (
    <Card size="small" style={{ marginBottom: 12, border: defaultOpen ? '1px solid #91caff' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <b>{formatDateTime(batch.createdAt)}</b>
        {hasRecentActivity(batch) && (
          <span style={{ color: '#999', fontSize: 12 }}>最近活动 {formatDateTime(batch.lastActivityAt)}</span>
        )}
        <Tag color={tag.color}>{tag.label}</Tag>
        <span style={{ fontWeight: 600 }}><TaskName info={taskInfo[batch.taskKey]} fallback={batch.taskKey} /></span>
        <span style={{ color: '#999', fontSize: 12 }}>{open ? '▼ 收起' : '▶ 展开窗口明细'}</span>
        {batchInFlight(batch) && (
          <span onClick={(e) => e.stopPropagation()}>
            <ConfirmButton
              size="small"
              danger
              confirm={{ title: '停止该批次？在途与排队中的窗口都会停止', okText: '停止', mode: 'modal' }}
              loading={stop.isPending && stop.variables === batch.id}
              onConfirm={() => stop.mutate(batch.id)}
            >
              停止
            </ConfirmButton>
          </span>
        )}
        {canRerunFailed(batch) && (
          <span onClick={(e) => e.stopPropagation()}>
            <Button size="small" onClick={() => setRerunOpen(true)}>重跑失败 {failedCount}</Button>
          </span>
        )}
        <span style={{ marginLeft: 'auto', color: '#999', fontSize: 12 }}>
          {batch.stats.total === 0
            ? '已跳过（无待执行窗口）'
            : timing.finished && timing.durationSec != null
              ? `${formatDateTime(batch.lastFinishedAt!)} 结束 · 耗时 ${formatDuration(timing.durationSec)}`
              : '进行中'}
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        <StatsBar stats={stats} right={<span style={{ fontSize: 12, color: '#666' }}>{done}/{stats.total}</span>} />
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          {detail.data ? (
            <>
              {allRuns.length > latestRuns.length && (
                <Button type="link" size="small" onClick={() => setShowHistory(!showHistory)}>
                  {showHistory ? '仅看最新轮次' : `显示历史轮次 ${allRuns.length - latestRuns.length}`}
                </Button>
              )}
              <RunsTable
                runs={showHistory ? allRuns : latestRuns}
                loading={false}
                taskInfo={taskInfo}
              />
            </>
          ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detail.isPending ? '加载中…' : '暂无运行记录'} />}
        </div>
      )}
      <RerunFailedModal batchId={batch.id} open={rerunOpen} onClose={() => setRerunOpen(false)} />
    </Card>
  )
}

function SingleBatchRow({ batch, taskInfo }: { batch: BatchItem; taskInfo: TaskInfoMap }) {
  const detail = useBatchDetail(batch.id)
  const [showHistory, setShowHistory] = useState(false)
  const [rerunOpen, setRerunOpen] = useState(false)
  const allRuns = detail.data?.runs ?? []
  const latestRuns = latestOnly(allRuns)
  const runs = showHistory ? allRuns : latestRuns
  const failedCount = batch.stats.failed + batch.stats.captchaFailed
  return (
    <Space direction="vertical" size={4} style={{ display: 'flex' }}>
      <Space size={8}>
        {canRerunFailed(batch) && (
          <Button size="small" onClick={() => setRerunOpen(true)}>重跑失败 {failedCount}</Button>
        )}
        {allRuns.length > latestRuns.length && (
          <Button type="link" size="small" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? '仅看最新轮次' : `显示历史轮次 ${allRuns.length - latestRuns.length}`}
          </Button>
        )}
      </Space>
      <Table<RunRow>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={runs}
        loading={detail.isPending}
        locale={{ emptyText: detail.isPending ? '加载中…' : '暂无记录' }}
        columns={[
          { title: '时间', width: 130, render: (_, r) => formatDateTime(r.startedAt ?? batch.createdAt) },
          { title: '任务', width: 120, render: () => <TaskName info={taskInfo[batch.taskKey]} fallback={batch.taskKey} /> },
          { title: '窗口', dataIndex: 'profileName', width: 130, render: (n: string, r) => (
            <span>{n}<div style={{ fontSize: 11, color: '#999' }}>{(r.bitbrowserId ?? '').slice(0, 8)}</div></span>
          ) },
          {
            title: '预计开始',
            dataIndex: 'notBeforeMs',
            width: 90,
            render: (ms: number | null | undefined, r) =>
              r.status === 'pending' || r.status === 'retry_wait' ? formatEta(ms) : '—',
          },
          { title: '状态', dataIndex: 'status', width: 100, render: (s: RunRow['status']) => <StatusPill status={s} /> },
          { title: '失败类型', dataIndex: 'failureKind', width: 100, render: (k: RunRow['failureKind']) => (k ? failureKindLabel(k) : '—') },
          { title: '错误', dataIndex: 'error', ellipsis: true, render: (e: string | null) => (e ? <Typography.Text type="danger" ellipsis={{ tooltip: e }} style={{ maxWidth: 220 }}>{e}</Typography.Text> : '—') },
          { title: '截图', width: 80, render: (_, r) => <ScreenshotButton runId={r.id} /> },
          { title: '操作', width: 130, render: (_, r) => (
            <Space size={0}>
              {r.status === 'failed' && <DiagButton runId={r.id} screenshot={r.screenshot} />}
              <RunActionCell run={r} />
            </Space>
          ) },
        ]}
      />
      <RerunFailedModal batchId={batch.id} open={rerunOpen} onClose={() => setRerunOpen(false)} />
    </Space>
  )
}

export default function DashboardPage() {
  const { token } = theme.useToken()
  const [range, setRange] = useState('today')
  const batches = useBatches(range)
  const tasks = useTasks()

  const taskInfo = useMemo(() => buildTaskInfo(tasks.data ?? []), [tasks.data])

  const { bulk, single } = useMemo(() => splitBatches(batches.data?.batches ?? []), [batches.data])
  const data = batches.data
  const unbatched = data?.unbatched ?? []

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card size="small">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>运行批次</span>
          <Segmented value={range} onChange={(v) => setRange(String(v))} options={RANGE_OPTIONS} />
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, color: token.colorTextSecondary, fontSize: 13 }}>
            <span>⚡ 实时运行 <b style={{ color: '#faad14' }}>{data?.running ?? 0}</b></span>
          </div>
        </div>
      </Card>

      {bulk.length === 0 && single.length === 0 && unbatched.length === 0 ? (
        <Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行批次" /></Card>
      ) : (
        bulk.map((b, i) => <BatchCard key={b.id} batch={b} taskInfo={taskInfo} defaultOpen={i === 0 && !!data?.running} />)
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
                children: single.map((b) => <SingleBatchRow key={b.id} batch={b} taskInfo={taskInfo} />),
              }] : []),
              ...(unbatched.length > 0 ? [{
                key: 'unbatched',
                label: <span style={{ color: token.colorTextSecondary }}>🗂 未分批历史 ×{unbatched.length}</span>,
                children: <RunsTable runs={unbatched} loading={false} taskInfo={taskInfo} />,
              }] : []),
            ]}
          />
        </Card>
      )}
    </Space>
  )
}
