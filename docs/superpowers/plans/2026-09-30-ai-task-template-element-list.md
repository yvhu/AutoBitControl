# AI 帮写任务模板重设计（元素清单式）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 API-GUIDE 附录「AI 帮写任务」从自然语言长描述模板重写为「元素清单式」轻量模板，并在 AGENTS.md 补 AI 侧行为约定，让用户几分钟填完、AI 直接写码。

**Architecture:** 纯文档改动——`docs/API-GUIDE.md` 附录整节替换（标题/填空模板/字段说明/示例/提交后流程），`AGENTS.md`「新增/修改任务」节补一段元素清单式处理约定。无代码、无测试用例改动。

**Tech Stack:** Markdown 文档。

## Global Constraints

- **全程不执行 `git commit`**（用户明确要求：先确认完整改动，再决定提交）。每个任务的「提交」步骤替换为本地验证。
- 文档中文；模板文案与设计文档 `docs/superpowers/specs/2026-09-30-ai-task-template-element-list-design.md` 第 4/5 节**逐字一致**。
- 只改计划指定的两个文件，不得触碰其它文件。
- 验证：`npm run typecheck`（确认无意外改动；文档不影响编译）。

---

### Task 1: 重写 API-GUIDE 附录（元素清单式模板）

**Files:**
- Modify: `docs/API-GUIDE.md`（第 1499-1598 行整节替换）

**Interfaces:**
- Produces: 新附录标题 `## 附录：AI 帮写任务模板（元素清单式）`；小节：填空模板 / 字段怎么填（逐条说明）/ 填写示例 / 提交后会发生什么。Task 2 的 AGENTS.md 段落引用本附录。

- [ ] **Step 1: 定位替换范围**

用 Read 确认 `docs/API-GUIDE.md` 第 1499 行起为 `## 附录：AI 帮写任务的自然语言描述模板`，其内容连续到第 1598 行（`6. **上线**：…`）结束；第 1599 行为空行，第 1600 行为 `---`，第 1602 行为 `## 11. 工具中心`。替换范围为：从 `## 附录：AI 帮写任务的自然语言描述模板` 到 `6. **上线**：面板任务页打开开关，之后手动触发执行（任务页「立即触发」/看板行级「执行」，见[第 6 章](#6-手动触发)）。` 整段（含中间全部内容），保留其后的 `---` 与 `## 11. 工具中心`。

- [ ] **Step 2: 用新附录整节替换旧内容**

将上面范围整体替换为以下内容（逐字）：

```markdown
## 附录：AI 帮写任务模板（元素清单式）

> 新增任务不用自己写代码：把下面模板填了丢给 AI（opencode 等）帮你写。**元素你给，其余 AI 查**——按钮写文案或直接贴选择器（原始长选择器不用筛选，AI 负责筛选），AI 补全缺失信息后直接写代码。

### 填空模板（直接复制，按提示填写）

```text
【新任务】

名称：
key：
类型：checkin / faucet / mint / other（四选一）
网址：
钱包：metamask / petra / 邮箱密码 / 无需登录
备注（可选）：

元素清单（每行一个动作；按钮写文案或贴选择器，原始长选择器直接粘，AI 会筛选）：
- 点：
- 填：        →        （数据源列名 / 固定值 / faker）
- 等：（成功后才出现的文案原文）
- 已领取：（今天已领过时的提示原文，没有写「无」）
- 弹窗（可选）：
```

### 字段怎么填（逐条说明）

头部字段：

| 字段 | 怎么填 | 例子 |
| --- | --- | --- |
| 名称 | 面板任务页显示的中文名 | ZooFaucet 领水 |
| key | 英文小写 + 连字符，全局唯一，起完尽量不改 | zoo-faucet |
| 类型 | 四选一：checkin 签到（绿）/ faucet 领水（蓝）/ mint 铸币（黄）/ other 其他（灰），只影响面板徽章颜色 | faucet |
| 网址 | 浏览器地址栏完整 URL；任务从子页面开始就填子页面 | https://zoofaucet.example.com/ |
| 钱包 | metamask / petra / 邮箱密码 / 无需登录 | metamask |
| 备注 | 想交代的坑（改版频繁、有倒计时等），可不填；会写进面板任务卡备注 | 站点偶尔改版 |

元素清单每行怎么填：

| 行开头 | 怎么填 |
| --- | --- |
| 点： | 优先写按钮上的字（如 `Claim`）；文案重复/难描述时贴选择器；补充说明写在同一行括号里 |
| 填： | `输入框（选择器或描述）→ 填什么`。填什么三选一：数据源列名（每个窗口不同，如「邮箱」列）/ 固定值 / faker（随机） |
| 等： | 成功后才出现的文案原文（语言、大小写照抄）——成功判定依据，宁严勿松 |
| 已领取： | 今天已领过时的提示原文；站点没有这种状态写「无」 |
| 弹窗（可选）： | 打开会弹公告/新手引导吗？怎么关（右上角 X / 「知道了」） |

选择器怎么拿：比特浏览器窗口 DevTools → 右键元素 → 检查 → Elements 面板右键该元素 → Copy → Copy selector。得到的长串（如 `#root > div.flex > button:nth-child(3)`）不用管多长，直接粘，AI 会筛成稳定短选择器。

### 填写示例

