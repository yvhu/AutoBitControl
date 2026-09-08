# Clash 代理网络工具设计（clash-network-tool）

日期：2026-09-08
状态：设计已确认（含端口澄清、机场适配、自适应节奏调整）

## 目标

面板「工具中心」新增「代理网络」工具：探测本机运行的 Clash 客户端，提供节点测速、综合评分选优、切换节点/订阅能力，并支持定时自动检测（自适应节奏）。解决「本地 Clash 代理经常网络不好用」的痛点——网络变差时自动切换到可用且延迟较低的节点。

关键约束（已确认）：

- 全部比特浏览器窗口代理均填 Clash 本地混合端口，切节点全局生效，无需逐窗口操作
- 用户在不同设备/时间可能使用不同 Clash 客户端（Verge Rev / CFW / 裸 mihomo 等），设计必须按能力探测自适应，不硬编码客户端
- 切换订阅：既要能在多份订阅间切换，也要能在单份订阅内选节点（按客户端能力裁剪）

## 需求要点（已与用户确认）

- 手动触发（面板按钮）+ 定时自动检测（内置轻量定时器，不占用任务 scheduler）
- 判定标准：连通性 + 延迟综合——节点对测试 URL 全部不可达才算不可用；可达的 URL 越多越好，得分 = 可达 URL 的加权延迟 + 不可达 URL 惩罚分
- 机场适配：白名单机场（只放行特定域名）的节点测 google 失败不能误杀，靠「全部不可达才判死」规则规避；风控限速靠低并发（默认 2）+ 检测间隔规避
- 在途守卫：任务运行中不切换节点（换 IP 会破坏签到会话）；自动模式在途时只测速不切换，手动模式弹确认提示
- 自适应节奏：正常态 30 分钟一次；检测到当前节点不可用/全网挂时进入快速态 2 分钟一次，恢复后回正常态
- 不做「任务失败触发检测」（用户已否决）

## 架构

### 分层定位（tools 域内新增 clash 子模块）

```
server → tools/clash → infrastructure/http + infrastructure/config
server → engine（仅注入 queue.anyRunning() 供在途守卫用）
```

沿用 file-assign 先例：工具能力不进任务运行链路，放 `src/tools/clash/`；服务实例在 `src/app.ts` 组装（compose root），注入式依赖便于测试。

### 后端模块

