# 验收手册

## 验收原则

- 调度与安全规则先用无外部凭证的确定性测试验证。
- 产品流程用 `RUNTIME_MODE=fake` 验证，但明确标记为模拟。
- 1.1 验收对象是 `Project → Thread → Turn → Item` 的连续工作区，不再以旧版静态任务时间线作为通过标准。
- Transcript 是 Item 事件流的可读产品投影，不是原始事件日志：命令只能在正文显示活动摘要，完整 stdout/stderr 只能进入 Bottom Panel；Tool 与 Diff/文件详情由活动行打开 Side Panel。
- Pinned Summary、Side Panel 和 Bottom Panel 是三个相互独立的工作表面；能分别打开、共存和关闭才算通过。Pinned 使用 `displayTurn = activeTurn ?? latestTurn`，不能把其他历史 Turn 的 Output/Source 误报成当前进展。
- 用户端、个人 Settings 和管理后台分别验收；管理员能看到的数据不能据此推断普通用户也能看到。
- 可展示的推理摘要与原始 reasoning 分开验收：摘要可以出现，`reasoningTextDelta`、原始 `content` 和 `encrypted_content` 不得进入浏览器、事件、日志或审计。
- 真实 Codex、真实飞书 API 和真实 Feishu Tool 分开验收，避免把某一层成功误当成全链路成功。
- 任何真实外部测试只有在操作者本机实际执行并保留输出后才能记为“通过”。本文档不宣称这些外部测试已经执行成功。
- 1.1A Fake 可模拟多人调度；1.1A Real 仅允许指定 operator；真实多人只属于通过全部门禁后的
  1.1B，三类证据不得混写。

## 基础验证

从仓库根目录运行：

```bash
pnpm verify
```

`pnpm verify` 覆盖 lint、typecheck、单元/集成测试、Playwright fake 产品流程、Codex 协议漂移检查和 build；它不会自动启用需要真实凭证的 smoke。

### 2026-07-27 自动基线与真实页面复读

- 代码基线：`02b44fe`（Runtime 路径脱敏）+ `026722b`（Codex 工作区收敛）。
- `pnpm verify`：PASS；450 项 Vitest 通过、2 项条件跳过，11 项 Playwright 通过，协议校验与
  Production Build 通过。
- 已认证的 1.1A Real 页面复读：真实模型目录包含 GPT-5.6-Sol / Terra 与对应 Effort；Pinned
  Summary、Side Panel、Bottom Terminal 同时存在；Subagent Active/Done 与独立 Transcript 可读。
- 旧历史命令中的账号 Runtime 路径已在 DOM 中替换为 `[CODEX_HOME]`，未检测到
  `.data/real-runtime`、`codex-accounts` 或真实账号目录。
- 本次没有启动第二个 App Server，因此没有重复执行 `REAL_CODEX_E2E=1`；这避免两个进程争用同一
  `CODEX_HOME`。Real Smoke 与凭证隔离探针仍按下表保持“未执行”。

### 2026-07-27 Real HTTPS 传输回归

- 复现任务 `3b21f413-77cc-46c0-8dfb-6833ca711184` 的 Turn 用时 124.4 秒；事件明确记录
  `Falling back from WebSockets to HTTPS transport. request timed out`，首个模型输出在约 110 秒后出现。
- Runtime 改为 HTTPS-only Provider 后，最终配置回归任务
  `e1d5f48e-3734-4d0e-9481-fff24562d199` 使用 GPT-5.6-Sol 正常返回
  `REAL_HTTPS_COMPACTION_OK`；Turn 用时 8.25 秒，首个文本约 7.2 秒出现。
- 最终 Provider ID 为 `codexplatform_openai_https`，名称保持官方精确值 `OpenAI`，避免关闭长 Turn
  所需的 OpenAI 远端上下文压缩判定。
- 回归任务事件包含 Lease、Turn、Agent Delta、Token Usage 和完成事件，不包含 WebSocket 回退；
  浏览器 DOM 显示真实模型、完成状态和最终回复。
- 该回归证明当前单操作者真实链路的 transport 修复，不替代完整 `REAL_CODEX_E2E=1`、
  凭证隔离探针或真实多人门禁。

