/**
 * 测试窗口选择弹窗（tasks 页）：多选启用窗口后对选中窗口触发任务
 * 依赖方向：依赖 api/endpoints 与 types；被 tasks/index 引用
 * 设计思路：窗口池与「立即触发」一致（仅启用窗口）；表格展示 + 搜索 + 全选/反选 + 分页；至少选一个才可提交
 */
import { useEffect, useMemo, useState } from 'react'
import { Modal, Input, Button, Space, Spin, Empty, Typography, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useQuery } from '@tanstack/react-query'
import { fetchProfiles } from '../../api/endpoints'
import type { ProfileRow } from '../../types'

/** 只保留启用窗口（与「立即触发」窗口池一致） */
export function enabledProfiles(profiles: ProfileRow[]): ProfileRow[] {
  return profiles.filter((p) => p.enabled === 1)
}

/** 按名称/比特 id 关键词过滤；空白关键词返回原数组 */
export function filterByKeyword(profiles: ProfileRow[], kw: string): ProfileRow[] {
  const q = kw.trim().toLowerCase()
  if (!q) return profiles
  return profiles.filter((p) => p.name.toLowerCase().includes(q) || (p.bitbrowserId ?? '').toLowerCase().includes(q))
}

/** 全选：把 filtered 的比特 id 并入已选（去重、保留原已选在前） */
export function selectAllIds(filtered: ProfileRow[], selected: string[]): string[] {
  const set = new Set(selected)
  for (const p of filtered) set.add(p.bitbrowserId)
  return [...set]
}

/** 反选：filtered 内已选的移除、未选的加入；filtered 外的原已选保留 */
export function invertIds(filtered: ProfileRow[], selected: string[]): string[] {
  const selectedSet = new Set(selected)
  const filteredIds = new Set(filtered.map((p) => p.bitbrowserId))
  const kept = selected.filter((id) => !filteredIds.has(id))
  const added = filtered.filter((p) => !selectedSet.has(p.bitbrowserId)).map((p) => p.bitbrowserId)
  return [...kept, ...added]
}

/** 窗口名称排序比较器（中文按拼音、数字按大小，供表格列 sorter 用） */
export function byName(a: ProfileRow, b: ProfileRow): number {
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
}

const PAGE_SIZE_OPTIONS = [10, 20, 100]

/** 表格列：窗口名称 / 比特窗口ID / 备注 / 打开状态 */
const COLUMNS: ColumnsType<ProfileRow> = [
  { title: '窗口名称', dataIndex: 'name', key: 'name', width: 160, ellipsis: true, sorter: byName, defaultSortOrder: 'ascend' },
  {
    title: '比特窗口ID',
    key: 'bitbrowserId',
    ellipsis: true,
    render: (_: unknown, p: ProfileRow) => (
      <Typography.Text code copyable={{ text: p.bitbrowserId }} style={{ fontSize: 12 }}>
        {p.bitbrowserId}
      </Typography.Text>
    ),
  },
  {
    title: '备注',
    key: 'remark',
    ellipsis: true,
    render: (_: unknown, p: ProfileRow) => p.remark || '—',
  },
  {
    title: '打开状态',
    key: 'open',
    width: 96,
    render: (_: unknown, p: ProfileRow) => (p.open ? <Tag color="green">已打开</Tag> : <Tag>未打开</Tag>),
  },
]

export interface TestWindowModalProps {
  open: boolean
  taskName: string
  submitting: boolean
  onCancel: () => void
  onSubmit: (profileIds: string[]) => void
}

export default function TestWindowModal({ open, taskName, submitting, onCancel, onSubmit }: TestWindowModalProps) {
  const { data, isPending } = useQuery({ queryKey: ['profiles'], queryFn: fetchProfiles, enabled: open })
  const [selected, setSelected] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  // 每次打开重置选择、搜索与分页
  useEffect(() => {
    if (open) {
      setSelected([])
      setKeyword('')
      setPage(1)
      setPageSize(10)
    }
  }, [open])

  const total = useMemo(() => enabledProfiles(data ?? []), [data])
  const filtered = useMemo(() => filterByKeyword(total, keyword), [total, keyword])

  return (
    <Modal
      open={open}
      width={760}
      title={`测试执行：${taskName}`}
      okText="提交执行"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: selected.length === 0 }}
      onOk={() => onSubmit(selected)}
      onCancel={onCancel}
    >
      {isPending ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : total.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无启用窗口" />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Typography.Text type="secondary">
            选择要执行该任务的启用窗口（可多选，等同于只对这些窗口「立即触发」）
          </Typography.Text>
          <Space size="small" wrap>
            <Input
              style={{ width: 220 }}
              placeholder="搜索窗口名称 / ID"
              allowClear
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value)
                setPage(1)
              }}
            />
            <Button size="small" onClick={() => setSelected((s) => selectAllIds(filtered, s))}>
              全选
            </Button>
            <Button size="small" onClick={() => setSelected((s) => invertIds(filtered, s))}>
              反选
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已选 {selected.length} 个窗口
            </Typography.Text>
          </Space>
          <Table<ProfileRow>
            rowKey="bitbrowserId"
            size="small"
            columns={COLUMNS}
            dataSource={filtered}
            scroll={{ y: 360 }}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys as string[]),
              hideSelectAll: true,
            }}
            pagination={{
              current: page,
              pageSize,
              total: filtered.length,
              pageSizeOptions: PAGE_SIZE_OPTIONS,
              showSizeChanger: true,
              size: 'small',
              showTotal: (t) => `共 ${t} 个窗口`,
              onChange: (p, ps) => {
                setPage(p)
                setPageSize(ps)
              },
            }}
            locale={{ emptyText: '无匹配窗口' }}
          />
        </Space>
      )}
    </Modal>
  )
}
