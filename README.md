# CodexPlatform

CodexPlatform 1.1 是一个 Codex 式企业 AI 工作台：组织成员使用飞书具名身份登录，在连续工作区中提交任务、查看执行过程并干预当前 Turn；管理员在独立后台管理共享 Codex 账号，并查看策略、连接器、用量、审计和运行健康。

用户端的信息模型是：

```text
Project → Thread → Turn → Item
```

- `Project` 组织长期工作。
- `Thread` 是可连续多轮使用的任务上下文。
- `Turn` 是用户的一次提交及对应执行。
- `Item` 是消息、Plan、推理摘要、命令、Tool、Diff、审批、Subagent 活动或结果。

1.1 只开放 `CODEX` 模式。ChatGPT Chat / Work 是后续蓝图，在各自 Runtime 真正接入前不会显示空壳入口。

## 当前交付边界

当前仓库交付的是 **1.1A 本机纵切**：

- `fake` Runtime 是默认模式，用于确定性验证产品交互、权限和调度，不使用真实 Codex 凭证。
- `real` Runtime 已对接锁定版本 `@openai/codex@0.144.6` 的 App Server。
- 当前开发 Mac 的凭证隔离探针结果为 `READABLE`，因此真实 Codex 只允许 `FEISHU_ADMIN_OPEN_IDS` 中第一位用户操作。
- 单账号 4 名活跃用户、同一用户 2 个并行 Turn 和排队规则可在 fake Runtime/自动测试中验证，但这不等于真实多人共享已具备生产安全性。

**1.1B 尚未实现**。独立 Worker、用户级 `CODEX_HOME`、Credential Broker、正式 MCP Gateway、PostgreSQL、消息总线、KMS、HA 和真实多人生产治理都属于后续演进。

## 1.1A 已实现范围

### 用户端

- 飞书 Web OAuth、同租户限制、HttpOnly Session、CSRF 和逐用户资源 ACL。
- Codex 式用户工作区：左侧 Project/历史/Settings，中间连续对话，右侧 Plan/Outputs/Subagents/Sources，以及按需展开的 Terminal/Changes/Files/Tool details。
- `Project → Thread → Turn → Item` 的连续多轮模型；旧 `/tasks/:id` 链接保留兼容并重定向到 Thread。
- REST 命令与支持 `Last-Event-ID` 重放的 Thread SSE；消息增量仅在相同 `threadId + turnId + itemId + type` 内合并。
- 停止、继续、Steer、审批，以及 Plan、推理摘要、命令、Tool、Diff 和结果展示。
- 用户级 Settings 采用 General、Profile、Execution、Personalization、Connections、Plugins、Usage、Archived chats 八组信息架构。1.1A 中执行偏好、Personalization 和默认 Project 会进入实际流程；Profile、Connections、Usage 为只读视图，Plugins 与 Archived chats 仍是明确标注的空目录/占位，语言、主题和通知目前只持久化偏好。
- Subagent 的 Active/Done 列表、摘要、独立详情、父用户身份继承和 Thread 树用量归集。1.1A 详情以只读检查为主，不承诺直接控制任意子 Agent 或已完成生产级预算治理。
- 用户界面和普通用户 API 不返回共享账号别名、邮箱、Token、Cookie、`CODEX_HOME` 或原始 reasoning。

### 管理后台

- 与用户工作区分离的路由和导航。
- Codex 账号池、额度、活跃用户数、健康度、排空、隔离、恢复和交互登录。
- Policies、Connections/Connectors、Usage、Audit 和 Runtime health 当前提供只读组织投影；1.1A 只有 Accounts 提供添加、登录、排空、隔离和恢复写操作。
- 管理员审计可显示账号别名用于追踪，但不会返回账号凭证或 `CODEX_HOME`。
- 1.1A 尚未接入的用户目录、角色目录和生产 Worker 治理会明确标记为不可用，而不是展示虚假功能。

### Runtime、Tool 与调度

