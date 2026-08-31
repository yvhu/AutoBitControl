import { Layout, Menu, Segmented, Tag, theme } from 'antd'
import {
  DashboardOutlined,
  DesktopOutlined,
  UnorderedListOutlined,
  ReadOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useThemeMode } from '../theme/useThemeMode'
import { fetchBalance, testBitbrowser } from '../api/endpoints'

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
  const { token } = theme.useToken()

  // 顶栏状态芯片：挂载时静默探测一次（不弹 message），失败统一显示灰色"状态未知"
  const bitbrowserStatus = useQuery({ queryKey: ['bitbrowser-status'], queryFn: testBitbrowser, staleTime: 60_000 })
  const captchaBalance = useQuery({ queryKey: ['header-balance'], queryFn: fetchBalance, staleTime: 60_000 })

  const bitbrowserTag = (() => {
    if (bitbrowserStatus.isError || bitbrowserStatus.data?.ok === undefined) return <Tag>状态未知</Tag>
    return bitbrowserStatus.data.ok ? <Tag color="green">比特浏览器已连接</Tag> : <Tag color="red">比特浏览器未连接</Tag>
  })()

  const balanceTag = (() => {
    if (captchaBalance.isError || !captchaBalance.data) return <Tag>状态未知</Tag>
    return captchaBalance.data.configured ? (
      <Tag color="green">yescaptcha ¥{captchaBalance.data.yuan.toFixed(2)}</Tag>
    ) : (
      <Tag>yescaptcha 未配置</Tag>
    )
  })()

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        breakpoint="lg"
        collapsedWidth="64"
        style={{
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          position: 'sticky',
          top: 0,
          height: '100vh',
          overflow: 'auto',
        }}
      >
        <div style={{ height: 32, margin: 16, color: token.colorText, fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          AutoBitControl
        </div>
        <Menu
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
          {bitbrowserTag}
          {balanceTag}
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
