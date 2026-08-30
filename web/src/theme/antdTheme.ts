import { theme as antd } from 'antd'

export function antdTheme(effective: 'light' | 'dark') {
  return {
    algorithm: effective === 'dark' ? antd.darkAlgorithm : antd.defaultAlgorithm,
    token: { colorPrimary: '#1677FF' },
  }
}
