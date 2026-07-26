# 验收手册

## 验收原则

- 调度与安全规则先用无外部凭证的确定性测试验证。
- 产品流程用 `RUNTIME_MODE=fake` 验证，但明确标记为模拟。
- 真实 Codex、真实飞书 API 和真实 Feishu Tool 分开验收，避免把某一层成功误当成全链路成功。
- 任何真实外部测试只有在操作者本机实际执行并保留输出后才能记为“通过”。本文档不宣称这些外部测试已经执行成功。

## 基础验证

从仓库根目录运行：

```bash
pnpm verify
```

`pnpm verify` 覆盖 lint、typecheck、单元/集成测试、Playwright fake 产品流程、Codex 协议漂移检查和 build；它不会自动启用需要真实凭证的 smoke。

关键生命周期回归可单独运行：

```bash
pnpm exec vitest run apps/api/src/domain/platform-service.test.ts \
  -t "rejects a second active Turn|maps TURN_|immediately recovers|startup fails"

pnpm exec vitest run apps/api/src/composition.test.ts \
  -t "immediately marks persisted running Turns for recovery on restart"
```

验收要求：同一任务重复提交返回 409；完成、失败、中断分别落入明确终态；API 重启和 App Server 崩溃进入 `NEEDS_RECOVERY`、释放 Turn 槽，且不自动重放旧 Turn。

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

然后在 5 个独立浏览器 Profile/无痕上下文中，用 5 个不同且已加入应用测试范围的飞书用户登录。每人各自创建项目和任务，并在 30 分钟内提交一次 Turn。

检查：

1. 管理员账号池显示 `Codex A` 的活跃用户达到 `4 / 4`。
2. 前 4 个任务出现 `LEASE_ACQUIRED`，并展示 fake Plan、命令、Tool、Diff 和结果。
3. 第 5 个任务显示排队位置和估算 ETA，而不是静默换模型。
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

创建任务，Prompt 使用明确的 Tool 约束，例如：

```text
必须调用 feishu_wiki_search 搜索“AI 工作台”。不要调用其他工具。
请只返回搜索结果的标题、URL 和摘要，并说明总数。
```

检查：

1. 时间线出现 `feishu_wiki_search` Tool 开始/完成事件。
2. 结果只包含当前飞书用户可搜索的内容。
3. 管理员审计页出现关联当前用户、任务、Turn 和账号别名的 `TOOL_INVOKED`。
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

在 real Codex 任务中要求调用：

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
CODEX_E2E_HOME="$(pwd)/.data/runtime/codex-accounts/codex-primary" \
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

## 验收记录模板

| 项目 | Runtime | 执行时间 | 操作者 | 结果 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 5 人争抢 / 第 5 人排队 | fake + 自动测试 |  |  | 未执行 | 测试输出 / 截图 |
| 同用户 3 Turn | 自动测试 |  |  | 未执行 | 测试输出 |
| 飞书 OAuth | fake/real 共用 |  |  | 未执行 | 回调与角色截图 |
| Feishu Tool 搜索/读取 | real |  |  | 未执行 | Tool 时间线 + 审计 |
| Real Codex Smoke | real / 单 operator |  |  | 未执行 | 完整命令输出 |
| Real Feishu Smoke | direct client |  |  | 未执行 | 脱敏命令输出 |
| 凭证隔离探针 | real gate |  |  | 当前为 READABLE | 探针 JSON |

证据中不得包含 App Secret、Token、Cookie、授权 URL、`CODEX_HOME` 内文件或飞书私密正文。
