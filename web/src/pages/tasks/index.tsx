import { Button, Card, Col, Empty, Row, Space, Spin, Switch, Tag, Typography } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import type { TaskMetaView } from '../../types'
import {
  categoryColor,
  categoryLabel,
  scheduleText,
  useSetTaskEnabled,
  useTasks,
  useTriggerTask,
} from './hooks'

const WALLET_ICON: Record<string, string> = { metamask: '🦊', petra: '🐍' }

function walletIcon(wallet: string | null): string {
  return (wallet && WALLET_ICON[wallet]) || '▣'
}

function TaskCard({ task }: { task: TaskMetaView }) {
  const setEnabled = useSetTaskEnabled()
  const trigger = useTriggerTask()
  const dimmed = task.deprecated || task.enabled === false

  return (
    <Card size="small" style={dimmed ? { opacity: 0.45 } : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ fontSize: 22, lineHeight: 1.4 }}>{walletIcon(task.wallet)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Space size="small" wrap>
            <Typography.Text strong>{task.name}</Typography.Text>
            <Typography.Text type="secondary">{task.key}</Typography.Text>
            <Tag color={categoryColor(task.category)}>{categoryLabel(task.category)}</Tag>
            {task.deprecated && <Tag color="default">已失效</Tag>}
            {task.enabled === false && <Tag color="default">已停用</Tag>}
          </Space>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <Typography.Text type="secondary">
              ⏱ {scheduleText(task.schedule)} · 钱包 {task.wallet ?? '无'} · 重试{' '}
              {task.retry?.max ?? '默认'} 次 · 验证码 {task.captcha?.auto === false ? '关' : '自动'}
              {task.lastUpdated ? ` · 更新于 ${task.lastUpdated}` : ''}
            </Typography.Text>
          </div>
          {task.note && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <Typography.Text type="secondary">📝 {task.note}</Typography.Text>
            </div>
          )}
          {task.sourceUrl && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <Space size="small" wrap>
                {(Array.isArray(task.sourceUrl) ? task.sourceUrl : [task.sourceUrl]).map((u, i) => (
                  <Typography.Link key={u} href={u} target="_blank" rel="noreferrer">
                    🔗 来源页{i > 0 ? i + 1 : ''}
                  </Typography.Link>
                ))}
              </Space>
            </div>
          )}
        </div>
        <Space size="small">
          <Switch
            checked={task.enabled}
            loading={setEnabled.isPending && setEnabled.variables?.key === task.key}
            onChange={(checked) => setEnabled.mutate({ key: task.key, enabled: checked })}
          />
          {task.enabled && (
            <Button
              type="primary"
              size="small"
              icon={<ThunderboltOutlined />}
              loading={trigger.isPending && trigger.variables === task.key}
              onClick={() => trigger.mutate(task.key)}
            >
              立即触发
            </Button>
          )}
        </Space>
      </div>
    </Card>
  )
}

export default function TasksPage() {
  const tasks = useTasks()

  if (tasks.isPending) {
    return (
      <Card size="small">
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      </Card>
    )
  }

  if (tasks.isError || !tasks.data) {
    return <Empty description="任务列表加载失败" />
  }

  if (tasks.data.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无任务" />
  }

  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      <Row gutter={[12, 12]}>
        {tasks.data.map((t) => (
          <Col key={t.key} xs={24} xl={12}>
            <TaskCard task={t} />
          </Col>
        ))}
      </Row>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        → 任务定义在代码（src/tasks），开关与触发在此页管理
      </Typography.Text>
    </Space>
  )
}
