import { useMemo, useState } from 'react'
import {
  App,
  Avatar,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  Progress,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd'
import { SearchOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import StatusPill from '../../components/StatusPill'
import type { DashboardData, RunRow, TaskMetaView } from '../../types'
import { useDashboard, useTasks, useTriggerTask, useRerunFailed } from './hooks'
import { formatDuration } from './format'
import { groupRuns, latestStats, historyMap } from './groupRuns'

const STATUS_FILTERS: Record<string, (r: RunRow) => boolean> = {
  all: () => true,
  failed: (r) => r.status === 'failed' || r.status === 'captcha_failed',
  success: (r) => r.status === 'success',
  running: (r) => r.status === 'running' || r.status === 'retry_wait',
}

const EMPTY_STATS = { total: 0, success: 0, failed: 0, captchaFailed: 0, skipped: 0, running: 0, pending: 0 }
const EMPTY_CAPTCHA = { count: 0, totalCost: 0 }
const EMPTY_DASHBOARD = { stats: EMPTY_STATS, captcha: EMPTY_CAPTCHA } as DashboardData

function DistributionCard({ data }: { data: DashboardData }) {
  const s = data.stats
  return (
    <Card title="结果分布" size="small">
      <Space size="small" wrap>
        <Tag color="success">成功 {s.success}</Tag>
        <Tag color="error">失败 {s.failed}</Tag>
        <Tag color="cyan">验证码失败 {s.captchaFailed}</Tag>
        <Tag>跳过 {s.skipped}</Tag>
        <Tag color="gold">进行中 {s.running}</Tag>
        <Tag>待执行 {s.pending}</Tag>
      </Space>
    </Card>
  )
}

function CaptchaCard({ data }: { data: DashboardData }) {
  const { token } = theme.useToken()
  const costYuan = (data.captcha.totalCost / 1000).toFixed(2)
  return (
    <Card title="验证码" size="small">
      <Statistic value={costYuan} precision={2} prefix="¥" />
      <div style={{ marginTop: 4, color: token.colorTextSecondary, fontSize: 12 }}>
        今日 {data.captcha.count} 次消费
      </div>
    </Card>
  )
}

function LiveCard({ data }: { data: DashboardData }) {
  const { token } = theme.useToken()
  const s = data.stats
  return (
    <Card title="实时运行" size="small">
      <Statistic value={s.running} />
      <div style={{ marginTop: 4, color: token.colorTextSecondary, fontSize: 12 }}>
        窗口 {data.profilesTotal} / 启用 {data.profilesEnabled}
      </div>
    </Card>
  )
}

function CompleteCard({ data, loading }: { data: DashboardData | undefined; loading: boolean }) {
  const { token } = theme.useToken()
  const s = data?.stats
  const total = s?.total ?? 0
  const done = (s?.success ?? 0) + (s?.failed ?? 0) + (s?.captchaFailed ?? 0) + (s?.skipped ?? 0)
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <Card title="今日完成率" size="small">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Progress type="circle" percent={loading ? 0 : pct} size={64} format={(p) => `${p}%`} />
        <div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{loading ? '—' : `${done} / ${total}`}</div>
          <div style={{ color: token.colorTextSecondary, fontSize: 12 }}>窗口任务完成</div>
        </div>
      </div>
    </Card>
  )
}

export default function DashboardPage() {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [taskFilter, setTaskFilter] = useState<string | undefined>(undefined)
  const [statusFilter, setStatusFilter] = useState('all')
  const [profileSearch, setProfileSearch] = useState('')

  const dateStr = date.format('YYYY-MM-DD')
  const dashboard = useDashboard(dateStr)
  const tasks = useTasks()
  const trigger = useTriggerTask()
  const rerun = useRerunFailed()

  const taskOptions = useMemo(
    () => (tasks.data ?? []).map((t) => ({ value: t.key, label: `${t.name}（${t.key}）` })),
    [tasks.data],
  )
  const taskNameByKey = useMemo(() => {
    const map = new Map<string, TaskMetaView>()
    for (const t of tasks.data ?? []) map.set(t.key, t)
    return map
  }, [tasks.data])

  const groups = useMemo(() => groupRuns(dashboard.data?.runs ?? []), [dashboard.data])
  const historyOf = useMemo(() => historyMap(dashboard.data?.runs ?? []), [dashboard.data])
  // 筛选只作用于最新轮（顶层行）；展开出的历史行不被二次过滤
  const rows = useMemo(
    () =>
      groups
        .filter(
          (g) =>
            STATUS_FILTERS[statusFilter]?.(g.latest) &&
            (!taskFilter || g.latest.taskKey === taskFilter) &&
            (!profileSearch || (g.latest.profileName ?? '').toLowerCase().includes(profileSearch.toLowerCase())),
        )
        .map((g) => g.latest),
    [groups, statusFilter, taskFilter, profileSearch],
  )
  // 统计口径：按每窗口每任务最新一轮计数（与表格行数一致）
  const displayData = useMemo(
    () => (dashboard.data ? { ...dashboard.data, stats: latestStats(dashboard.data.runs) } : dashboard.data),
    [dashboard.data],
  )

  const bitbrowserOf = (profileId: number) =>
    dashboard.data?.profiles.find((p) => p.id === profileId)?.bitbrowserId

  const columns: ColumnsType<RunRow> = [
    {
      title: '窗口',
      dataIndex: 'profileName',
      key: 'window',
      render: (name: string, r) => (
        <Space size="small">
          <Avatar size="small" style={{ background: 'var(--ant-color-primary, #1677ff)' }}>
            {String(r.profileId).padStart(2, '0')}
          </Avatar>
          <span>
            {name}
            <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
              {(bitbrowserOf(r.profileId) ?? '').slice(0, 8)}
            </div>
          </span>
        </Space>
      ),
    },
    {
      title: '任务',
      dataIndex: 'taskKey',
      key: 'task',
      render: (key: string) => taskNameByKey.get(key)?.name ?? key,
    },
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 130,
      render: (v: string | null) => (v ? (v.includes('T') ? v.slice(11, 23) : v) : '—'),
    },
    {
      title: '结束时间',
      dataIndex: 'finishedAt',
      key: 'finishedAt',
      width: 130,
      render: (v: string | null) => (v ? (v.includes('T') ? v.slice(11, 23) : v) : '—'),
    },
    {
      title: '总耗时',
      dataIndex: 'durationSec',
      key: 'durationSec',
      width: 90,
      render: (sec: number | null) => formatDuration(sec),
    },
    { title: '状态', dataIndex: 'status', key: 'status', width: 110, render: (s: RunRow['status']) => <StatusPill status={s} /> },
    { title: '尝试', dataIndex: 'attempts', key: 'attempts', width: 70 },
    {
      title: '轮次',
      key: 'round',
      width: 100,
      render: (_, r) => {
        const n = historyOf.get(r.id)?.length ?? 0
        return n > 0 ? <Tag color="blue">历史 {n} 轮</Tag> : '—'
      },
    },
    {
      title: '错误',
      dataIndex: 'error',
      key: 'error',
      ellipsis: true,
      render: (err: string | null) =>
        err ? (
          <Tooltip title={err}>
            <Typography.Text type="danger" style={{ maxWidth: 260 }} ellipsis={{ tooltip: err }}>
              {err}
            </Typography.Text>
          </Tooltip>
        ) : (
          '—'
        ),
    },
    {
      title: '截图',
      dataIndex: 'screenshot',
      key: 'screenshot',
      width: 90,
      render: (shot: string | null) =>
        shot ? (
          <Button type="link" size="small" onClick={() => window.open(`/api/screenshots?path=${encodeURIComponent(shot)}`, '_blank')}>
            🖼 查看
          </Button>
        ) : (
          '—'
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_, r) => {
        const failed = r.status === 'failed' || r.status === 'captcha_failed'
        const id = bitbrowserOf(r.profileId)
        return (
          <Button
            type="link"
            size="small"
            loading={trigger.isPending}
            disabled={!id}
            onClick={() => {
              if (!id) return
              trigger.mutate({ key: r.taskKey, bitbrowserId: id })
            }}
          >
            {failed ? '重跑' : '执行'}
          </Button>
        )
      },
    },
  ]

  const handleTriggerAll = () => {
    if (!taskFilter) {
      message.warning('请先选择一个任务')
      return
    }
    trigger.mutate({ key: taskFilter })
  }

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <CompleteCard data={displayData} loading={dashboard.isPending} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <DistributionCard data={displayData ?? EMPTY_DASHBOARD} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <CaptchaCard data={dashboard.data ?? EMPTY_DASHBOARD} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <LiveCard data={displayData ?? EMPTY_DASHBOARD} />
        </Col>
      </Row>

      <Card size="small">
        <Space size="middle" wrap>
          <DatePicker value={date} allowClear={false} onChange={(d) => d && setDate(d)} />
          <Select
            style={{ minWidth: 220 }}
            placeholder="全部任务"
            allowClear
            showSearch
            optionFilterProp="label"
            value={taskFilter}
            onChange={setTaskFilter}
            options={taskOptions}
          />
          <Segmented
            value={statusFilter}
            onChange={(v) => setStatusFilter(String(v))}
            options={[
              { label: '全部', value: 'all' },
              { label: '失败', value: 'failed' },
              { label: '成功', value: 'success' },
              { label: '进行中', value: 'running' },
            ]}
          />
          <Input
            style={{ width: 180 }}
            placeholder="搜索窗口"
            prefix={<SearchOutlined />}
            allowClear
            value={profileSearch}
            onChange={(e) => setProfileSearch(e.target.value)}
          />
          <Button icon={<ReloadOutlined />} loading={rerun.isPending} onClick={() => rerun.mutate(dateStr)}>
            重跑今日失败
          </Button>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={trigger.isPending} onClick={handleTriggerAll}>
            全部窗口执行
          </Button>
        </Space>
      </Card>

      <Card size="small">
        <Table<RunRow>
          rowKey={(r) => `${r.id}-${r.taskKey}`}
          columns={columns}
          dataSource={rows}
          loading={dashboard.isPending}
          expandable={{
            rowExpandable: (r) => (historyOf.get(r.id)?.length ?? 0) > 0,
            expandedRowRender: (r) => {
              const hist = historyOf.get(r.id) ?? []
              return (
                <Table<RunRow>
                  size="small"
                  rowKey={(h) => `${h.id}-${h.taskKey}`}
                  pagination={false}
                  dataSource={hist}
                  columns={[
                    { title: '轮次', dataIndex: 'slot', width: 80, render: (s: number) => `#${s}` },
                    { title: '开始时间', dataIndex: 'startedAt', width: 130, render: (v: string | null) => (v ? (v.includes('T') ? v.slice(11, 23) : v) : '—') },
                    { title: '结束时间', dataIndex: 'finishedAt', width: 130, render: (v: string | null) => (v ? (v.includes('T') ? v.slice(11, 23) : v) : '—') },
                    { title: '总耗时', dataIndex: 'durationSec', width: 90, render: (sec: number | null) => formatDuration(sec) },
                    { title: '状态', dataIndex: 'status', width: 110, render: (s: RunRow['status']) => <StatusPill status={s} /> },
                    { title: '错误', dataIndex: 'error', ellipsis: true, render: (err: string | null) => (err ? <Typography.Text type="danger" ellipsis={{ tooltip: err }} style={{ maxWidth: 240 }}>{err}</Typography.Text> : '—') },
                    { title: '截图', dataIndex: 'screenshot', width: 90, render: (shot: string | null) => (shot ? <Button type="link" size="small" onClick={() => window.open(`/api/screenshots?path=${encodeURIComponent(shot)}`, '_blank')}>🖼 查看</Button> : '—') },
                    { title: '操作', width: 100, render: (_, h) => {
                      const failed = h.status === 'failed' || h.status === 'captcha_failed'
                      const id = bitbrowserOf(h.profileId)
                      return <Button type="link" size="small" loading={trigger.isPending} disabled={!id} onClick={() => { if (id) trigger.mutate({ key: h.taskKey, bitbrowserId: id }) }}>{failed ? '重跑' : '执行'}</Button>
                    } },
                  ]}
                />
              )
            },
          }}
          pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'], showTotal: (t) => `共 ${t} 条` }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行记录" /> }}
          scroll={{ x: 900 }}
        />
      </Card>
    </Space>
  )
}
