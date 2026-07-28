# CodexPlatform 1.1：Composer 权限、附件与能力菜单设计

日期：2026-07-28
状态：1.1A 已实现并验证（2026-07-29）
范围：用户端 Composer、Turn 输入、组织策略与 Codex App Server 适配

验证结论：Files/Folders、隐藏 Draft、Goal 和 sticky Plan 已通过自动化验证与真实单操作者
App Server UAT；生产恶意文件扫描、独立 Worker 和多人凭证隔离仍是后续门禁。

## 1. 决策

Composer 以 Codex 桌面端当前可观察交互为验收基准：输入区上方显示已附加上下文，底部从左到右为
`Add files and more`、执行权限、模型与 Effort、语音占位和发送/停止。外观、层级、打开方式和状态反馈
保持一致；品牌资产、私有实现和平台不具备的宿主能力不复制。

“复刻”不等于把所有菜单项做成静态入口。每个入口必须由统一 `ComposerCapability` 注册表提供，并
同时通过以下三道门：

1. Runtime 是否真实支持。
2. 组织策略是否允许。
3. 当前飞书用户、Thread 和 Worker 是否具备权限与隔离条件。

未通过的能力可以为了可理解性显示为禁用项，但必须显示准确原因，不能点击后伪造成功。

## 2. 权限菜单的真实语义

权限菜单不是一个 CSS 选项，而是对三个执行维度的组合：

| 用户选项 | Sandbox | Approval policy | Reviewer | 产品含义 |
| --- | --- | --- | --- | --- |
| Ask for approval | `workspaceWrite` | `on-request` | `user` | 工作区内可读写；外部文件、网络或越权动作请求用户审批 |
| Approve for me | `workspaceWrite` | `on-request` | `auto_review` | 与上一项相同的沙箱；由自动风险审查器处理可审查请求，不能扩大文件或网络边界 |
| Full access | `dangerFullAccess` | `never` | `user` | 不受 Codex 沙箱约束；仅在组织策略允许且 Worker 已达到隔离门禁时开放 |
| Custom | `permissions=<profileId>` | 由 profile 决定 | 由 profile 决定 | 使用管理员发布的命名 Permission Profile；不得与 `sandboxPolicy` 同时发送 |

关键规则：

- `Approve for me` 不是 Full access，也不是“所有操作都同意”。它只改变审批责任人。
- `Full access` 在 1.1A 只能由本机指定 operator 使用；生产多用户阶段的含义必须是“隔离 Worker
  内的完全访问”，绝不允许共享宿主机完全访问。
- 组织策略可以隐藏或禁用任一模式。被锁定时，菜单展示锁定原因。
- 权限选择是 Thread sticky，运行中的 Turn 锁定；Steer 沿用当前 Turn 的不可变配置快照。
- 审计记录保存用户看到的模式、展开后的 Sandbox、Approval policy、Reviewer、策略来源和是否被
  组织锁定。

## 3. Add files and more

1.1A 菜单只展示本轮真实交付的三个入口；未接入类别隐藏，不保留灰色空壳：

### 3.1 Add

- `Files and folders`：点击后展示 `Choose files / Choose folder`，支持多文件、目录和拖放。浏览器
  上传后，服务端类型/大小/路径检查并放入当前用户、当前 Thread 的隔离
  staging workspace。图片映射为 App Server `localImage`；其他文件和目录映射为受控路径引用及
  `additionalContext`，不把浏览器本地路径直接传给 Runtime。
- `Goal`：调用稳定的 `thread/goal/set|get|clear`。Goal 属于 Thread，跨 Turn 保留；支持编辑、暂停、
  恢复、完成和清除。默认 200k Token 与平台 60 分钟预算先到即暂停。
- `Plan mode`：通过锁定版本的 App Server `collaborationMode` preset 适配，属于实验接口。它为
  Thread sticky，对当前及后续新 Turn 生效，直到用户关闭；运行中不可切换。
