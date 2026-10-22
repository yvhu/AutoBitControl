/**
 * 运行截图预览（dashboard 层）：列出某次运行的全部截图（1–3 张）并支持大图预览
 * 依赖方向：仅依赖 api/endpoints 与 types；数据由 react-query 缓存（打开时按需拉取）
 */
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Empty, Image, Modal, Spin, Typography } from 'antd'
import { fetchRunArtifacts } from '../../api/endpoints'
import type { RunArtifact } from '../../types'

/** 截图文件通过后端代理读取（路径必须位于截图根目录内） */
const screenshotUrl = (path: string): string => `/api/screenshots?path=${encodeURIComponent(path)}`

/** 固定文件名 → 中文标签（未知名字保留原名，去掉 .png） */
const FIXED_LABELS: Record<string, string> = {
  'quiz-answer': '答题',
  'claim-success': '领取成功',
}

/**
 * 截图展示名：固定名映射 + 框架自动截图规律（`<日期>-success` / `<日期>-attemptN`）。
 * @param name 文件名（含 .png）
 */
export function artifactLabel(name: string): string {
  const base = name.replace(/\.png$/i, '')
  if (FIXED_LABELS[base]) return FIXED_LABELS[base]
  if (/^\d{4}-\d{2}-\d{2}-success$/.test(base)) return '完成'
  const attempt = /^\d{4}-\d{2}-\d{2}-attempt(\d+)$/.exec(base)
  if (attempt) return `第 ${attempt[1]} 次失败`
  return base
}

export interface RunArtifactsModalProps {
  runId: number | null
  open: boolean
  onClose: () => void
}

export default function RunArtifactsModal({ runId, open, onClose }: RunArtifactsModalProps) {
  const query = useQuery({
    queryKey: ['run-artifacts', runId],
    queryFn: () => fetchRunArtifacts(runId as number),
    enabled: open && runId != null,
    staleTime: 30_000,
    retry: false,
  })
  const files: RunArtifact[] = query.data?.files ?? []
  const title = files.length > 0 ? `截图（${files.length} 张）` : '截图'

  let content: ReactNode
  if (query.isPending) {
    content = <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
  } else if (query.isError) {
    content = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="截图列表加载失败" />
  } else if (files.length === 0) {
    content = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无截图" />
  } else {
    content = (
      <Image.PreviewGroup>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {files.map((f) => (
            <div key={f.path} style={{ width: 210 }}>
              <Image
                src={screenshotUrl(f.path)}
                alt={artifactLabel(f.name)}
                width={210}
                height={130}
                style={{ objectFit: 'cover', border: '1px solid #eee', borderRadius: 6 }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{artifactLabel(f.name)}</Typography.Text>
            </div>
          ))}
        </div>
      </Image.PreviewGroup>
    )
  }

  return (
    <Modal open={open} title={title} onCancel={onClose} footer={null} width={760}>
      {content}
    </Modal>
  )
}
