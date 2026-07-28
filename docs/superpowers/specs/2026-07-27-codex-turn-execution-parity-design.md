# CodexPlatform 1.1 Codex Turn 执行交互逐项对齐设计

日期：2026-07-27  
状态：待产品确认  
范围：用户端 Thread/Turn 主交互

## 1. 决策

CodexPlatform 1.1 的 Agent 执行交互不再以“参考 Codex 后重新设计”为目标，而以当前 Codex
桌面端的可观察产品行为作为验收基准。

需要逐项对齐：

- 用户输入后形成一个连续 Turn。
- Turn 执行过程中持续计时。
- 以可读叙述、推理摘要和紧凑动作行交错展示工作过程。
- 展示当前动作，例如 Thinking、Searching、Reading、Editing、Running、Waiting for approval、
  Delegating、Verifying。
- 同一 Item 的开始、增量和完成事件原位更新，不生成重复大卡片。
- Turn 完成后展示独立最终结论。
- 最终结论出现时，执行过程自动折叠为 `Worked for <duration>`；用户可重新展开审计。
- Steer、审批、Tool、飞书操作和 Subagent 进入同一个 Turn 的时间顺序，不再作为主 Transcript
  中彼此割裂的大卡片。

平台不复制 Codex 的商标、名称、私有代码或不可公开实现，也不展示原始思维链。飞书身份、
企业权限、审计、账号池和 Tool Gateway 作为企业增强能力保留，但不得改变 Codex 的主交互语法。

## 2. 用户可见结构

每个 Turn 固定由三部分组成：

```text
User prompt

Turn execution group
  Working for 2m 14s · Thinking
  ├─ Agent 可读叙述
  ├─ 推理摘要
  ├─ 紧凑动作行
  ├─ Agent 可读叙述
  ├─ 审批 / Tool / Subagent 活动
  └─ 当前动作

Final answer
```

运行时执行组默认展开。终态时结构变为：

```text
User prompt

Worked for 3m 42s  >

Final answer
```

点击 `Worked for` 可恢复完整执行过程。最终结论永远不进入折叠区。

## 3. Turn 状态与标题

| 平台状态 | 标题 | 默认展开 | 当前动作 |
| --- | --- | --- | --- |
| `ALLOCATING` | `Starting…` | 是 | Preparing workspace |
| `QUEUED` | `Queued` | 是 | Waiting for capacity |
| `RUNNING` | `Working for <duration>` | 是 | 由最近活动推导 |
| `WAITING_APPROVAL` | `Working for <duration>` | 是 | Waiting for approval |
| `COMPLETED` | `Worked for <duration>` | 否 | 不显示 |
| `FAILED` | `Failed after <duration>` | 是 | 显示失败动作 |
| `INTERRUPTED` | `Stopped after <duration>` | 是 | Stopped |
| `NEEDS_RECOVERY` | `Needs recovery after <duration>` | 是 | Connection lost |

文案跟随用户语言设置；英文模式使用 Codex 的英文表达，中文模式做等义本地化。交互和状态语义
必须一致。

计时规则：

- 起点使用服务端 `Turn.startedAt`，而不是浏览器收到第一个事件的时间。
- 运行中由客户端每秒更新显示，但不得反写服务端。
- 终态使用 `Turn.durationMs`；缺失时才使用 `completedAt - startedAt`。
- 断线重连后根据服务端时间恢复，不从零开始。

## 4. 执行过程的内容语法

### 4.1 Agent 可读叙述

Agent 在执行过程中的用户可读消息按流式 Delta 原位增长，保持 Markdown、代码、引用和链接。
同一 `itemId` 只形成一段连续内容。

过程叙述与最终结论必须分离。锁定协议已提供 `MessagePhase = "commentary" | "final_answer"`：
`ThreadItem.agentMessage.phase` 可以明确区分过程评论和最终回答。`item/agentMessage/delta` 通知本身
不携带 phase，因此 Event Normalizer 必须用同一 `itemId` 将 Delta 与 `item/started` /
`item/completed` 中的 Agent Message Item 合并。phase 为 `null` 或未知时保留兼容展示，但不得用
“最后一个字符串就是最终回答”的脆弱规则猜测最终结论。

### 4.2 推理摘要

- 只显示官方允许的 `reasoning.summary`。
- 展示为执行过程中的轻量可读段落，不使用独立大卡片。
- `reasoningTextDelta`、原始 `content` 和 `encrypted_content` 不进入浏览器、SQLite、SSE、
  日志或审计。
- 当前动作可以显示 `Thinking`，但它是状态标签，不代表展示原始思维链。

### 4.3 紧凑动作行

动作行由图标、动词、对象和可选结果组成：