- `Record a skill`、Plugins、Apps、Skills 和 Files and chats 本轮隐藏；只有完整纵切通过后再进入
  Capability Registry。

### 3.2 后续能力：Plugins / Skills

- 目录来自 `skills/list` 与管理员批准策略的交集。
- 点击 Skill 后在 Composer 中形成可删除的上下文 Chip，并在 `TurnStartParams.input` 中发送
  `{type:"skill", name, path}`；不能只把 Skill 名称拼到 Prompt 文本。
- Documents、PDF、Spreadsheets、Presentations 是 Skill 工作流，底层通过命令、库和文件完成，
  不是 App Server 原生 Office 对象。
- Plugin 安装、卸载和市场接口仍处于 under development，不向普通用户开放；管理员只能管理平台
  已验证目录。

### 3.3 后续能力：Apps

- 目录来自 `app/list` 与组织 Connector Policy 的交集。
- App OAuth、Scope、到期和撤销以当前飞书用户隔离；共享 Codex 账号不共享 App 授权。
- 点击 App 后形成 Mention/Connection 引用；真正调用仍由 Tool Gateway 绑定当前
  `ActorContext`。
- 类似 “Attach WeChat” 的快捷项是已安装 App/Plugin 注入项，不是所有 Codex 客户端的固定能力。

### 3.4 后续能力：Files and chats

- 展示当前飞书用户自己的 CodexPlatform Thread、已上传文件和可访问企业文档。
- App Server `thread/search` 不提供用户个人 ChatGPT 历史；平台不得跨共享账号读取或展示个人
  ChatGPT conversations。
- 搜索结果必须执行 owner ACL 和企业资源权限检查；被撤销权限的引用在提交时 Fail Closed。

## 4. 统一领域模型

```ts
type ComposerCapabilityKind =
  | "FILE_PICKER"
  | "GOAL"
  | "PLAN_MODE"
  | "SKILL_RECORDER"
  | "SKILL"
  | "APP"
  | "THREAD_REFERENCE"
  | "ENTERPRISE_RESOURCE";

interface ComposerCapability {
  id: string;
  kind: ComposerCapabilityKind;
  section: "ADD" | "PLUGINS" | "APPS" | "FILES_AND_CHATS";
  label: string;
  description: string;
  availability: "AVAILABLE" | "AUTH_REQUIRED" | "POLICY_BLOCKED" | "UNSUPPORTED";
  unavailableReason: string | null;
}

type ContextAttachmentKind =
  | "FILE"
  | "FOLDER"
  | "IMAGE"
  | "THREAD"
  | "FEISHU_DOC"
  | "APP"
  | "SKILL";

interface ContextAttachment {
  id: string;
  threadId: string;
  kind: ContextAttachmentKind;
  displayName: string;
  state: "UPLOADING" | "SCANNING" | "READY" | "AUTH_REQUIRED" | "BLOCKED" | "FAILED";
  sizeBytes: number | null;
  mediaType: string | null;
  serverReference: string | null;
  error: string | null;
}

interface ExecutionPermission {
  mode: "ASK_FOR_APPROVAL" | "APPROVE_FOR_ME" | "FULL_ACCESS" | "CUSTOM";
  sandbox: "WORKSPACE_WRITE" | "DANGER_FULL_ACCESS" | "PERMISSION_PROFILE";
  approvalPolicy: "ON_REQUEST" | "NEVER" | "PROFILE";
  reviewer: "USER" | "AUTO_REVIEW" | "PROFILE";
  profileId: string | null;
  source: "ORG_DEFAULT" | "USER_DEFAULT" | "THREAD" | "TURN";
}

interface TurnInputBundle {
  text: string;
  attachments: ContextAttachment[];
  goalAction: { type: "SET"; objective: string; tokenBudget: number | null } | null;
  planMode: boolean;
}
```

## 5. 提交与持久化

