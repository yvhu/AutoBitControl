import { useState } from 'react'
import type { ComponentType, CSSProperties, ReactNode } from 'react'
import { Alert, Card, Col, Row, Space, Tooltip, Typography } from 'antd'
import { GlobalOutlined, SwapOutlined, ToolOutlined } from '@ant-design/icons'
import { useTools } from './hooks'
import FileAssignPanel from './file-assign'
import ClashPanel from './clash'

/** 工具图标映射（按注册表 key；未登记的回落通用工具图标） */
const TOOL_ICONS: Record<string, ReactNode> = {
  'file-assign': <SwapOutlined style={{ fontSize: 24, color: '#1677ff' }} />,
  clash: <GlobalOutlined style={{ fontSize: 24, color: '#1677ff' }} />,
}

/** 工具面板组件映射（新增工具：注册表加 key + 此处加一行） */
const TOOL_PANELS: Record<string, ComponentType> = {
  'file-assign': FileAssignPanel,
  clash: ClashPanel,
}

/** 卡片描述固定两行截断：无论描述长短卡片等高，新工具自动套用 */
const DESC_STYLE: CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  minHeight: 44,
}

/** 卡片标题单行截断：长工具名不撑高卡片 */
const TITLE_STYLE: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export default function ToolsPage() {
  const tools = useTools()
  const [activeKey, setActiveKey] = useState<string | null>(null)

  if (tools.isPending) {
    return (
      <Card size="small">
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Typography.Text type="secondary">加载中...</Typography.Text>
        </div>
      </Card>
    )
  }

  if (tools.isError || !tools.data) {
    return <Alert type="error" showIcon message="工具列表加载失败" description="请检查后端服务是否运行" />
  }

  const Panel = activeKey ? TOOL_PANELS[activeKey] : undefined

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <div>
        <Typography.Title level={4} style={{ marginBottom: 4 }}>
          工具中心
        </Typography.Title>
        <Typography.Text type="secondary">项目常用工具集合，随需扩展</Typography.Text>
      </div>
      <Row gutter={[16, 16]}>
        {tools.data.tools.map((t) => (
          <Col key={t.key} xs={24} sm={12} lg={8}>
            <Card
              hoverable
              onClick={() => setActiveKey(activeKey === t.key ? null : t.key)}
              style={activeKey === t.key ? { borderColor: '#1677ff' } : undefined}
            >
              <Card.Meta
                avatar={TOOL_ICONS[t.key] ?? <ToolOutlined style={{ fontSize: 24, color: '#1677ff' }} />}
                title={<div style={TITLE_STYLE}>{t.name}</div>}
                description={
                  <Tooltip title={t.description} mouseEnterDelay={0.4}>
                    <div style={DESC_STYLE}>{t.description}</div>
                  </Tooltip>
                }
              />
            </Card>
          </Col>
        ))}
      </Row>
      {Panel && <Panel />}
    </Space>
  )
}