```text
【新任务】

名称：ZooFaucet 领水
key：zoo-faucet
类型：faucet
网址：https://zoofaucet.example.com/
钱包：metamask
备注：站点偶尔改版，成功文案会变

元素清单：
- 点：右上角 X（公告弹窗，选择器 .announce-modal button.close）
- 点：Connect Wallet（页面有两个同文案按钮，用 button:has-text("Connect Wallet"):visible）
- 填：input[type="email"] → 「邮箱」列
- 点：Claim
- 等：Claimed!（绿色提示即成功）
- 已领取：Please wait 24 hours
- 弹窗：打开弹公告，右上角 X 关
```

AI 拿到这段会筛出稳定选择器（如 `button:has-text("Claim")`），缺登录态判定等关键信息时一次性追问，然后写出约 20 行的任务文件（结构同[第 9 章「配方二：领水一条龙」](#配方二领水一条龙)），并在 `src/tasks/index.ts` 注册。

### 提交后会发生什么

模板提交后，AI 按下面的流程走，你只在关键节点确认：

1. **筛选选择器**：长选择器 → 稳定短选择器（优先 id / data-testid / 按钮文案），多候选时说明取舍。
2. **一次问完缺失信息**：登录标志（已登录/未登录文案）、成功判定、数据源列等关键信息缺失时一次性列全问题，不逐条追问、不瞎编。
3. **写任务代码**：新建 `src/tasks/<key>.ts`（写好 `meta` 与 `run`，登录竞速/刷新恢复/钱包/领取循环等稳定层按既有模式），并在 `src/tasks/index.ts` 的 `ALL` 数组注册。
4. **本地测试**：跑 `npm test` 确认代码没有语法/逻辑错误。
5. **真机试跑**：AI 给你单窗口试跑命令 `BITBROWSER_PROFILE_ID=<窗口ID> TASK_KEY=<key> npm run task:run`（见 README「冒烟测试」），你在真实窗口验证。建议多窗口验证：已登录与未登录窗口各抽一个，覆盖两条登录路径。
6. **你验收优化**：看面板结果与截图，把不对的地方（点错按钮、文案不一致、选择器失效）告诉 AI，改到跑通为止。
7. **上线**：面板任务页打开开关，之后手动触发执行（任务页「立即触发」/看板行级「执行」，见[第 6 章](#6-手动触发)）。
```

注意：新附录里嵌套的 ```text 代码围栏不要破坏外层 Markdown 结构；替换后 `## 11. 工具中心` 与前面的 `---` 保持原样。

- [ ] **Step 3: 验证一致性**

Run: `grep -n "自然语言描述模板" docs/API-GUIDE.md`（workdir=D:\StudySpace\AutoBitControl）
Expected: 无匹配（旧标题已消失）。

Run: `grep -n "元素清单式" docs/API-GUIDE.md`
Expected: 命中新标题。

- [ ] **Step 4: 验证（不提交）**

Run: `npm run typecheck`
Expected: 无错误。

---

### Task 2: AGENTS.md 补 AI 行为约定

**Files:**
- Modify: `AGENTS.md`（「新增/修改任务」节的要点段之后追加一段）

**Interfaces:**
- Consumes: Task 1 的新附录标题与流程（本段引用 `docs/API-GUIDE.md` 附录）。

- [ ] **Step 1: 定位插入点**

用 Read 打开 `AGENTS.md`，找到「新增/修改任务」节中「要点：任务 = `meta`…」这一段（约第 54 行），在该段之后、「## 数据层」之前插入新段。

- [ ] **Step 2: 插入内容**

在要点段之后追加（逐字）：

```markdown

**AI 帮写任务（元素清单式模板）**：用户按 `docs/API-GUIDE.md` 附录模板提交新任务时：① 筛选选择器（原始长选择器 → 稳定短选择器，优先 id/data-testid/按钮文案，多候选说明取舍）② 缺失关键信息（登录标志/成功判定/数据源列）一次性列全问题，不逐条追问、不瞎编 ③ 直接写代码（登录竞速/刷新恢复/钱包/领取循环按既有任务模式），真机闭环照常。用户给的是真值素材，不猜。
```

- [ ] **Step 3: 验证（不提交）**

Run: `grep -n "元素清单式模板" AGENTS.md`
Expected: 命中新段。

Run: `npm run typecheck`
Expected: 无错误。

---

### Task 3: 全量核对（文档一致性）

**Files:** 无

- [ ] **Step 1: 对照设计文档逐字核对**

用 Read 核对 `docs/API-GUIDE.md` 新附录与 `AGENTS.md` 新段，与设计文档 `docs/superpowers/specs/2026-09-30-ai-task-template-element-list-design.md` 第 4/5 节逐字一致（含示例中「已领取：Please wait 24 hours」「弹窗：打开弹公告，右上角 X 关」等细节）。

- [ ] **Step 2: 检查无残留引用**

Run: `grep -rn "自然语言描述模板" --include="*.md" .`
Expected: 仅命中 `docs/superpowers/specs/2026-09-30-ai-task-template-element-list-design.md`（历史记录允许）与无其它用户文档残留。

- [ ] **Step 3: 面板文档页目视确认（可选，用户侧）**

`npm run dev` → 面板「文档」页 → 附录节点标题应为「AI 帮写任务模板（元素清单式）」，模板与示例渲染正常。

**不执行任何 git commit（用户要求：确认完整改动后再决定）。**
