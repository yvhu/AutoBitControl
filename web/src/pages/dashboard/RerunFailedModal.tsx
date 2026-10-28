/**
 * 批次失败重跑弹窗（dashboard 层）：预览失败窗口最新状态，二次勾选后按 runId 提交
 * 依赖方向：依赖 api/endpoints、types 与 hooks；打开时拉取预览，提交走 useRerunBatch
 */
import { useEffect, useRef, useState } from 'react'
import type { Key, ReactNode } from 'react'
import { Alert, Button, Empty, Modal, Spin, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import StatusPill from '../../components/StatusPill'
import type { RerunBlockedReason, RerunCandidate } from '../../types'
import { formatDateTime } from './format'
import { useRerunCandidates, useRerunBatch } from './hooks'

const BLOCKED_TEXT: Record<RerunBlockedReason, string> = {
  'profile-missing': '窗口不存在',
  'profile-disabled': '窗口已停用',
  'circuit-breaker': '窗口熔断中，请先重置',
  'in-flight': '执行中，暂不可重跑',
}

export interface RerunFailedModalProps {
  batchId: number | null
  open: boolean
  onClose: () => void
}

export default function RerunFailedModal({ batchId, open, onClose }: RerunFailedModalProps) {
  const query = useRerunCandidates(open ? batchId : null)
  const submit = useRerunBatch()
  const [selected, setSelected] = useState<Key[]>([])
  const initializedBatch = useRef<number | null>(null)
  const openedAt = useRef(0)

  useEffect(() => {
    openedAt.current = open ? Date.now() : 0
    initializedBatch.current = null
    setSelected([])
  }, [open, batchId])

  const fresh = open && query.data != null && openedAt.current > 0 && query.dataUpdatedAt >= openedAt.current

  useEffect(() => {
    if (!open || !query.data || openedAt.current <= 0) return
    if (query.dataUpdatedAt < openedAt.current) return
    const data = query.data
    if (initializedBatch.current !== data.batchId) {
      initializedBatch.current = data.batchId
      setSelected(data.candidates.filter((c) => c.selectable && c.defaultSelected).map((c) => c.runId))
      return
    }
    const selectableIds = new Set(data.candidates.filter((c) => c.selectable).map((c) => c.runId))
    setSelected((prev) => {
      const next = prev.filter((key) => selectableIds.has(Number(key)))
      return next.length === prev.length ? prev : next
    })
  }, [open, query.data, query.dataUpdatedAt])

  const candidates = query.data?.candidates ?? []
  const columns: ColumnsType<RerunCandidate> = [
    {
      title: '窗口',
      width: 160,
      render: (_, c) => (
        <span>
          {c.profileName}
          <div style={{ fontSize: 11, color: '#999' }}>{c.bitbrowserId.slice(0, 8)}</div>
        </span>
      ),
    },
    {
      title: '失败状态',
      width: 180,
      render: (_, c) => (
        <span>
          <StatusPill status={c.status} />
          {c.error && <Typography.Text type="danger" ellipsis={{ tooltip: c.error }} style={{ maxWidth: 120, marginLeft: 6 }}>{c.error}</Typography.Text>}
        </span>
      ),
    },
    {
      title: '今天最新一轮',
      width: 190,
      render: (_, c) => c.latestStatus
        ? (
          <span>
            <StatusPill status={c.latestStatus} />
            <span style={{ fontSize: 12, color: '#999' }}> {c.latestFinishedAt ? formatDateTime(c.latestFinishedAt) : '—'}</span>
          </span>
        )
        : '无记录',
    },
    {
      title: '提示',
      render: (_, c) => (
        <span>
          {c.alreadySuccess && <Tag color="green">后续已成功</Tag>}
          {c.blockedReason && <Tag color="red">{BLOCKED_TEXT[c.blockedReason]}</Tag>}
        </span>
      ),
    },
  ]

  let content: ReactNode
  if (!fresh && (query.isError || query.isRefetchError)) {
    content = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="预览加载失败" />
  } else if (!fresh) {
    content = <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
  } else if (candidates.length === 0) {
    content = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该批次没有失败窗口" />
  } else {
    content = (
      <>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message="已成功窗口默认不勾选，勾选后仍会强制执行；停用/熔断/执行中窗口不可选。"
        />
        <Table<RerunCandidate>
          size="small"
          rowKey="runId"
          pagination={false}
          dataSource={candidates}
          columns={columns}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(candidates.filter((c) => c.selectable && keys.includes(c.runId)).map((c) => c.runId)),
            getCheckboxProps: (c) => ({ disabled: !c.selectable }),
          }}
        />
      </>
    )
  }

  return (
    <Modal
      open={open}
      title="重跑失败窗口"
      width={760}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button
          key="ok"
          type="primary"
          loading={submit.isPending}
          disabled={!fresh || selected.length === 0}
          onClick={() => {
            if (!fresh || batchId == null || selected.length === 0) return
            submit.mutate({ batchId, runIds: selected.map(Number) }, { onSuccess: onClose })
          }}
        >
          重跑选中 {selected.length} 个
        </Button>,
      ]}
    >
      {content}
    </Modal>
  )
}
