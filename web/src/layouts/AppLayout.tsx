import { Layout, Menu, Segmented, Tag } from 'antd'
import {
  DashboardOutlined,
  DesktopOutlined,
  UnorderedListOutlined,
  ReadOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useThemeMode } from '../theme/useThemeMode'

const { Sider, Header, Content } = Layout

const menuItems = [
  { key: '/', icon: <DashboardOutlined />, label: '看板' },
  { key: '/profiles', icon: <DesktopOutlined />, label: '窗口' },
  { key: '/tasks', icon: <UnorderedListOutlined />, label: '任务' },
  { key: '/docs', icon: <ReadOutlined />, label: '文档' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
]

export default function AppLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { mode, setMode } = useThemeMode()

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="64">
        <div style={{ height: 32, margin: 16, color: '#fff', fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          AutoBitControl
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[pathname === '/' ? '/' : pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 16,
            paddingInline: 24,
            background: 'transparent',
          }}
        >
          <Tag color="processing">连接</Tag>
          <Tag color="green">余额 --</Tag>
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as 'light' | 'dark' | 'system')}
            options={[
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' },
              { label: '跟随系统', value: 'system' },
            ]}
          />
        </Header>
        <Content style={{ margin: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
