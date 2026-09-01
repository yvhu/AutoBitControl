# 窗口会话级钱包扩展检测（WalletSession）设计

日期：2026-09-01
状态：设计已确认（尚未实施代码）

## 背景

inception-dachain 真机大规模实测（100 窗口）暴露一类高频失败：窗口的钱包扩展因各种原因
未被成功加载（扩展注入慢/后台 service worker 未醒/扩展异常），登录流程无法弹窗，只能靠
任务重试**重启整个窗口**才能恢复（实证：win 93 重开后自愈）。

现状检查手段的不足：
- 只轮询 `window.ethereum` 是否存在——不区分是否 MetaMask（其它钱包也会注入）、
  不代表扩展后台活着（92/88/76 实测 ethereum 存在且 isMetaMask=true，弹窗仍不出）
- 无窗口会话内自愈手段，失败成本 = 600s 退避 + 3 次尝试配额
- 每个任务各自轮询，多任务时重复检查

## 目标

1. 精确判定「当前浏览器实例的钱包扩展是否加载成功」（区分钱包类型）
2. 检查时机：**窗口会话内第一次真正要用钱包时**（惰性），避免开窗即查的假阴性
   （扩展注入实测 0-30s 随机），也避免每任务重复检查
3. 失败窗口快速失败、错误明确，不浪费任务级流程；恢复手段仍为任务重试重启窗口
4. 支持多钱包类型并存（metamask / petra / 未来更多），互不影响

## 核心概念：WalletSession

- **内存态对象**，由 window-runner 在**每轮窗口会话**（开窗→跑任务→关窗）创建，
  注入该轮所有 TaskContext；会话结束即丢弃
- **绝不持久化**：检查语义是「当前浏览器实例的扩展是否加载」，浏览器实例只活在
  会话内；跨会话缓存反而错误（重启窗口 = 新实例 = 扩展重新加载，这正是自愈的原理）
- 只缓存「加载检查结果」；不解锁状态、不站点授权（这些是扩展内部状态，随窗口
  配置文件保留，由既有 unlock/ensureConnected 流程处理）

## 状态模型

按钱包类型分桶的会话级状态表：

```
{ metamask: unchecked | ready | missing, petra: ..., <新增类型>: ... }
```

- `unchecked`：本会话尚未探测过（初始态）
- `ready`：扩展已加载且能响应
- `missing`：扩展未加载/不可用

## 检测流程（三级）

`ensureReady(type)` 在任务登录流程入口调用（即现有 `window.ethereum` 轮询的位置，
任务前的 goto + 登录状态竞速已为扩展留出 20-60s 加载时间）：

1. **页面级**：主世界轮询 `window.ethereum`（沿用 10×6s 预算）并验证
   `ethereum.isMetaMask === true`（Petra 对应 `isPetra`）——区分其它钱包注入的 provider
2. **CDP 探测 + 预热**：新开临时 tab 直访扩展页
   `chrome-extension://<adapter.extensionId>/home.html`——
   - 能加载 → 扩展已安装且能响应，同时**唤醒 MV3 后台 service worker（预热）**
   - 加载失败 → `missing`
3. **弹窗兜底（已有，保留）**：点入口后 8s 无弹窗补点一次（B 方案已实施）

探测信息（扩展 ID / 探测页 URL）作为 WalletAdapter 的契约字段，新增钱包类型自动获得
检测能力（MetaMask ID = `nkbihfbeogaeaoehlefnkodbefgpgknn`，真机弹窗 URL 实证）。

## 集成点

- window-runner：每轮会话创建 WalletSession，注入 TaskContext deps
- task-context：暴露 `ctx.walletSession`（或封装方法）
- 任务侧：登录前 `await ctx.walletSession.ensureReady(task.meta.wallet)`，
  返回 `missing` 时抛「该窗口 <类型> 钱包扩展未加载，重试将重启窗口」
- 任务侧原有的 ethereum 轮询移除，替换为本调用

## 多钱包语义

- 惰性 + 按类型独立：只探测本会话任务实际用到的类型，未用到的类型永不探测
- 失败隔离：metamask 缺失不影响只用 petra 的任务；同类型第二个任务直接读缓存
- 混合场景：窗口会话跑 DAC 签到（metamask）+ 质押任务（petra）+ 无钱包任务，
  各查各的、无钱包任务不探测
- 前向兼容：目前 `meta.wallet` 为单值；将来扩为 `string[]` 时 ensureReady 按数组
  逐个查即可，会话结构不变

## 边界与取舍

- 复用窗口（open_windows 场景）：新会话重建 WalletSession 并重检——扩展可能在
  上次会话后崩溃，重检虽有小开销（~3-5s）但安全；不做跨会话缓存
- 每窗口会话每类型至多一次 CDP 临时 tab 探测，探测失败不再重试（交给窗口重启）
- 「已加载但弹窗不出」与「未加载」是两类失败：前者靠预热+补点兜底，后者靠快速
  失败+重启窗口；二者分工明确
- 时间参数沿用实测值：provider 轮询 10×6s；CDP 探测单次 ~5s 超时

## 测试策略

- WalletSession 单测：三态转换、按类型缓存、missing 短路、不同钱包互不影响
- window-runner 测试：会话创建/注入、复用窗口重建
- 真机验证：选历史「扩展未加载」窗口（92/88/76 类）+ 正常窗口对照，
  验证 missing 快速失败与 ready 正常登录两条路径

## 风险

- CDP 临时 tab 探测对部分比特浏览器版本可能行为差异（扩展页访问受限）——探测失败
  归入 `missing` 前需区分「访问被拒」与「网络失败」，必要时回退为仅页面级检查
- 多任务会话中检查时机在登录入口，若未来出现「无需登录的任务也需要钱包」的场景，
  检查点需移到任务 run 开头