```text
⌕ Searched the web for Codex App Server transport
⌘ Ran pnpm test runtime-supervisor                         8.2s
✎ Edited runtime-supervisor.ts                           +19 −1
◈ Used feishu_wiki_search                                1.8s
◉ Https provider audit started working
```

规则：

- 一个 Runtime Item 对应一个动作行。
- `STARTED` 创建行；Delta 更新详情面板；`COMPLETED/FAILED` 原位更新状态、耗时和结果摘要。
- Transcript 只显示摘要。命令完整输出仍进入 Bottom Terminal；Tool 参数和结果、Diff、文件详情仍
  进入 Side Panel。
- 点击动作行打开详情，不改变主 Transcript 的时间顺序。
- 不把同一操作拆成“开始卡片”和“完成卡片”。

### 4.4 企业能力的表达

企业增强能力完全服从同一动作语法：

| 企业事件 | Transcript 动作行 | 详情 |
| --- | --- | --- |
| 飞书搜索 | `Searched Feishu Wiki for <query>` | Side Panel Tool details |
| 飞书读取 | `Read <document title> from Feishu` | Side Panel Source/Tool |
| 数据库查询 | `Queried <approved data source>` | Side Panel Tool details |
| 业务系统读取 | `Read <resource> from <system>` | Side Panel Tool details |
| 审批 | `Requested approval for <action>` | 行内决策区，详情可展开 |
| Subagent 启动 | `<name> started working` | Side Panel / Subagent Thread |
| Subagent 完成 | `<name> finished` | 原位更新并显示一行摘要 |

用户身份、权限范围和审计 ID 不在动作行中堆叠，管理员可在审计后台查看关联信息。

## 5. 当前动作推导

当前动作不是模型自由生成的状态文案，而是由最近一个未完成 Item 和 Turn 状态确定性映射：

| 优先级 | 条件 | 当前动作 |
| --- | --- | --- |
| 1 | Turn 等待审批 | Waiting for approval |
| 2 | 活跃 Subagent 创建/等待 | Delegating |
| 3 | Tool / MCP 活跃 | Using `<tool>` |
| 4 | Command 活跃 | Running command |
| 5 | 文件读取活动 | Reading files |
| 6 | 文件修改活动 | Editing files |
| 7 | Web/知识库检索活动 | Searching |
| 8 | 测试、Diff 校验活动 | Verifying |
| 9 | Context compaction | Compacting context |
| 10 | 正在接收 reasoning summary 或无其他活动 | Thinking |

多个活动并行时显示最高优先级当前动作；其余活动仍在过程内可见。Subagent 数量在右侧聚合面板
继续展示，主 Transcript 只显示关键启动、完成和汇总。

## 6. 折叠行为

### 6.1 自动折叠

当且仅当以下条件同时满足时自动折叠：

1. Turn 进入明确终态。
2. 最终结论 Item 已可展示。
3. 此 Turn 尚未执行过终态自动折叠。
4. 用户没有在终态到达后主动展开该 Turn。

自动折叠只影响过程区，不隐藏用户 Prompt、最终回答、失败结论或恢复操作。

### 6.2 用户控制

- 用户可随时展开或折叠任意历史 Turn。
- 当前浏览器会话记住手动状态，SSE 更新不得把用户刚展开的 Turn 强制折回。
- 新进入页面时：运行中 Turn 默认展开；已完成 Turn 默认折叠；失败、中断和恢复态默认展开。
- 1.1 先用浏览器本地展示状态；后续可升级为飞书用户级偏好，不写入共享 Codex Home。

## 7. Steer、停止和审批

- 运行中提交输入使用 `turn/steer`，按发生时间显示为 `You · Steer`，位于同一个 Turn 过程内。
- Steer 不伪装成系统 Warning，也不创建新 Turn。
- Stop 按钮在 Turn 运行时可见；点击后立即进入 stopping 反馈，最终由协议终态决定
  `INTERRUPTED`。
- 审批请求出现在触发动作的位置；审批完成后原位更新，不在 Transcript 末尾补一张新卡。
- 外部写操作仍使用平台审批、幂等键和副作用账本。交互对齐不改变安全边界。

## 8. 前端投影模型

将当前只包含 `rows` 的 `TranscriptGroup` 升级为 Turn 级展示模型：

```ts
interface TurnTranscriptGroup {
  id: string;
  threadId: string;
  turnId: string;
  userPrompt: TranscriptMessageRow;
  status: TurnStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  activePhase: TurnDisplayPhase | null;
  executionRows: TranscriptExecutionRow[];
  finalAnswer: TranscriptMessageRow | null;
  defaultExpanded: boolean;
}

type TurnDisplayPhase =
  | "STARTING"
  | "QUEUED"
  | "THINKING"
  | "SEARCHING"
  | "READING"
  | "EDITING"
  | "RUNNING_COMMAND"
  | "USING_TOOL"
  | "DELEGATING"
  | "WAITING_APPROVAL"
  | "COMPACTING"
  | "VERIFYING";
```

