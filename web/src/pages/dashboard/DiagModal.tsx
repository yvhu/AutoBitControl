/**
 * 失败诊断弹窗（dashboard 层）：展示失败 run 的诊断包——错误/URL/步骤时间线/关键文本/弹窗文本 + 截图入口
 * 依赖方向：仅依赖 api/endpoints 与 types；数据由 react-query 缓存（staleTime 无限），重开不重复请求
 */
import type { CSSProperties, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Descriptions, Empty, Modal, Spin, Timeline, Typography } from 'antd'
import { fetchDiagnostics } from '../../api/endpoints'
import type { DiagBundle } from '../../types'

export interface DiagModalProps {
  runId: number | null
  open: boolean
  onClose: () => void
  screenshot?: string | null
}

const PRE_STYLE: CSSProperties = {
  maxHeight: 160,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  background: 'rgba(0,0,0,0.03)',
  border: '1px solid #eee',
  borderRadius: 6,
  padding: 8,
  margin: '8px 0 0',
  fontSize: 12,
}

function StepsTimeline({ steps }: { steps: DiagBundle['steps'] }) {
  if (steps.length === 0) return <Typography.Text type="secondary">无步骤记录</Typography.Text>
  return (
    <Timeline
      items={steps.map((s, i) => ({
        key: i,
        color: s.ok ? 'green' : 'red',
        children: (
          <span>
            {s.name}
            <Typography.Text type="secondary">（{s.ms}ms）</Typography.Text>
            {!s.ok && s.detail ? <Typography.Text type="danger"> {s.detail}</Typography.Text> : null}
          </span>
        ),
      }))}
    />
  )
}

function DiagContent({ diag, screenshot }: { diag: DiagBundle; screenshot?: string | null }) {
  return (
    <div>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="错误">
          {diag.error ? <Typography.Text type="danger">{diag.error}</Typography.Text> : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="URL">
          {diag.url
            ? <Typography.Link href={diag.url} target="_blank" rel="noreferrer">{diag.url}</Typography.Link>
            : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="采集时间">{diag.capturedAt || '—'}</Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 12 }}>
        <Typography.Text strong>步骤时间线</Typography.Text>
        <div style={{ marginTop: 8 }}>
          <StepsTimeline steps={diag.steps} />
        </div>
      </div>
      {diag.dialogText ? (
        <div style={{ marginTop: 12 }}>
          <Typography.Text strong>弹窗文本</Typography.Text>
          <pre style={PRE_STYLE}>{diag.dialogText}</pre>
        </div>
      ) : null}
      {diag.visibleText ? (
        <div style={{ marginTop: 12 }}>
          <Typography.Text strong>页面文本</Typography.Text>
          <pre style={PRE_STYLE}>{diag.visibleText}</pre>
        </div>
      ) : null}
      {screenshot ? (
        <div style={{ marginTop: 12 }}>
          <Button type="link" onClick={() => window.open(`/api/screenshots?path=${encodeURIComponent(screenshot)}`, '_blank')}>
            🖼 查看截图
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export default function DiagModal({ runId, open, onClose, screenshot }: DiagModalProps) {
  const query = useQuery({
    queryKey: ['diag', runId],
    queryFn: () => fetchDiagnostics(runId as number),
    enabled: open && runId != null,
    staleTime: Infinity,
    retry: false,
  })

  let content: ReactNode
  if (query.isPending) {
    content = <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
  } else if (query.isError || !query.data) {
    content = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="诊断不可用" />
  } else {
    content = <DiagContent diag={query.data} screenshot={screenshot} />
  }

  return (
    <Modal open={open} title="失败诊断" onCancel={onClose} footer={null} width={720}>
      {content}
    </Modal>
  )
}
