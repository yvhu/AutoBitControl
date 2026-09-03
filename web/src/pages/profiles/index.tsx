import { useMemo, useState } from 'react'
import {
  App,
  Avatar,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Progress,
  Space,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
  theme,
} from 'antd'
import { CopyOutlined, ReloadOutlined, SearchOutlined, SyncOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import dayjs from 'dayjs'
import StatusPill from '../../components/StatusPill'
import type { ProfileRow, RunRow, RunStatus } from '../../types'
import {
  filterProfiles,
  profileSorters,
  useBreakerThreshold,
  useCloseProfile,
  useOpenProfile,
  usePatchProfile,
  useProfiles,
  useResetBreaker,
  useSyncProfiles,
  useTodayDashboard,
} from './hooks'

const TIMELINE_COLOR: Record<RunStatus, string> = {
  success: 'green',
  failed: 'red',
  captcha_failed: 'cyan',
  running: 'gold',
  retry_wait: 'gold',
  skipped: 'gray',
  pending: 'gray',
}

function runTime(r: RunRow): string {
  const t = r.finishedAt ?? r.startedAt
  return t ? dayjs(t).format('HH:mm:ss') : ''
}

export default function ProfilesPage() {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [search, setSearch] = useState('')
  const [detailId, setDetailId] = useState<number | null>(null)

  const profiles = useProfiles()
  const today = useTodayDashboard()
  const thresholdQ = useBreakerThreshold()
  const patch = usePatchProfile()
  const open = useOpenProfile()
  const close = useCloseProfile()
  const reset = useResetBreaker()
  const sync = useSyncProfiles()

  const threshold = thresholdQ.data ?? 0

  const rows = useMemo(() => filterProfiles(profiles.data ?? [], search), [profiles.data, search])

  const runsByProfile = useMemo(() => {
    const map = new Map<number, RunRow[]>()
    for (const r of today.data?.runs ?? []) {
      const list = map.get(r.profileId)
      if (list) list.push(r)
      else map.set(r.profileId, [r])
    }
    return map
  }, [today.data])

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id)
      message.success('已复制窗口ID')
    } catch {
      message.error(`复制失败，请手动复制：${id}`)
    }
  }

  const successOf = (p: ProfileRow) => (runsByProfile.get(p.id) ?? []).filter((r) => r.status === 'success').length

  const columns: ColumnsType<ProfileRow> = [
    {
      title: '窗口',
      key: 'window',
      width: 170,
      sorter: profileSorters.name,
      defaultSortOrder: 'ascend',
      render: (_, p) => (
        <Space size="small">
          <Avatar size="small" style={{ background: 'var(--ant-color-primary, #1677ff)' }}>
            {String(p.id).padStart(2, '0')}
          </Avatar>
          <span>
            {p.name}
            <div style={{ fontSize: 12, color: token.colorTextTertiary }}>
              {(p.bitbrowserId ?? '').slice(0, 8)}
              {p.seq != null && ` · No.${p.seq}`}
            </div>
          </span>
          {p.open && (
            <Tag color="green" style={{ marginInlineStart: 4 }}>
              已打开
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '备注',
      key: 'remark',
      width: 170,
      ellipsis: true,
      render: (_, p) =>
        p.remark ? (
          <Typography.Text title={p.remark} style={{ fontSize: 13 }}>
            {p.remark}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            —
          </Typography.Text>
        ),
    },
    {
      title: 'IP',
      key: 'ip',
      width: 150,
      render: (_, p) =>
        p.lastIp ? (
          <Typography.Text style={{ fontSize: 13 }}>{p.lastIp}</Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            —
          </Typography.Text>
        ),
    },
    {
      title: '国家',
      key: 'country',
      width: 130,
      render: (_, p) =>
        p.lastCountry ? (
          <Typography.Text style={{ fontSize: 13 }}>{p.lastCountry}</Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            —
          </Typography.Text>
        ),
    },
    {
      title: '内核',
      key: 'core',
      width: 110,
      render: (_, p) =>
        p.coreVersion ? (
          <Typography.Text style={{ fontSize: 13, whiteSpace: 'nowrap' }}>Chrome {p.coreVersion}</Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            —
          </Typography.Text>
        ),
    },
    {
      title: '今日结果',
      key: 'today',
      width: 120,
      sorter: profileSorters.success(successOf),
      render: (_, p) => {
        const mine = runsByProfile.get(p.id) ?? []
        const ok = mine.filter((r) => r.status === 'success').length
        const fail = mine.filter((r) => r.status === 'failed' || r.status === 'captcha_failed').length
        return (
          <span>
            <Typography.Text type="success">{ok} ✓</Typography.Text>
            {fail > 0 && (
              <Typography.Text type="danger" style={{ marginLeft: 8 }}>
                {fail} ✗
              </Typography.Text>
            )}
          </span>
        )
      },
    },
    {
      title: '熔断',
      key: 'breaker',
      width: 180,
      sorter: profileSorters.breaker,
      render: (_, p) => {
        const count = p.circuitBreakerCount
        const pct = threshold > 0 ? Math.min(100, Math.round((count / threshold) * 100)) : 0
        return (
          <Space size="small">
            <Tag color={count > 0 ? 'gold' : 'default'}>
              {count}/{threshold > 0 ? threshold : '?'}
            </Tag>
            <Progress
              percent={pct}
              size="small"
              showInfo={false}
              strokeColor={count > 0 ? '#faad14' : undefined}
              style={{ width: 64, margin: 0 }}
            />
          </Space>
        )
      },
    },
    {
      title: '启用',
      key: 'enabled',
      width: 100,
      sorter: profileSorters.enabled,
      render: (_, p) => (
        <Switch
          checked={p.enabled === 1}
          loading={patch.isPending && patch.variables?.id === p.id}
          onChange={(checked) => patch.mutate({ id: p.id, enabled: checked })}
        />
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 300,
      render: (_, p) => {
        const toggling = (open.isPending && open.variables === p.id) || (close.isPending && close.variables === p.id)
        return (
          <Space size="small">
            <Button
              type="link"
              size="small"
              danger={p.open}
              loading={toggling}
              onClick={() => (p.open ? close.mutate(p.id) : open.mutate(p.id))}
            >
              {p.open ? '关闭' : '打开'}
            </Button>
            <Button type="link" size="small" icon={<CopyOutlined />} onClick={() => copyId(p.bitbrowserId)}>
              复制ID
            </Button>
            <Button type="link" size="small" onClick={() => setDetailId(p.id)}>
              详情
            </Button>
          </Space>
        )
      },
    },
  ]

  const detail = detailId != null ? (profiles.data ?? []).find((p) => p.id === detailId) : undefined
  const detailRuns = detail ? (runsByProfile.get(detail.id) ?? []) : []

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card size="small">
        <Space size="middle" wrap>
          <Input
            style={{ width: 240 }}
            placeholder="搜索窗口（名称/ID）"
            prefix={<SearchOutlined />}
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="primary" icon={<SyncOutlined />} loading={sync.isPending} onClick={() => sync.mutate()}>
            同步比特浏览器
          </Button>
          <Typography.Text type="secondary">
            {profiles.data?.length ?? 0} 个窗口 · 启用 {profiles.data?.filter((p) => p.enabled === 1).length ?? 0}
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small">
        <Table<ProfileRow>
          rowKey={(p) => p.id}
          columns={columns}
          dataSource={rows}
          loading={profiles.isPending}
          pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: ['10', '20', '50', '100'], showTotal: (t) => `共 ${t} 个窗口` }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无窗口，点击同步比特浏览器拉取" /> }}
          scroll={{ x: 1200 }}
        />
      </Card>

      <Drawer
        title={detail ? `详情 · ${detail.name}` : '详情'}
        width={480}
        open={detailId != null}
        onClose={() => setDetailId(null)}
      >
        {detail && (
          <Space direction="vertical" size={16} style={{ display: 'flex' }}>
            {detailRuns.length === 0 ? (
              <Typography.Text type="secondary">今日暂无任务记录</Typography.Text>
            ) : (
              <Timeline
                items={detailRuns.map((r) => ({
                  color: TIMELINE_COLOR[r.status] ?? 'gray',
                  children: (
                    <div>
                      <Space size="small" wrap>
                        <Typography.Text strong>{r.taskKey}</Typography.Text>
                        <StatusPill status={r.status} />
                        {runTime(r) && (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {runTime(r)}
                          </Typography.Text>
                        )}
                      </Space>
                      {r.error && (
                        <div style={{ marginTop: 4 }}>
                          <Typography.Text type="danger" style={{ fontSize: 12 }}>
                            {r.error}
                          </Typography.Text>
                        </div>
                      )}
                    </div>
                  ),
                }))}
              />
            )}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                钱包解锁密码：由环境变量 WALLET_PASSWORDS 配置（重启生效）
              </Typography.Text>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={reset.isPending && reset.variables === detail.id}
                onClick={() => reset.mutate(detail.id)}
              >
                重置熔断
              </Button>
            </div>
          </Space>
        )}
      </Drawer>
    </Space>
  )
}