- SQLite WAL 数据层、账号/Turn 固定槽、资源感知 FIFO 排队、额度新鲜度和 30 分钟空闲租约回收。
- 已创建 Thread 对原 Codex 账号和 `CODEX_HOME` 保持粘性；不能为追求更高额度而隐式迁移。
- 恢复时只允许在 Thread 确认空闲、所有 Turn 状态均为已知终态后启动新 Turn。若发现 active/in-progress、未知或不可判定状态，1.1A 会停止并隔离账号、将受影响任务标记为 `NEEDS_RECOVERY`，同时拒绝本次新 Prompt。
- 1.1A real Runtime 在新建或恢复 Thread 后、任何 `turn/start` 前，必须成功执行 `thread/memoryMode/set` 并确认 `disabled`；调用失败或响应畸形会停止并隔离账号，不能继续执行。fake Runtime 不启动 App Server。
- Codex Thread/Turn、Steer、Interrupt、审批、Plan、命令、Diff、Tool、Subagent 和额度事件规范化。
- 真实只读飞书 Tool：`feishu_wiki_search`、`feishu_doc_read`。
- Mock Tool：只读 `demo_db_query` 和确定性 `demo_business_get`。
- Tool 始终使用当前飞书用户的 `ActorContext`，不继承共享 Codex 账号身份。
- 浏览器、持久化事件和审计只消费可展示的推理摘要；`reasoningTextDelta`、原始 `content` 和 `encrypted_content` 会被过滤。

## 快速启动（默认 fake）

前置条件：macOS、Node.js 22、pnpm 11.5.1，以及当前飞书企业中的一个自建应用。即使使用 `fake` Runtime，飞书 OAuth 配置仍是必需的。

```bash
cd /path/to/codexplatform
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
chmod 600 .env.local
```

在 `.env.local` 中至少填写：

- `FEISHU_APP_ID`、`FEISHU_APP_SECRET`
- `FEISHU_TENANT_KEY`
- `FEISHU_ADMIN_OPEN_IDS`（首位管理员的飞书 OpenID）
- `FEISHU_TOKEN_ENCRYPTION_KEY`（用 `openssl rand -base64 32` 生成）

保留 `RUNTIME_MODE=fake`，然后启动：

```bash
pnpm dev
```

浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。飞书登录后会直接进入 Codex 工作区；没有 Project 时可从 New chat 开始。默认数据库和运行目录分别位于仓库根目录的 `.data/codexplatform.sqlite` 与 `.data/runtime`。

飞书后台的权限、回调地址和发布步骤见 [飞书配置](docs/feishu-setup.md)。

## 切换真实 Codex

1. 先完成 fake 模式的飞书登录和基础验收。
2. 不要复用 fake 的数据库和运行目录。在 `.env.local` 同时设置：

   ```dotenv
   RUNTIME_MODE=real
   DATABASE_PATH=/absolute/path/to/codexplatform/.data/real-codexplatform.sqlite
   RUNTIME_DATA_DIR=/absolute/path/to/codexplatform/.data/real-runtime
   ```

   真实模式强制要求这两个值是绝对路径，防止切换 worktree 时意外连接新空数据库。并确认 `CODEX_BIN` 指向仓库锁定的 `node_modules/.bin/codex`。数据库与运行目录通过双向绑定标记组成同一存储环境；缺失、复制或混用时服务会 fail closed。
3. 重新执行 `pnpm dev`。服务启动时会自动运行凭证隔离探针。
4. 复用同一数据库时，30 天可信设备 Session 会保留；只有新数据库、Session 到期或主动退出时才需要重新完成飞书 OAuth。
5. 首位管理员进入管理后台的 Accounts 页面，对预置 `Codex A` 点击“重新认证”，亲自在浏览器完成 ChatGPT/Codex 登录。
6. 确认认证状态和周额度后，由首位管理员提交一个无外部写操作的小任务。

完整步骤与 `READABLE` 门禁解释见 [安全与运维手册](docs/security-and-operations.md#首个-codex-账号交互登录)。

## 验证

不需要外部凭证的主验证命令：

```bash
pnpm verify
```

真实 Codex 和真实飞书 Smoke Test 都是显式门禁测试，默认跳过；存在测试代码不代表外部链路已经跑通。只有实际执行并保留成功输出后，才能把对应链路标记为已验证。命令见 [验收手册](docs/acceptance.md#真实外部-smoke-test)。

## 文档

- [CodexPlatform 1.1 产品与技术方案](docs/codexplatform-1.1-product-and-technical-spec.md)
- [架构与数据流](docs/architecture.md)
- [飞书配置](docs/feishu-setup.md)
- [安全、Codex 登录、故障恢复与已知限制](docs/security-and-operations.md)
- [产品、调度、Tool 与真实 Smoke 验收](docs/acceptance.md)

## 证据边界

本文描述仓库当前实现和可执行验收路径，不把未运行的真实 Codex/飞书测试、规划中的 1.1B 或 UI 占位状态写成已交付能力。共享人类账号是否允许、是否覆盖后台凭证托管与多人调度，仍需以 OpenAI 书面许可为上线前置条件；代码中的 4 人槽位不能替代合规许可或生产级隔离。
