import { ConfigProvider, App as AntApp } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { Route, Routes } from 'react-router-dom'
import { useThemeMode } from './theme/useThemeMode'
import { antdTheme } from './theme/antdTheme'
import AppLayout from './layouts/AppLayout'
import DashboardPage from './pages/dashboard'
import ProfilesPage from './pages/profiles'
import TasksPage from './pages/tasks'
import DocsPage from './pages/docs'
import SettingsPage from './pages/settings'

export default function App() {
  const { effective } = useThemeMode()
  return (
    <ConfigProvider theme={antdTheme(effective)} locale={zhCN}>
      <AntApp>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="docs" element={<DocsPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AntApp>
    </ConfigProvider>
  )
}