### 2026-07-28 Composer 权限与能力注册表纵切

- `pnpm verify`：PASS；510 项 Vitest 通过、2 项条件跳过，12 项 Playwright 通过，协议校验与
  Production Build 通过。
- `ASK_FOR_APPROVAL`、`APPROVE_FOR_ME`、`FULL_ACCESS` 和 `CUSTOM` 已有统一契约；App Server
  参数映射由 Runtime 单测逐字段核验。当前组织策略只开放前两档，`FULL_ACCESS` 与 `CUSTOM`
  在 Composer 中可见但不可选，并显示门禁原因。
- `GET /api/composer/capabilities` 按当前飞书用户和 Thread 返回服务端能力真值；浏览器不能自行把
  Files、Goal 或 Plan 标记成可用。本轮只交付这三项，其余 Add 类别隐藏。
- Files、隐藏 Draft、Goal 和 Plan 处于实施中；本节只定义验收，不代表已交付。通过自动测试、
  浏览器 UAT、真实 App Server 参数复核和数据复核后，才补充执行证据。
- Playwright 已验证权限菜单选择 `Approve for me` 后，保存的 Turn 配置快照为
  `permissionMode=APPROVE_FOR_ME`；同时验证 Full access 与四个 Add 能力的禁用状态。
- 视觉 UAT 产物名为 `composer-add-menu.png` 和 `composer-permissions.png`，由
  `CODEXPLATFORM_CAPTURE_UAT=1` 生成在 Playwright 输出目录；截图只证明 Fake Runtime 页面结构，
  不替代真实飞书登录和 Real Runtime Smoke。

关键生命周期回归可单独运行：

```bash
pnpm exec vitest run apps/api/src/domain/platform-service.test.ts \
  -t "rejects a second active Turn|fails closed when an existing Thread|quarantines a typed active-resume conflict|immediately recovers|startup fails"

pnpm exec vitest run apps/api/src/composition.test.ts \
  -t "immediately marks persisted running Turns for recovery on restart"

pnpm exec vitest run apps/api/src/infra/codex/app-server-execution-adapter.test.ts \
  -t "fails closed when resume rejoins an active Turn|fails closed when an idle resume response still contains an in-progress Turn|detaches a crashed account boundary and delegates persisted recovery once"
```

验收要求：同一 Thread 重复提交 active Turn 返回 409；完成、失败、中断分别落入明确终态；API 重启和 App Server 崩溃进入 `NEEDS_RECOVERY`、释放 Turn 槽，且不自动重放旧 Turn。恢复响应不能证明 Thread 空闲时，必须拒绝新 Prompt、隔离账号，不能再次调用 `turn/start`。

## 1.1 产品与交互验收

### 自动验收

```bash
pnpm exec vitest run \
  apps/web/src/v11-app.test.tsx \
  apps/web/src/components/thread/SafeMarkdown.test.tsx \
  apps/web/src/thread-presentation.test.ts \
  apps/web/src/thread-events.test.ts \
  apps/web/src/api.test.ts \
  apps/api/src/server-api.test.ts \
  apps/api/src/domain/platform-store.test.ts \
  apps/api/src/infra/codex/event-normalizer.test.ts

pnpm test:e2e
```

自动证据由 Vitest 和 Playwright 共同组成。Playwright 默认使用隔离的
`127.0.0.1:5174` / `127.0.0.1:4311`，并注入测试 Session Cookie；它不会复用日常开发服务，也不执行真实飞书 OAuth。`server-api.test.ts` 使用 Fake AuthProvider 验证 OAuth state、回调和 Cookie 协议，真实飞书授权仍属于手工/外部 Smoke 验收。

组合后的自动证据验证：

