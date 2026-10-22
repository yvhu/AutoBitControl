import { Alert, Button, Card, Descriptions, Segmented, Space, Spin, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import ConfirmButton from '../../components/ConfirmButton'
import { useThemeMode } from '../../theme/useThemeMode'
import PoolStatusCard from './PoolStatusCard'
import {
  datasourceText,
  useReloadDatasource,
  useSettings,
  useTestBitbrowser,
} from './hooks'

export default function SettingsPage() {
  const settings = useSettings()
  const reload = useReloadDatasource()
  const test = useTestBitbrowser()
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
            { key: 'maxWin', label: '全局窗口上限', children: s.maxConcurrentWindows },
            { key: 'breakerEnabled', label: '熔断开关', children: s.circuitBreakerEnabled ? '开启' : '关闭' },
            { key: 'breaker', label: '熔断阈值', children: s.circuitBreakerThreshold },
            { key: 'breakerCooldown', label: '冷却 / 上限', children: `${s.circuitBreakerCooldownSec / 60} / ${s.circuitBreakerMaxCooldownSec / 60} 分钟` },
            { key: 'version', label: '版本', children: s.version },
          ]}
        />
      </Card>

      <PoolStatusCard />

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
            <ConfirmButton
              icon={<ReloadOutlined />}
              loading={reload.isPending}
              confirm={{ title: '重新读取 Excel 数据源？', okText: '重载' }}
              onConfirm={() => reload.mutate()}
            >
              重载
            </ConfirmButton>
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