1. 用户在 `/threads/new` 选择文件或设置 Goal 时创建隐藏 Draft，不启动 Turn，也不进入历史列表。
2. 服务端完成上传、扫描、ACL 和引用解析后，状态变为 `READY`。
3. 提交时服务端重新校验所有引用、组织策略、权限模式和当前账号 Runtime capability。
4. 生成不可变 `EffectiveTurnInputSnapshot`，包含文本、引用、权限展开值、Goal/Plan 与供应商输入。
5. 先提交 Goal 变更，再调用 `turn/start`；任一步失败均不悄悄丢失或降级。
6. 首次发送时 Draft 原子转为正式 Thread；文件引用属于本 Turn；Goal 属于 Thread；权限为 Thread
   sticky；Plan mode 保持到用户关闭或组织策略变化。
7. 已发生外部写副作用的 Tool Call 不因上传、网络或 Runtime 错误自动重试。

## 6. API

```text
GET    /api/composer/capabilities?threadId=:id
POST   /api/threads/drafts
DELETE /api/threads/:id/draft
POST   /api/threads/:id/attachments
DELETE /api/threads/:id/attachments/:attachmentId
GET    /api/threads/:id/goal
PUT    /api/threads/:id/goal
PATCH  /api/threads/:id/goal
DELETE /api/threads/:id/goal
PATCH  /api/threads/:id/composer
POST   /api/threads/:id/turns
```

`POST /turns` 从只接收 `{prompt}` 演进为：

```json
{
  "prompt": "分析这些资料并给出方案",
  "permission": {
    "mode": "ASK_FOR_APPROVAL",
    "profileId": null
  },
  "planMode": false,
  "attachmentIds": ["att_..."]
}
```

后端不信任浏览器传入的路径、Sandbox、Approval policy、Reviewer、App Token 或 Tool Scope；这些值
全部由服务端根据 ID 和策略解析。

## 7. 分阶段实现

### 1.1A-P0

- Codex 式权限 Popover，真实支持 Ask for approval 与 Approve for me。
- Full access 只在本机 operator + 显式组织开关下可用。
- Custom 在存在管理员发布 profile 时出现。
- `ComposerCapability` API 和 Codex 式 Add 菜单。
- 文件/图片上传、隔离 staging、Chip、删除和 Turn 提交。
- Goal 稳定 RPC；Plan mode 实验适配并锁版本。
- Record a skill、Plugins、Apps、Skills 和历史会话引用均隐藏。

### 1.1A-P1

- Apps/Connections 用户 OAuth。
- 当前用户平台 Thread、飞书文档和已上传文件搜索。
- Skill Recorder 仅在独立 Computer Use Worker 完成后开放。

### 1.1B

- 每用户独立 Worker、独立 `CODEX_HOME`、正式 MCP Gateway 和 Credential Broker。
- Full access 限定在 Worker 边界。
- 文件扫描、DLP、保留期、跨设备同步与正式 Artifact Service。
- 组织级 Permission Profile、Plugin、App 与 Skill 发布治理。

## 8. 验收

- 权限菜单四项的说明、勾选、禁用原因和提交语义与 Codex 一致。
- Approve for me 的 Runtime 参数是 `workspaceWrite + on-request + auto_review`，不会放开网络或
  宿主文件。
- Full access 被组织禁用或 Worker 门禁未通过时无法通过 API 绕过。
- Add 菜单由 capability API 驱动，未接入项不会伪装可用。
- 用户只能上传、搜索、引用和删除自己的 Thread 上下文。
- 文件名、路径、MIME、大小、目录穿越、符号链接和超限输入均 Fail Closed。
- 图片使用 `localImage`；普通文件只引用服务端受控路径。
- Goal 跨 Turn 保留；Plan mode 只影响配置快照；运行中 Steer 不改变二者。
- 所有 Browser、日志、SSE 和审计响应均不包含本地浏览器路径、共享凭证或其他用户资源。
