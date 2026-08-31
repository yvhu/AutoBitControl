import { theme as antd } from 'antd'

export function antdTheme(effective: 'light' | 'dark') {
  const algorithm = effective === 'dark' ? antd.darkAlgorithm : antd.defaultAlgorithm
  // Layout.siderBg 默认恒为 #001529（不随算法变化），显式映射到算法派生令牌：浅色=白底、深色=深底
  const base = antd.getDesignToken({ algorithm })
  return {
    algorithm,
    token: { colorPrimary: '#1677FF' },
    components: {
      Layout: { siderBg: base.colorBgContainer },
    },
  }
}