| 文件 | 职责 |
|---|---|
| `src/tools/clash/types.ts` | 类型：探测结果、能力集、节点/分组、测速明细、评分结果、节奏状态 |
| `src/tools/clash/errors.ts` | Clash 域错误码（并入 `src/tools/errors.ts` 的 TOOL_ERROR_CODES 体系） |
| `src/tools/clash/client-detector.ts` | 候选地址探活（GET /version + GET /configs）、内核识别（meta 字段）、读取实际端口（mixed-port 用于面板展示窗口应填的代理地址）、输出能力集 |
| `src/tools/clash/adapter.ts` | mihomo external-controller 统一适配器：列分组/节点、delay 测速、切换节点、订阅（provider）列表/更新、config 文件切换（configPath 场景）；delay 接口 404 时降级为只测可达性 |
| `src/tools/clash/optimizer.ts` | ClashService：测速 → 评分 → 选优 → 切换 → 回滚，带进程内 busy 锁 |
| `src/tools/clash/auto-optimizer.ts` | 节奏状态机（正常/快速）+ 在途守卫（注入 anyRunning），start/stop 生命周期 |
| `src/server/routes/tools.ts` | 追加 /api/tools/clash/* 路由（@swagger 注解、ok/fail 统一响应、ToolError 映射） |
| `src/engine/queue.ts` | 新增 `anyRunning(): boolean`（running map 非空判定，一行） |

`src/app.ts`：创建 ClashService（注入 detector/adapter/config），启动 AutoOptimizer（clash.enabled 且 autoCheck.enabled 时），`toolsRouter({ xlsxPath, datasource, clash })` 挂载。

### 客户端探测与能力矩阵

探测流程（client-detector）：

1. 对配置的 `clash.apiBase`（默认 `http://127.0.0.1:9090`）GET `/version`；带 `apiSecret` 配置时请求加 Bearer 头
2. 响应体 `meta: true` → mihomo 系内核（Verge Rev / FlClash / 裸核等）；否则记为 generic clash
3. 紧接着 GET `/configs` 读取实际端口（`port` / `mixed-port` / `external-controller`），面板据此展示「窗口代理应填 `127.0.0.1:{mixed-port}`」的真实值
4. 全部候选地址失败 → CLASH_NOT_FOUND，面板显示开启外部控制的引导文案

能力矩阵（按探测结果 + 配置裁剪，不按客户端名硬编码）：

| 能力 | 接口 | 可用条件 |
|---|---|---|
| 列分组/节点 | GET /proxies | external-controller 可达 |
| 节点延迟测试 | GET /proxies/{name}/delay?url&timeout | 同上；404 时降级只测可达性 |
| 切换节点 | PUT /proxies/{name} | 同上 |
| 更新订阅（重拉节点） | PUT /providers/proxies/{name} | 订阅以 proxy-provider 配置（GET /providers/proxies 实测非空才显示按钮） |
| 切换订阅文件 | 写配置 + PUT /configs reload | 配置了 mihomo 配置路径（clash.configPath）且可写；未配置则面板隐藏该按钮并提示到客户端手动切换 |

说明：mihomo 系各 GUI 的订阅/profile 管理走各自内部通道，无统一公开 API；external-controller 是最大公约数，节点级操作跨客户端 100% 可用，订阅文件切换做成能力裁剪。

### 测速与选优算法（optimizer）

```
optimize():
 1. GET /proxies 取目标分组（clash.group，面板可选）下的节点，剔除 DIRECT/REJECT 等特殊节点
 2. 截断候选：最多 clash.maxNodes（默认 20）个
 3. 测速：节点间并发 clash.testConcurrency（默认 2，机场风控考虑）；同一节点内多 URL 串行
    每 URL 调 delay 接口，单测超时 clash.testTimeoutMs（默认 5000）
 4. 评分：
    - 全部 URL 不可达 → 节点不可用（白名单机场节点只要任务站点可达就不会被误杀）
    - 得分 = Σ(可达 URL 延迟 × 权重) + Σ(不可达 URL × 惩罚分，按 timeout 计)
 5. 选优：得分最低者当选；若当前节点仍在可用集内且当选者优势 < clash.minGainMs（默认 100ms）则不切换（避免频繁跳变）
 6. 切换：PUT /proxies/{group} → 回读确认生效；切换失败自动回滚原节点，回滚也失败标「节点异常」告警
```

手动「选优并切换」与定时自动共用同一 optimize()，仅触发来源与守卫行为不同。

### 定时自动检测与在途守卫（auto-optimizer）

节奏状态机（轻量 setInterval）：

```
正常态 ──normalIntervalMin(30)──▶ 检测 ──发现当前节点不可用/全网挂──▶ 快速态（fastIntervalMin(2)）
  ▲                                                                    │
  └──────────────── 恢复（重新选到可用节点）◀────────────────────────────┘
```

- `autoCheck.enabled` / `normalIntervalMin` / `fastIntervalMin`（0 = 关闭定时）
- 在途守卫：注入 `queue.anyRunning()`；自动模式下任务在途时只测速不切换，切换延后到空闲；连续 3 个检测周期因在途延后时记告警日志
- 手动 optimize 不受守卫硬拦：面板弹「任务正在运行，确定切换？换 IP 可能中断签到会话」确认提示
- 状态（检测中 / 已恢复 / 全网不可用 / 上次检测时间与结果）存内存，重启即重置（可接受，不建表）

### API 设计

- `GET /api/tools/clash/status` → `{ detected, kernel, capability, mixedPort, group, currentNode, lastCheck, pace, allDown }`
- `POST /api/tools/clash/test` → 只读测速，返回 `{ group, nodes: [{ name, urls: [{ url, delayMs, reachable }], score, usable }] }`
- `POST /api/tools/clash/optimize` → 测速 + 选优 + 切换，返回 `{ chosen, switched, nodes, switchNote }`
- `GET /api/tools/clash/subscriptions` → provider 订阅列表（能力裁剪，无 provider 时返回空列表）
- `POST /api/tools/clash/subscriptions/{name}/update` → 重拉订阅（provider 模式）
- `POST /api/tools/clash/group` → body `{ group }`，写入 config.json 的 clash.group（面板分组下拉）

## 配置（config.json 新增 `clash` 段，全带缺省值）

```json
"clash": {
  "enabled": true,
  "apiBase": "http://127.0.0.1:9090",
  "apiSecret": "",
  "group": "",
  "testUrls": ["https://www.gstatic.com/generate_204", "https://www.google.com"],
  "weights": [2, 1],
  "maxNodes": 20,
  "testConcurrency": 2,
  "testTimeoutMs": 5000,
  "minGainMs": 100,
  "autoCheck": { "enabled": true, "normalIntervalMin": 30, "fastIntervalMin": 2 },
  "configPath": ""
}
```

- 端口说明：`apiBase` 是 external-controller 管理口（默认 9090）；7890 是代理混合口（流量口），由 /configs 实测读取用于展示，不硬编码
- `group` 留空：面板首次使用时从 API 实时拉取分组下拉选择（不猜配置）；`configPath` 留空：订阅文件切换能力隐藏

## 错误码（src/server/http/errors.ts 与 src/tools/errors.ts 同步追加）

| code | 含义 |
|---|---|
| 40006 CLASH_NOT_FOUND | 未检测到运行中的 Clash 客户端（引导开启外部控制） |
| 40007 CLASH_AUTH_FAILED | apiSecret 校验失败（401） |
| 40008 CLASH_GROUP_NOT_FOUND | 目标分组不存在（面板下拉刷新后重选） |
| 40904 TOOL_BUSY | 复用：上一次检测/切换进行中 |
| 50002 CLASH_API_FAILED | Clash API 调用失败（非探测类） |
| 50003 CLASH_ALL_DOWN | 测速全网不可用 |
| 50004 CLASH_SWITCH_FAILED | 切换失败（已自动回滚；回滚也失败时错误信息附「节点异常」提示） |

## 健壮性

- 探测/测速全部超时短（testTimeoutMs 默认 5s），API 失败不崩进程，走 ToolError 统一响应
- 单例服务 + busy 锁防面板并发点击；自动检测与手动 optimize 互斥（共享同一把锁）
- 切换失败自动回滚；回滚失败只告警不动其他状态
- 全网挂时：面板红标 + 中文日志告警，不触发任何任务操作（任务自身有超时/重试/熔断兜底）
- 低并发测速 + 检测间隔，避免触发机场风控

## 前端

| 文件 | 改动 |
|---|---|
| `src/tools/index.ts` | TOOLS 注册表加 `{ key: 'clash', name: '代理网络', description: ... }` |
| `web/src/pages/tools/clash.tsx`（新建） | 代理网络面板 |
| `web/src/pages/tools/hooks.ts` | 追加 clash 相关 react-query hooks 与可测纯函数 |
| `web/src/pages/tools/hooks.test.tsx` | 追加 clash hooks 单测 |
| `web/src/api/endpoints.ts` | 追加 fetchClashStatus / testClash / optimizeClash / fetchClashSubscriptions / updateClashSubscription / setClashGroup |
| `web/src/types.ts` | 手补类型（先例）：ClashStatus、ClashNodeResult、ClashSubscription 等 |

面板交互：

- 顶部状态条：客户端探测结果（内核类型/未检测到引导）、目标分组（下拉实时拉取）、当前节点、全网可用性、节奏状态
- 节点表格：节点名、各 URL 延迟、综合得分、可用标记；按钮「立即测速」「选优并切换」（在途确认提示）
- 订阅区：订阅列表 + 「更新订阅」按钮（provider 模式才显示）；订阅文件切换按钮仅 configPath 配置且可写时显示
- 端口提示：展示「窗口代理应填 127.0.0.1:{mixed-port}」（/configs 实测值）

## 测试

- 后端（vitest，注入 fake HTTP 客户端，不连真 Clash）：
  - client-detector：候选地址探活顺序、secret 头、meta 内核识别、/configs 端口解析、全部失败 CLASH_NOT_FOUND
  - optimizer：全部不可达判死、白名单机场场景（部分 URL 不可达仍可用）、加权得分、minGainMs 不切换、切换失败回滚、busy 锁
  - adapter：delay 404 降级只测可达性、provider 列表解析
  - auto-optimizer：fake timer 节奏状态机（正常→快速→恢复）、在途守卫跳过切换与 3 次告警、0 关闭
  - 路由：supertest 测 status/test/optimize/subscriptions/group 正常与错误路径（注入 mock 服务）
- 前端：hooks.test.tsx（`npm run test:web`）

## 不做（YAGNI）

- 任务失败触发即时检测（用户已否决）
- 与引擎深度联动（自动重跑任务）、逐窗口节点分配
- 检测历史持久化（内存状态即可）、多订阅并发切换、订阅地址管理界面
- 除分组选择外的运行时配置写回（其余设置改 config.json，面板只读展示）