1. `/api/bootstrap` 仅开放 `CODEX`；用户端不出现 ChatGPT Chat / Work 空壳。
2. 已认证 Session 进入 Codex 用户工作区后，存在 New chat、Projects、历史、Settings、连续 Transcript 与 Composer；Pinned Summary、Side Panel、Bottom Panel 可独立打开。
3. 第 2 个 Prompt 在同一 Thread 中形成新的 Turn，旧 Turn 和执行证据仍可见。
4. 组件测试验证 legacy `/tasks/:id` 跳转到 `/threads/:id`。
5. Playwright 选择 Runtime 返回的模型和该模型支持的 Effort，并从保存后的 Turn 配置快照核对
   `model` / `effort`；权限菜单选择 `Approve for me` 后同样从快照核对
   `permissionMode=APPROVE_FOR_ME`，不以按钮文案代替生效证据。
6. Playwright 验证 Plan、命令、Tool、Diff 和结果 Item；Transcript 不出现命令原始输出，命令活动行打开 Bottom Panel Terminal，且多条命令按 Item 分块而不是拼接；Tool 与 Diff/文件活动行打开带标题和返回入口的 Side Panel 详情。
7. 组件/API 测试验证审批 Item；事件测试验证 SSE 增量只在相同 `threadId + turnId + itemId + type` 内合并。
8. Subagents 在 Side Panel 展示 Active / Done，能打开独立只读 Transcript；其完整命令输出仍只进入 Bottom Terminal，其他用户不能读取。
9. Settings 使用批准的 8 个个人分组并按测试用户保存；只读和占位分组不会伪装为已接入能力。
10. 管理后台使用独立壳和导航；普通成员没有入口，直接访问管理 API 返回拒绝。
11. 服务/Adapter 测试验证 active Turn 恢复冲突会拒绝 Prompt 并隔离账号；组件测试验证排队或请求 pending 时不能重复提交。
12. 普通用户 Thread、SSE、DOM、浏览器控制台和兼容 Task 响应中没有共享账号别名、凭证、`CODEX_HOME` 绝对路径或 raw reasoning canary；该断言必须使用真实路径形态哨兵，而不能只搜索字符串键名。
13. 用户、Agent 和推理摘要的粗体、列表、代码块、表格能够按安全 Markdown 呈现；原始 HTML、`javascript:` 链接和远程 Markdown 图片不会执行或加载。
14. 不存在下载路由的 `/api/artifacts/*` 不显示为可点击链接；Output/Source 名称、URI 和 citation
    不得暴露任意本机绝对路径。
15. 不存在独立 Continue 按钮或自动固定 Prompt；终态后的后续执行必须来自用户 Composer 输入。

### 手工产品 UAT

使用 `RUNTIME_MODE=fake` 启动后：

1. 用飞书登录，确认直接进入 `/threads/new`。
2. 打开 “Add files and more”，确认只显示 Files、Goal、Plan；Record skill、Plugins、Apps、
   Skills 和历史会话引用不出现。
3. 选择文件和目录，确认上传/扫描 Chip、删除、重选、拖放和纯附件提交可用；Draft 不进入历史列表。
4. 设置 Goal 并完成至少两个 Turn，确认目标跨 Turn 保留；验证暂停、恢复、编辑、完成和清除。
5. 开启 Plan mode，确认图标和菜单选中态同步；活动 Turn 中禁止切换，真实 Runtime 参数包含
   锁定目录返回的 collaboration preset。
6. 打开权限菜单，确认 Ask for approval 与 Approve for me 可选，Full access 与 Custom 禁用；选择
   `Approve for me`。
7. 打开 Composer 的 Model / Effort 选择器：选择 `Fake Deep` 后默认 Effort 应切换到 `high`，再选择 `xhigh` 并提交。
8. Turn 完成后读取 `/api/threads/:id`，确认该 Turn 的 `model=fake-codex-deep`、`effort=xhigh`、
   `configSnapshot.permissionMode=APPROVE_FOR_ME`；只看选择器文案不能判定通过。
