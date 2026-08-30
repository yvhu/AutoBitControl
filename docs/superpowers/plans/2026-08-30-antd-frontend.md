# 前端 antd 重做实施计划（2026-08-30）

## 目标
用 React + TypeScript + Ant Design 5 重做整个面板，浅色/深色双主题默认跟随系统（支持手动切换），功能与现有面板 1:1 对齐，API 不变。

## 技术决策
- 构建：Vite（outDir → src/server/public，产物提交；express 静态服务不变）
- 依赖：react / react-dom / antd / @ant-design/icons / marked（沿用）/ vite / @vitejs/plugin-react；devDeps 加 eslint + typescript-eslint
- 导航：状态切换（不引 react-router，保持简单）
- 主题：ConfigProvider + theme.darkAlgorithm/defaultAlgorithm，初始跟随 `prefers-color-scheme` 并监听变化，顶栏提供手动切换（存 localStorage，默认"跟随系统"）
- 主色：#1677FF（antd 官方）；代码规范：TS strict、禁止 any（eslint no-explicit-any）、组件化目录、中文 UI、注释只在复杂逻辑处

## 目录
```
web/
  index.html
  vite.config.ts
  tsconfig.json
  eslint.config.js
  src/
    main.tsx
    App.tsx                 # ConfigProvider 主题系统 + Layout 壳 + 页面路由
    api.ts                  # fetch 封装（envelope 解包，沿用现有接口）
    theme.ts                # 主题检测/切换
    pages/
      Dashboard.tsx         # 看板
      Profiles.tsx          # 窗口
      Tasks.tsx             # 任务
      Docs.tsx              # 文档（树+marked+折叠+scrollspy+锚点/src://）
      Settings.tsx          # 设置
    components/             # StatusTag 等共用组件
```

## 功能对齐清单（必须全部保留）
看板：统计卡（完成率圆环/分布条/验证码/运行）、日期与任务筛选、状态分段、矩阵表+行级执行/重跑、全部窗口执行、重跑今日失败、15s 轮询（防竞态）
窗口：搜索、同步按钮、启用开关、详情 Modal（时间线+重置熔断）、复制ID、立即跑
任务：卡片（分类徽章/备注/来源链接/开关/触发/停用隐藏按钮）
文档：左侧目录树（手册+示例文件、折叠、scrollspy 跟随）、markdown 渲染、代码块折叠、锚点与 src:// 跳转
设置：只读配置、连接测试、余额、数据源状态+重载
全局：错误提示（antd message）、顶栏连接/余额 chip、版本/时区

## 任务划分
W1 脚手架+主题+壳+api 封装（构建打通、服务可用、旧文件移除、web.test 断言适配）
W2 看板页
W3 窗口页 + 任务页
W4 文档页 + 设置页
W5 交互收尾（提示/轮询防竞态/细节对齐）+ ESLint 全绿 + 文档同步 + 终审

## 约束
每个任务：npm test 全绿 + typecheck 干净 +（若引入 web 独立 typecheck 则一并跑）+ 提交；后端零改动（除 web.test.ts 断言与静态目录说明）
