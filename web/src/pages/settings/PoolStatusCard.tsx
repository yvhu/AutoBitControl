/**
 * 窗口池状态卡片（settings 组件）：只读展示池指标，5 秒轮询
 * 依赖方向：依赖 settings/hooks 的 usePoolStatus 与 types 的状态枚举
 * 设计思路：窗口池始终启用；状态快照不可用时提示稍后刷新，正常时按内存/健康/容量/队列分组展示
 */
import { Alert, Card, Descriptions, Space, Spin, Tag, Typography } from 'antd'
import type { PoolGlobalHealthState, PoolMemoryState } from '../../types'
import { usePoolStatus } from './hooks'

const MEMORY_STATES: Record<PoolMemoryState, { label: string; color: string }> = {
  normal: { label: '正常', color: 'green' },
  warning: { label: '偏高', color: 'orange' },
  critical: { label: '临界', color: 'red' },
}

const HEALTH_STATES: Record<PoolGlobalHealthState, { label: string; color: string }> = {
  normal: { label: '正常', color: 'green' },
  paused: { label: '暂停', color: 'red' },
  probing: { label: '探测中', color: 'gold' },
}

/** 内存状态文案与颜色（未知值兜底展示原始值） */
export function memoryStateView(state: PoolMemoryState): { label: string; color: string } {
  return MEMORY_STATES[state] ?? { label: state, color: 'default' }
}

/** 全局健康状态文案与颜色（未知值兜底展示原始值） */
export function healthStateView(state: PoolGlobalHealthState): { label: string; color: string } {
  return HEALTH_STATES[state] ?? { label: state, color: 'default' }
}

export default function PoolStatusCard() {
  const { data, isPending, isError } = usePoolStatus()

  return (
    <Card size="small" title="窗口池状态">
      {isPending ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : isError || !data ? (
        <Alert type="warning" showIcon message="窗口池状态加载失败" description="请检查后端服务是否运行" />
      ) : !data.status ? (
        <Space direction="vertical" size={8}>
          <Tag>窗口池状态不可用</Tag>
          <Typography.Text type="secondary">
            后端尚未产生首个池状态快照，请稍后刷新。
          </Typography.Text>
        </Space>
      ) : (
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          <Descriptions
            size="small"
            column={{ xs: 1, md: 2 }}
            items={[
              {
                key: 'memory',
                label: '内存状态',
                children: <Tag color={memoryStateView(data.status.memoryState).color}>{memoryStateView(data.status.memoryState).label}</Tag>,
              },
              {
                key: 'health',
                label: '全局健康',
                children: <Tag color={healthStateView(data.status.globalHealthState).color}>{healthStateView(data.status.globalHealthState).label}</Tag>,
              },
              { key: 'free', label: '空闲内存', children: `${data.status.freeMb} MB` },
              { key: 'perWindow', label: '单窗预估', children: `${data.status.perWindowMb} MB` },
              { key: 'pool', label: '有效池 / 上限', children: `${data.status.effectivePool} / ${data.status.maxOpenWindows}` },
              { key: 'actual', label: '已打开 / 池窗口', children: `${data.status.actualOpen} / ${data.status.poolSize}` },
              { key: 'windows', label: '忙碌 / 空闲 / 打开中', children: `${data.status.busy} / ${data.status.idle} / ${data.status.opening}` },
              { key: 'queue', label: '排队窗口 / 待执行任务', children: `${data.status.queueWindows} / ${data.status.pendingTasks}` },
              { key: 'updated', label: '更新时间', children: data.status.updatedAt ?? '—' },
            ]}
          />
          <Typography.Text type="secondary">只读，每 5 秒自动刷新。</Typography.Text>
        </Space>
      )}
    </Card>
  )
}