9. 确认 Transcript 连续展示用户消息、Plan 更新、命令/Tool/Diff 活动摘要和最终回复；Markdown 粗体与代码应正确渲染，正文中不得出现独立的 `fake-codexplatform` 原始输出。
10. 点击命令活动行打开 Bottom Panel 的 Terminal，确认其中能看到 `fake-codexplatform`；Bottom Panel 不出现 Changes、Files 或 Tool details 标签。
11. 依次打开 Pinned Summary、Side Panel 和 Bottom Panel，确认三者同时可见；单独关闭 Pinned Summary 后，Side 与 Bottom 仍保持打开。
12. Side Panel 切换 Plan、Outputs、Subagents、Sources；再分别点击 Transcript 的 Tool 与 Diff/文件活动行，确认 Side Panel 进入对应详情并能返回父 Tab。Pinned Summary 打开时不改变正文宽度，Side Panel 打开时才压缩正文。
13. 在同一 Composer 提交第 2 个 Prompt，确认 URL 和 Thread 不变、两轮内容连续。
14. 进入 Settings，修改 Theme 或默认 Model / Effort，保存并刷新，确认值仍属于当前飞书用户。
15. 管理员进入独立 `/admin/accounts`，检查 Accounts、Policies、Connectors、Usage、Audit 和 Runtime health；再返回用户工作区。
16. 在浏览器 Network 中检查 `/api/threads/:id` 和 SSE：用户侧不得出现账号别名、raw reasoning、`.data/real-runtime/codex-accounts/` 或真实 `CODEX_HOME` 路径；管理员审计可出现账号别名但不能出现凭证路径。

fake UAT 证明的是交互和投影，不证明真实 Codex、多用户凭证隔离或真实飞书 Tool 已通过。

### P0 浏览器验收快速命令

```bash
pnpm exec playwright test tests/e2e/workspace.spec.ts \
  --grep "governed Composer capabilities|Pinned, Side, and Bottom|reasoning canaries"
```

该 Playwright 快速命令覆盖以下 P0 门禁：

1. 模型选择与 Effort 联动真实进入 Turn 配置快照。
2. Pinned / Side / Bottom 三表面独立共存。
3. 命令原始输出不进入 Transcript、仅在 Bottom Panel Terminal 可见；Tool 与 Diff/文件详情进入 Side Panel。
4. Thread JSON、SSE replay、实时 SSE、DOM 和浏览器消息均不含 raw reasoning canary。

安全 Markdown、Output/Source URI、raw reasoning 持久化和 Runtime 路径历史回放由上方列出的
`SafeMarkdown.test.tsx`、`thread-presentation.test.ts`、`platform-store.test.ts`、
`event-normalizer.test.ts` 与 `server-api.test.ts` 验证，不能把未包含这些用例的 Playwright
grep 结果当作相应证据。

需要保留浏览器截图时运行：

```bash
CODEXPLATFORM_CAPTURE_UAT=1 pnpm test:e2e
```

截图只能作为交互证据；模型与 Effort 仍以 API 配置快照为准，raw reasoning 仍以自动 canary 断言为准。

## Thread、Settings 与 Subagent 数据边界

```bash
pnpm exec vitest run apps/api/src/domain/platform-service.test.ts \
  -t "projects legacy tasks as owned continuous Threads|reconstructs every completed Turn|isolates Settings|immutable effective Settings|persists observable subagent summaries|aggregates the owned Thread tree"

pnpm exec vitest run apps/api/src/server-api.test.ts \
  -t "keeps Thread, subagent and settings access fail-closed|projects Thread events without raw reasoning or shared account aliases|keeps every new admin endpoint admin-only"
```

验收结果：

- Thread 以创建顺序重建所有 Turn，每个 Turn 保留不可变配置快照。
- 组织默认、用户 Settings、Thread override 和 Turn override 合并后不得突破组织强制策略。
- 用户 A 的 Settings、Thread、Subagent 和 SSE 对用户 B 返回 404/403，不发生跨用户回退。
- Subagent 继承父 Turn 的 `ActorContext`，父子用量归集到所属 Thread 树；共享账号额度不能伪装为个人精确用量。
- 推理摘要可以显示，但不得写成 `audit_events` 的审计依据；raw reasoning 和共享账号别名在用户投影中被移除。
- 1.1A 仅验收 Subagent 可观测与身份继承，不把独立 Worker、硬预算执行器或直接子 Agent 控制记为已完成。

## 账号粘性、排队与恢复

