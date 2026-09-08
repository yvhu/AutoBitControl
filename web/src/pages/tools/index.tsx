import { useState } from 'react'
import { Alert, Card, Col, Row, Space, Typography } from 'antd'
import { FileOutlined } from '@ant-design/icons'
import { useTools } from './hooks'
import FileAssignPanel from './file-assign'
import ClashPanel from './clash'

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
                avatar={<FileOutlined style={{ fontSize: 24, color: '#1677ff' }} />}
                title={t.name}
                description={t.description}
              />
            </Card>
          </Col>
        ))}
      </Row>
      {activeKey === 'file-assign' && <FileAssignPanel />}
      {activeKey === 'clash' && <ClashPanel />}
    </Space>
  )
}