`TranscriptExecutionRow` 继续复用当前安全投影，但增加：

- `presentationPhase`：过程消息或最终消息。
- `activityVerb`：确定性动作动词。
- `startedAt` / `completedAt` / `durationMs`。
- `status`：pending、running、completed、failed、declined。
- `detailTarget`：Bottom Terminal、Side Tool、Side Changes、Subagent Thread。

## 9. 后端与协议适配

优先复用当前 TaskEvent 和 ThreadItem，不为纯展示重写 Runtime：

1. 使用锁定协议已有的 `MessagePhase = "commentary" | "final_answer"`。
2. Event Normalizer 从 `item/started` / `item/completed` 的 Agent Message Item 读取 phase，并按
   `itemId` 关联不携带 phase 的 `item/agentMessage/delta`。
3. 将允许展示的 phase 加入共享合同并持久化到安全 Item payload，同时继续剥离 raw reasoning。
4. phase 为 `null` 或未知值时进入兼容展示和未知值测试，不能自动晋升为 final answer。
5. `COMMAND_STARTED/OUTPUT/COMPLETED`、`TOOL_STARTED/COMPLETED/FAILED`、审批和 Subagent
   继续按 `threadId + turnId + itemId` 合并。
6. SSE 重放和实时 SSE 必须投影出相同 Turn 结构。

当前 `Turn` 已包含 `startedAt`、`completedAt` 和 `durationMs`，计时无需新增数据库列。

## 10. 组件调整

主要修改：

- `apps/web/src/thread-presentation.ts`
  - 投影 `TurnTranscriptGroup`。
  - 分离 user prompt、execution rows 和 final answer。
  - 推导 `activePhase` 与默认折叠状态。
- `apps/web/src/components/thread/Transcript.tsx`
  - 新增 Turn Header、实时计时和折叠过程。
  - 动作行原位状态更新。
  - 最终回答在执行组外独立渲染。
- `apps/web/src/thread-events.ts`
  - 保证相同 Item 的 Delta 与生命周期事件稳定合并。
- `apps/web/src/styles.css`
  - 按 Codex 的连续文本流、弱化动作行和渐进披露调整，不新增大卡片。
- `packages/contracts` 与 `apps/api/src/infra/codex`
  - 仅在协议确有安全 message phase 时扩展合同和规范化。

## 11. 测试与验收

### 11.1 组件测试

- 运行中显示 `Working for`，计时以 `startedAt` 为基准增长。
- 当前动作随未完成 Item 变化。
- 同一 Message Delta 只形成一个连续段落。
- 同一 Command/Tool 的开始和完成只形成一个动作行。
- Tool、飞书、审批和 Subagent 不渲染独立大卡片。
- Turn 完成且最终回答出现后自动折叠。
- 最终回答永远在折叠区外。
- 用户手动展开后，后续 SSE 事件不强制折叠。
- 失败、中断、恢复态默认展开。

### 11.2 事件与安全测试

- SSE 重放与实时流生成一致展示结构。
- 未知 message phase Fail Closed，不把 raw content 当最终回答。
- raw reasoning canary 不进入 DOM、REST、SSE、SQLite、日志或审计。
- 命令 stdout/stderr 不进入主 Transcript。
- 企业 Tool 缺失 ActorContext 时仍 Fail Closed。

### 11.3 真实页面 UAT

使用真实 Codex Runtime 完成至少三类 Turn：

1. 只读分析：Thinking、Reading、最终结论和自动折叠。
2. 代码修改：叙述、命令、编辑、测试、Diff、最终结论和详情面板。
3. 企业 Tool：飞书搜索/读取、审批或 Subagent、最终汇总和审计关联。

每类都验证：

- 从提交开始计时。
- 执行中有可读流式内容和当前动作。
- 动作按真实顺序出现并原位更新。
- 完成后执行过程自动折叠。
- 最终结论独立、完整、可读。
- 展开后可以检查全部可见过程。

截图只能证明视觉行为；事件、模型、耗时、Tool 身份和敏感字段仍以 API、SSE、数据库和自动测试
作为验收证据。

## 12. 非目标

- 不展示或推断原始思维链。
- 不把命令全量输出塞入主 Transcript。
- 不改变当前账号池、ActorContext、审批和隔离策略。
- 不宣称 App Server 能安全恢复已经中断的外部副作用。
- 不为了“像 Codex”而复制 Codex 商标、品牌资产或私有实现。