```bash
pnpm exec vitest run apps/api/src/domain/lease-store.test.ts \
  -t "required account|earliest runnable|does not let a new request"

pnpm exec vitest run apps/api/src/infra/db/migrate.test.ts \
  -t "required account affinity|backfilled runtime account"
```

验收结果：

- 已创建 Thread 的后续 Turn 只能使用原账号，排队记录也持久化 `requiredAccountId`。
- 老数据库迁移会为已有 Runtime 账号的等待 Thread 回填账号粘性；无法确定绑定时 fail closed。
- 某账号上的不可运行队首不会永久阻塞其他账号的可运行等待项。
- 新请求不能绕过更早且可运行的兼容排队项。
- 恢复到 active/in-progress、未知、格式错误或系统错误状态时，不启动第二个 Turn；账号进入隔离，受影响 Turn 进入 `NEEDS_RECOVERY`。
- 1.1A real Runtime 新建和恢复 Thread 时，均在任何 `turn/start` 前成功下发
  `thread/memoryMode/set { mode: "disabled" }`；RPC 拒绝、`null`、数组或带未知字段的响应都会
  fail closed，且不会发起 Turn。

## 5 人争抢一个账号

### 确定性自动验收

```bash
pnpm exec vitest run apps/api/src/domain/lease-store.test.ts \
  -t "grants four unique users and queues the fifth on a single account"

pnpm exec vitest run apps/api/src/domain/platform-service.test.ts \
  -t "releases an idle account-user slot after 30 minutes and starts the fifth user"
```

验收结果：

- 前 4 个不同用户获得同一个账号的 4 个用户槽。
- 第 5 个用户得到 `ACCOUNT_USER_LIMIT`，排队位置为 1。
- 前 4 人结束 Turn 后仍保留用户槽，直到 30 分钟无运行任务。
- 空闲槽释放后，第 5 人从 FIFO 队首自动获得租约并使用原 Prompt 启动。

### fake 产品流程验收

为避免旧租约干扰，可使用独立验收数据库启动：

```bash
DATABASE_PATH="$(pwd)/.data/acceptance.sqlite" \
RUNTIME_DATA_DIR="$(pwd)/.data/acceptance-runtime" \
RUNTIME_MODE=fake \
pnpm dev
```

然后在 5 个独立浏览器 Profile/无痕上下文中，用 5 个不同且已加入应用测试范围的飞书用户登录。每人各自创建 Project 和 Thread，并在 30 分钟内提交一次 Turn。

检查：

1. 管理员账号池显示 `Codex A` 的活跃用户达到 `4 / 4`。
2. 前 4 个 Thread 出现 `LEASE_ACQUIRED`，并展示 fake Plan、命令、Tool、Diff 和结果。
3. 第 5 个 Thread 显示排队位置和估算 ETA，而不是静默换模型。
4. 这次验收记录必须注明“fake Runtime 调度模拟”，不能写成“真实 Codex 4 人共享通过”。

由于 fake Turn 很快完成，手工等待 30 分钟验证提升效率较低；FIFO 自动提升应以上面的确定性测试作为首要证据。

## 同一用户 3 个并行 Turn

### 确定性自动验收

```bash
pnpm exec vitest run apps/api/src/domain/lease-store.test.ts \
  -t "two turns from one user share a user slot and a third turn queues"

pnpm exec vitest run apps/api/src/domain/platform-service.test.ts \
  -t "starts the FIFO head automatically when a running turn releases capacity"
```

验收结果：

- 同一用户的前 2 个 Turn 复用同一个账号用户槽，占用 Turn 槽 0 和 1。
- 账号占用是“1 名活跃用户、2 个活跃 Turn”，而不是 2 名用户。
- 第 3 个 Turn 以 `USER_TURN_LIMIT` 排队。
- 任意一个 Turn 完成后，第 3 个从队首自动启动。

fake Runtime 的 Turn 会立即完成，浏览器手工提交很难稳定制造 3 个真正同时运行的 Turn，因此不要用偶发 UI 时序替代上述自动测试。

## Feishu Tool 端到端验收

这个验收需要：

