import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, Card, Col, Empty, Row, Space, Spin, Switch, Tag, Typography, theme } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import type { TaskMetaView } from '../../types'
import {
  categoryColor,
  categoryLabel,
  groupColor,
  groupTasks,
  toggleKey,
  useSetTaskEnabled,
  useTasks,
  useTriggerTask,
  type TaskGroup,
} from './hooks'

const WALLET_ICON: Record<string, string> = { metamask: '🦊', petra: '🐍' }

function walletIcon(wallet: string | null): string {
  return (wallet && WALLET_ICON[wallet]) || '▣'
}

/** note 折叠样式：超 3 行截断（-webkit-box 多行省略） */
const NOTE_CLAMP: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

function TaskCard({ task }: { task: TaskMetaView }) {
  const setEnabled = useSetTaskEnabled()
  const trigger = useTriggerTask()
  const dimmed = task.deprecated || task.enabled === false
  const [noteExpanded, setNoteExpanded] = useState(false)
  const noteRef = useRef<HTMLSpanElement>(null)
  const [noteOverflow, setNoteOverflow] = useState(false)

  // 折叠态测量是否超 3 行（scrollHeight > clientHeight 即溢出），决定「展开」按钮显隐
  useLayoutEffect(() => {
    const el = noteRef.current
    setNoteOverflow(el ? el.scrollHeight > el.clientHeight + 1 : false)
  }, [task.note])

  return (
    <Card size="small" style={{ height: '100%', ...(dimmed ? { opacity: 0.45 } : undefined) }}>
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
              ⏱ 钱包 {task.wallet ?? '无'} · 并发 {task.concurrency} · 重试{' '}
              {task.retry?.max ?? '默认'} 次
              {task.lastUpdated ? ` · 更新于 ${task.lastUpdated}` : ''}
            </Typography.Text>
          </div>
          {task.note && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <Typography.Text type="secondary">
                <span ref={noteRef} style={noteExpanded ? undefined : NOTE_CLAMP}>
                  📝 {task.note}
                </span>
              </Typography.Text>
              {noteOverflow && (
                <Typography.Link style={{ marginLeft: 4 }} onClick={() => setNoteExpanded((v) => !v)}>
                  {noteExpanded ? '收起' : '展开'}
                </Typography.Link>
              )}
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
              disabled={triggerButton(task.inFlight).disabled}
              onClick={() => trigger.mutate(task.key)}
            >
              {triggerButton(task.inFlight).label}
            </Button>
          )}
        </Space>
      </div>
    </Card>
  )
}

function GroupCard({ group, color, open, onToggle }: { group: TaskGroup; color: string; open: boolean; onToggle: () => void }) {
  const { token } = theme.useToken()
  return (
    <div style={{ background: token.colorBgContainer, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusLG, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', cursor: 'pointer' }} onClick={onToggle}>
        <span style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${color}, ${color}b3)`, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flexShrink: 0 }}>
          {group.name.charAt(0)}
        </span>
        <Typography.Text strong>{group.name}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{group.tasks.length} 个任务</Typography.Text>
        <span style={{ marginLeft: 'auto', color: token.colorTextTertiary, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <Row gutter={[12, 12]} align="stretch" style={{ padding: '0 12px 12px' }}>
          {group.tasks.map((t) => (
            <Col key={t.key} xs={24} xl={12}>
              <TaskCard task={t} />
            </Col>
          ))}
        </Row>
      )}
    </div>
  )
}

export default function TasksPage() {
  const tasks = useTasks()
  const [openKeys, setOpenKeys] = useState<string[]>([])

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

  const groups = groupTasks(tasks.data)
  const flat = groups.length === 1 && groups[0].key === ''
  const allOpen = groups.length > 0 && groups.every((g) => openKeys.includes(g.key))

  return (
    <Space direction="vertical" size={8} style={{ display: 'flex' }}>
      {flat ? (
        <Row gutter={[12, 12]} align="stretch">
          {tasks.data.map((t) => (
            <Col key={t.key} xs={24} xl={12}>
              <TaskCard task={t} />
            </Col>
          ))}
        </Row>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Typography.Text>任务分组</Typography.Text>
            <Space size={8} style={{ marginLeft: 'auto' }}>
              <Button size="small" disabled={allOpen} onClick={() => setOpenKeys(groups.map((g) => g.key))}>全部展开</Button>
              <Button size="small" disabled={openKeys.length === 0} onClick={() => setOpenKeys([])}>全部收起</Button>
            </Space>
          </div>
          {groups.map((g, i) => (
            <GroupCard key={g.key} group={g} color={groupColor(g.key, i)} open={openKeys.includes(g.key)} onToggle={() => setOpenKeys((keys) => toggleKey(keys, g.key))} />
          ))}
        </>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        → 任务定义在代码（src/tasks），开关与触发在此页管理
      </Typography.Text>
    </Space>
  )
}

/** 触发按钮态：在途禁用显示「运行中」，否则可点「立即触发」（isPending 时由 antd loading 接管） */
export function triggerButton(inFlight: boolean): { disabled: boolean; label: string } {
  return inFlight ? { disabled: true, label: '运行中' } : { disabled: false, label: '立即触发' }
}
