import { Alert, App, Button, Card, Descriptions, Segmented, Space, Spin, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useThemeMode } from '../../theme/useThemeMode'
import {
  datasourceText,
  formatBalance,
  useBalance,
  useReloadDatasource,
  useSettings,
  useTestBitbrowser,
} from './hooks'

export default function SettingsPage() {
  const { message } = App.useApp()
  const settings = useSettings()
  const reload = useReloadDatasource()
  const test = useTestBitbrowser()
  const balance = useBalance()
  const { mode, setMode } = useThemeMode()

  if (settings.isPending) {
    return (
      <Card size="small">
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      </Card>
    )
  }

  if (settings.isError || !settings.data) {
    return <Alert type="error" showIcon message="设置加载失败" description="请检查后端服务是否运行" />
  }

  const s = settings.data

  const queryBalance = () => {
    balance.refetch().then((r) => {
      if (r.data) {
        message.success(r.data.configured ? `余额 ${r.data.points.toLocaleString()} 点（¥${r.data.yuan}）` : '未配置 Key')
      }
    })
  }

  return (
    <Space direction="vertical" size={16} style={{ display: 'flex' }}>
      <Card size="small" title="比特浏览器">
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="API 地址">
              <Typography.Text code>{s.bitbrowserApiBase}</Typography.Text>
            </Descriptions.Item>
          </Descriptions>
          <Space size="middle">
            <Button type="primary" loading={test.isPending} onClick={() => test.mutate()}>
              测试连接
            </Button>
            {test.data && <Tag color={test.data.ok ? 'green' : 'red'}>{test.data.ok ? '已连接' : '连接失败'}</Tag>}
          </Space>
        </Space>
      </Card>

      <Card size="small" title="执行参数（只读）">
        <Descriptions
          size="small"
          column={{ xs: 1, md: 2 }}
          items={[
            { key: 'stagger', label: '错峰上限', children: `${s.staggerMaxSec} 秒` },
            { key: 'breaker', label: '熔断阈值', children: s.circuitBreakerThreshold },
            { key: 'version', label: '版本', children: s.version },
          ]}
        />
      </Card>

      <Card size="small" title="yescaptcha">
        <Space size="middle">
          <Button loading={balance.isFetching} onClick={queryBalance}>
            查询余额
          </Button>
          {balance.data ? (
            <Tag color={balance.data.configured ? 'green' : 'default'}>{formatBalance(balance.data)}</Tag>
          ) : (
            <Typography.Text type="secondary">点击查询当前打码余额</Typography.Text>
          )}
          {balance.isError && <Typography.Text type="danger">余额查询失败</Typography.Text>}
        </Space>
      </Card>

      <Card size="small" title="数据源">
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          {s.datasource.available ? (
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="路径">
                <Typography.Text code>{s.datasource.path}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="状态">{datasourceText(s.datasource)}</Descriptions.Item>
            </Descriptions>
          ) : (
            <Alert
              type="error"
              showIcon
              message="数据源不可用"
              description={s.datasource.error || s.datasource.path || '未配置数据源'}
            />
          )}
          <div>
            <Button icon={<ReloadOutlined />} loading={reload.isPending} onClick={() => reload.mutate()}>
              重载
            </Button>
          </div>
        </Space>
      </Card>

      <Card size="small" title="主题">
        <Segmented
          value={mode}
          onChange={(value) => setMode(value as 'light' | 'dark' | 'system')}
          options={[
            { label: '浅色', value: 'light' },
            { label: '深色', value: 'dark' },
            { label: '跟随系统', value: 'system' },
          ]}
        />
      </Card>
    </Space>
  )
}