- 完成真实飞书 OAuth 和真实 Codex 交互登录。
- `RUNTIME_MODE=real`。
- 当前开发 Mac 为 `READABLE` 时，只能由首位 operator 执行。
- operator 在飞书中确实有权读取一份 Wiki/Docx 测试文档。

### 搜索

创建 Thread，Prompt 使用明确的 Tool 约束，例如：

```text
必须调用 feishu_wiki_search 搜索“AI 工作台”。不要调用其他工具。
请只返回搜索结果的标题、URL 和摘要，并说明总数。
```

检查：

1. 对话中出现 `feishu_wiki_search` Tool 开始/完成 Item。
2. 结果只包含当前飞书用户可搜索的内容。
3. 管理员审计页出现关联当前用户、Thread 和账号别名的 `TOOL_INVOKED`；SQLite 内部审计与事件记录可继续关联到平台 Turn。
4. 浏览器响应、日志和审计中没有 access token。

### 读取

把当前用户可读的 Wiki 或 Docx URL 放入 Prompt：

```text
必须调用 feishu_doc_read 读取下面的飞书文档，不要调用其他工具：
https://example.feishu.cn/wiki/replace-with-test-node

返回标题、revisionId、前三个非空文本块，并保留每段 citation。
```

检查返回的 `url`、`revisionId`、文本和 `#blockId` 引用。再用一条当前用户无权限的测试 URL 重试，预期是明确失败且不泄露标题或正文，而不是使用共享 Codex 身份越权读取。

注意：当前只支持 Wiki 指向的 Docx 和直接 Docx URL；Sheet/Base/Slides 不在本轮范围。

## Demo Tool 验收

在 real Codex Thread 中要求调用：

```text
调用 demo_db_query，SQL 必须是：
SELECT id, status, amount_cents FROM demo_orders
```

预期返回 `order-1`。再分别尝试 `DELETE`、多语句、`sqlite_master` 或未授权表，预期全部失败。

业务 Mock：

```text
调用 demo_business_get，resource=order，id=order-1。
```

预期结果带 `source: "mock"`，不得当作真实业务系统数据。

## 真实外部 Smoke Test

### Real Codex Smoke

