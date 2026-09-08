import { useState } from 'react'
import { Alert, Button, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { summarizeNodes, useClashOptimize, useClashSetGroup, useClashStatus, useClashTest } from './hooks'
import type { ClashNodeResult, ClashUrlDelay } from '../../types'

const columns = [
  { title: '节点', dataIndex: 'name', key: 'name' },
  {
    title: '可用', dataIndex: 'usable', key: 'usable',
    render: (v: boolean) => (v ? <Tag color="green">可用</Tag> : <Tag color="red">不可用</Tag>),
  },
  { title: '得分', dataIndex: 'score', key: 'score', render: (v: number) => Math.round(v) },
  {
    title: '延迟明细', dataIndex: 'urls', key: 'urls',
    render: (urls: ClashUrlDelay[]) => urls.map((u) => `${u.url}: ${u.reachable ? `${u.delayMs}ms` : '超时'}`).join(' ｜ '),
  },
]

export default function ClashPanel() {
  const status = useClashStatus()
  const test = useClashTest()
  const optimize = useClashOptimize()
  const setGroup = useClashSetGroup()
  const [nodes, setNodes] = useState<ClashNodeResult[] | null>(null)

  if (status.isPending) {
    return <Alert type="info" showIcon message="正在探测本机 Clash 客户端..." />
  }

  if (status.isError || !status.data) {
    return <Alert type="warning" showIcon message="代理网络状态加载失败" description="请检查后端服务是否运行" />
  }

  const data = status.data
  const summary = nodes ? summarizeNodes(nodes) : null
  const paceTag = data.auto.pace === 'fast' ? <Tag color="orange">快速重检中</Tag> : <Tag color="blue">正常节奏</Tag>

  if (!data.detected) {
    return (
      <Alert
        type="warning"
        showIcon
        message="未检测到运行中的 Clash 客户端"
        description={`请确认 Clash 已启动且开启外部控制（external-controller，当前探测地址 ${data.apiBase}）。注意：管理 API 端口（默认 9090）与代理流量端口（7890）不是同一个。`}
      />
    )
  }

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Alert
        type={data.auto.allDown ? 'error' : 'info'}
        showIcon
        message={
          <Space wrap>
            <span>内核：{data.kernel ?? '未知'}</span>
            <span>当前节点：{data.currentNode ?? '未选择'}</span>
            {paceTag}
            {data.auto.allDown && <Tag color="red">全网不可用</Tag>}
            {data.anyRunning && <Tag>任务运行中</Tag>}
          </Space>
        }
        description={data.mixedPort ? `窗口代理应填 127.0.0.1:${data.mixedPort}（实测混合口）` : undefined}
      />

      <Space wrap>
        <Select
          value={data.group || undefined}
          placeholder="选择目标分组"
          style={{ width: 260 }}
          options={data.groups.map((g) => ({ value: g.name, label: g.now ? `${g.name}（当前 ${g.now}）` : g.name }))}
          onChange={(v) => {
            setGroup.mutate(v)
            // 切分组后旧测速结果已不适用，清空避免误导
            setNodes(null)
          }}
        />
        <Button
          icon={<ReloadOutlined />}
          loading={test.isPending}
          onClick={() => test.mutate(undefined, { onSuccess: (res) => setNodes(res.nodes) })}
        >
          立即测速
        </Button>
        <Popconfirm
          title="确定选优并切换？"
          description={data.anyRunning ? '有任务正在运行，切换节点会更换 IP，可能中断签到会话' : '将切换到当前最优节点'}
          onConfirm={() => optimize.mutate(undefined, { onSuccess: (res) => setNodes(res.nodes) })}
          okText="确定"
          cancelText="取消"
        >
          <Button type="primary" icon={<ThunderboltOutlined />} loading={optimize.isPending}>
            选优并切换
          </Button>
        </Popconfirm>
      </Space>

      {summary && (
        <Typography.Text type="secondary">
          测速结果：{nodes?.length} 个节点，{summary.usableCount} 个可用、{summary.downCount} 个不可用
          {summary.best && `，最优 ${summary.best.name}（${Math.round(summary.best.score)}）`}
        </Typography.Text>
      )}
      {nodes && <Table rowKey="name" size="small" columns={columns} dataSource={nodes} pagination={false} />}
    </Space>
  )
}