先按 [首个 Codex 账号交互登录](security-and-operations.md#首个-codex-账号交互登录)完成认证。运行 smoke 前停止 `pnpm dev`，避免两个 App Server 同时使用一个 `CODEX_HOME`。

```bash
REAL_CODEX_E2E=1 \
CODEX_E2E_HOME="$(pwd)/.data/real-runtime/codex-accounts/codex-primary" \
CODEX_BIN="$(pwd)/node_modules/.bin/codex" \
pnpm test:real-codex
```

测试会：

1. 验证账号目录和 Codex binary 存在。
2. 启动固定版本 App Server。
3. 读取周额度，允许结果为已知或 `WEEKLY_QUOTA_UNKNOWN`。
4. 在临时工作区创建 Thread，提交一个禁止 Tool/文件修改的 Turn。
5. 断言最终回复包含 `CODEX_SMOKE_OK`。

命令没有实际成功输出前，状态只能写“未执行”或“失败”，不能写“真实 Codex 已接通”。

### Real Feishu Smoke

该测试直接验证 `FeishuContentClient` 的搜索和读取，不经过 Codex。使用专用测试用户的临时 OAuth access token；不要把 Token 写在命令行参数、Git、聊天或截图中。

在 macOS 默认 zsh 中：

```bash
export REAL_FEISHU_E2E=1
export FEISHU_E2E_DOCUMENT_URL='https://example.feishu.cn/wiki/replace-with-readable-node'
export FEISHU_E2E_SEARCH_QUERY='AI'
read -s "FEISHU_E2E_USER_ACCESS_TOKEN?Feishu user access token: "
export FEISHU_E2E_USER_ACCESS_TOKEN
pnpm test:real-feishu
unset FEISHU_E2E_USER_ACCESS_TOKEN
```

测试会：

1. 用当前用户 Token 搜索文档/Wiki，最多取 1 条。
2. 解析指定 Wiki/Docx URL。
3. 读取 metadata、revision 和分页 blocks。
4. 在错误信息中替换当前 Token。

完成后清理 Shell 环境和终端滚屏。测试通过只证明该 Token 的 Feishu Client 链路，不证明 Codex Dynamic Tool、另一名用户权限隔离或真实共享账号已通过。

真实 Refresh Token 轮换使用同一命令的独立门禁。先停止 API，避免与后台刷新循环竞争，然后复用平台真实数据库和 `.env.local`：

```bash
export REAL_FEISHU_REFRESH_E2E=1
export DATABASE_PATH=/absolute/path/to/real-codexplatform.sqlite
pnpm test:real-feishu
```

该 Smoke 不输出或导出 Token；它通过平台 AES-GCM SecretStore 解密当前活跃用户凭证，调用飞书刷新接口，并在同一数据库事务中验证新 Refresh Token、到期时间和 `CONNECTED` 状态。完成后重新启动 API。

## 验收记录模板

| 项目 | Runtime | 执行时间 | 操作者 | 结果 | 证据 |
| --- | --- | --- | --- | --- | --- |
| CODEX-only 用户端 / 连续 2 Turn | fake | 2026-07-27 | Codex | 自动通过 | Playwright |
| Runtime 模型 / Effort 联动与配置快照 | fake + real 页面复读 | 2026-07-27 | Codex | 通过 | Playwright + 真实 DOM |
| Pinned / Side / Bottom 独立共存 | fake + real 页面复读 | 2026-07-27 | Codex | 通过 | Playwright + 真实 DOM |
| Transcript 摘要 / Terminal 原始输出 / Side 详情隔离 | fake + 自动测试 | 2026-07-27 | Codex | 自动通过 | Playwright / Vitest |
| 用户 Settings 隔离与持久化 | fake + 自动测试 | 2026-07-27 | Codex | 自动通过 | Playwright |
| Subagent Active/Done / 详情 / ACL | fake + real 页面复读 | 2026-07-27 | Codex | 通过 | 自动测试 + 真实 DOM |
| 独立管理后台与成员拒绝 | fake + 自动测试 | 2026-07-27 | Codex | 自动通过 | Playwright |
| 用户侧账号别名 / raw reasoning 脱敏 | 自动测试 | 2026-07-27 | Codex | 自动通过 | API / SSE / DOM canary |
| Runtime / `CODEX_HOME` 路径持久化与回放脱敏 | 自动测试 + real 页面复读 | 2026-07-27 | Codex | 通过 | store / API / SSE 哨兵 + 真实 DOM |
| Real Codex HTTPS-only 首包与完成 | real / 单 operator | 2026-07-27 | Codex | 通过 | 真实 DOM + SQLite 事件时间戳 |
| Output / Source URI 与本机路径安全 | 自动测试 | 2026-07-27 | Codex | 自动通过 | projection 测试 |
| Token 不进入 SQLite / 日志 / 异常 | 自动测试 | 2026-07-27 | Codex | 自动通过 | secret canary 测试 |
| 1.1A Real 非 operator 拒绝 | real gate + 自动测试 | 2026-07-27 | Codex | 自动通过 | composition / safety gate 测试 |
| active Turn fail-closed | 自动测试 | 2026-07-27 | Codex | 自动通过 | adapter / service 测试 |
| 5 人争抢 / 第 5 人排队 | fake + 自动测试 | 2026-07-27 | Codex | 自动通过 | lease / service 测试 |
| 同用户 3 Turn | 自动测试 | 2026-07-27 | Codex | 自动通过 | lease / service 测试 |
| 飞书 OAuth | fake/real 共用 |  |  | 未执行 | 回调与角色截图 |
| Feishu Tool 搜索/读取 | real |  |  | 未执行 | Tool 时间线 + 审计 |
| Real Codex Smoke | real / 单 operator |  |  | 未执行 | 完整命令输出 |
| Real Feishu Smoke | direct client |  |  | 未执行 | 脱敏命令输出 |
| 凭证隔离探针 | real gate |  |  | 未执行 | 带时间与 commit 的脱敏探针 JSON |

证据中不得包含 App Secret、Token、Cookie、授权 URL、`CODEX_HOME` 内文件或飞书私密正文。
