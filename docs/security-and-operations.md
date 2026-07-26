# 安全与运维手册

## 安全门禁结论

当前开发 Mac 上，Codex `:workspace` 沙箱仍能读取同一 OS 用户下、权限为 `0700` 的独立 `CODEX_HOME` 中的 `0600` 哨兵文件。探针状态因此为：

```json
{
  "status": "READABLE",
  "safeForMultiUser": false,
  "evidence": "SANDBOX_READ_SENTINEL"
}
```

这意味着目录权限只能避免其他 OS 用户读取，不能把同一 OS 用户下的多个 Codex Worker 相互隔离。当前 real 模式采用 fail-closed：

- `FEISHU_ADMIN_OPEN_IDS` 第一项对应的内部用户是唯一 operator，可执行真实 Codex。
- 其他飞书用户在获取账号租约前被拒绝，不会占用账号槽。
- fake 模式仍可验证 4 人调度，但不接触真实 Codex 凭证。
- 只有探针变为 `ISOLATED`，并且 OpenAI 书面许可覆盖共享、后台凭证托管、自动调度和并发人数后，才可讨论真实多人开放。

这也是 1.1A 与 1.1B 的硬边界：

| 阶段 | 当前状态 | 安全结论 |
| --- | --- | --- |
| 1.1A fake | 已实现 | 可验证用户端、管理后台、ACL、调度和事件；不验证真实凭证隔离 |
| 1.1A real | 已实现单操作者门禁 | 仅首位管理员可运行真实 Codex |
| 1.1B | 规划 | 独立 Worker、用户级 `CODEX_HOME`、Credential Broker、正式 MCP Gateway、KMS/HA 尚未实现 |

服务每次以 `RUNTIME_MODE=real` 启动时都会运行探针。也可手工复核：

```bash
mkdir -p .data/runtime/workspaces
pnpm tsx scripts/security-probe.ts \
  --binary "$(pwd)/node_modules/.bin/codex" \
  --workspace "$(pwd)/.data/runtime/workspaces"
```

退出码 `0` 只代表本次结果为 `ISOLATED`；`READABLE` 或执行错误都会以退出码 `1` 关闭多人门禁。不要通过改数据库、跳过探针或把 `READABLE` 当作告警后继续共享。

## 首个 Codex 账号交互登录

### 前置检查

1. fake 模式已能用首位管理员完成飞书登录。
2. `.env.local` 中 `CODEX_BIN` 指向锁定的 0.144.6 binary。用根目录启动时，示例值 `../../node_modules/.bin/codex` 会从 `apps/api` 解析到仓库根目录。
3. `FEISHU_ADMIN_OPEN_IDS` 第一项就是准备执行真实任务的用户 OpenID。
4. 本次使用符合 OpenAI 的许可和组织内部审批。软件不会替你验证合同。

确认版本：

```bash
./node_modules/.bin/codex --version
```

预期为：

```text
codex-cli 0.144.6
```

### 登录流程

1. 不要复用 fake 的数据库和运行目录；将 `.env.local` 同时改为：

   ```dotenv
   RUNTIME_MODE=real
   DATABASE_PATH=../../.data/real-codexplatform.sqlite
   RUNTIME_DATA_DIR=../../.data/real-runtime
   ```

   数据库与运行目录会通过数据库设置及权限为 `0600` 的 `.codexplatform-binding.json` 双向绑定；任一侧缺失、复制或混用时服务会 fail closed。升级前的本机数据库只在能够明确识别原 runtime mode 时自动收养，无法判断时要求使用新的成对路径。
2. 执行 `pnpm dev`，等待 API 日志出现 ready；启动日志会同时记录探针状态。
3. 新数据库没有旧 Session，重新完成飞书 OAuth。
4. 用首位管理员飞书账号进入独立管理后台的 Accounts 页面：[http://127.0.0.1:5173/admin/accounts](http://127.0.0.1:5173/admin/accounts)。
5. 预置账号 `Codex A` 初始为 `REAUTH_REQUIRED`。点击“重新认证”。
6. 浏览器会转到 Codex 返回的 ChatGPT 登录 URL。由管理员亲自完成登录；不要复制 Cookie、Token 或授权 URL 给其他人。
7. 登录完成后回到账号池并刷新。后端收到 `account/login/completed` 后会把账号标为已认证，并读取周额度。
8. 周额度显示为有效剩余比例后，首位管理员创建一个无外部写操作的小任务。

默认账号目录是：

```text
.data/real-runtime/codex-accounts/codex-primary
```

目录和账号文件只应由后端进程访问，不要把它压缩、上传或通过浏览器暴露。不要同时开启多个重复登录流程；Token 刷新由该账号唯一的长期 App Server 进程承担。

### 登录后的异常判断

| 现象 | 处理 |
| --- | --- |
| 版本不等于 0.144.6 | 重新 `pnpm install --frozen-lockfile`，检查 `CODEX_BIN`，不要绕过版本锁 |
| 探针为 `ERROR` | 检查 binary 和 workspace 路径；它与 `READABLE` 一样关闭多人 |
| 登录完成但仍为 `REAUTH_REQUIRED` | 保持 API 进程运行，重试一次交互登录；检查 App Server 日志 |
| 周额度为“待确认” | App Server 没有返回精确 7 天桶；当前 UI/API 没有未知额度放行开关，账号不能获得新租约 |
| 非首位管理员收到 403 | 当前 `READABLE` 门禁的预期行为，不是调度故障 |
| 额度读取失败后变为 `QUARANTINED` | 先修复认证/网络/协议问题，再由管理员恢复；不要直接反复恢复 |

## 已实施的安全控制

- API 和 Web 仅允许 loopback；配置会拒绝公网/LAN host 或 origin。
- 飞书 access/refresh token 使用 AES-256-GCM 加密后保存，密钥只放在权限为 `0600` 的 `.env.local`。
- Session token、CSRF token 和 OAuth state 在 SQLite 中只保存哈希。
- Session Cookie 为 HttpOnly + SameSite Strict；写请求额外校验 CSRF。
- SSE 在 Session 到期时主动关闭，并在心跳时重新校验 Session；被撤销的既有连接不会无限继续接收 Thread 事件。
- Project、Thread、Turn、Item、Subagent、Settings、事件和审批都按飞书用户 owner 过滤。
- `threadId + turnId + account connection generation` 精确绑定当前 Actor；已结束、伪造或旧连接上的 Turn 不能重放 Tool。
- Tool 审计只保存输入/输出摘要哈希和关联 ID，不保存原始飞书 Token。
- 用户端 Thread、兼容 Task 和 SSE 投影不返回共享账号别名；账号别名只在管理员账号池和管理员审计中可见。
- 用户端不消费或保存 `reasoningTextDelta`、原始 `content`、`encrypted_content`；可展示的 `reasoning.summary` 不作为审计证据。
- 用户 Settings 保存在平台数据库并按飞书用户隔离，不写入共享 Codex 账号目录；每个 Turn 保存不可变有效配置快照。
- 平台策略返回 `nativeSharedAccountMemory=false`，用户端不提供原生 Memory 入口，也不调用可能影响共享 Home 的 `memory/reset`。1.1A real Runtime 在新建或恢复 Thread 后、任何 `turn/start` 前，必须成功执行 `thread/memoryMode/set { mode: "disabled" }`；RPC 失败或响应不是协议规定的空对象时，账号会被隔离并拒绝本次 Prompt。fake Runtime 不启动 App Server。
- 账号管理 API 返回别名、状态、额度和占用，不返回凭证、邮箱或 `CODEX_HOME`。
- Codex 子进程使用严格环境变量白名单；飞书 App Secret、Token 加密密钥、Session 配置和代理变量不会继承到 Agent 环境。版本探测也使用同一安全环境。
- App Server `stderr` 会被持续排空但不回传浏览器，避免管道阻塞和内部错误泄露；进程停止有有界的 `SIGTERM -> SIGKILL` 降级。
- 审批对外使用平台 UUID；原始 JSON-RPC ID 只与账号、连接代次、Thread 和 Turn 一起保存在服务端，事件、审批列表和决定响应均不返回该 ID 或原始审批 payload。只有响应写入 App Server 得到确认后，审批才进入 `DELIVERED`。
- 浏览器审批接口只允许单次 `accept`、`decline` 或 `cancel`；不开放会跨共享 App Server 用户生效的 `acceptForSession`。
- Turn 结束时，该 Turn 尚未交付的审批会同时在内存 transport 与 SQLite 中关闭；恢复到新 Turn 后，历史审批不会重新变成可操作状态。
- Tool/审批响应写入失败（包括启动失败后拒绝缓冲请求时无法写回错误）会先清除 Actor 和运行上下文、隔离账号并停止对应 App Server，再释放调度容量，避免失效连接或旧 Turn 继续调用企业 Tool。
- Subagent 可观测 Thread 继承父 Turn 的 owner 与 `ActorContext`；父子身份冲突时进入恢复路径，而不是回退到共享账号身份。1.1A 没有开放任意子 Agent 的独立控制接口。
- 新增账号、发起账号登录、排空、隔离和恢复都会记录执行操作的飞书管理员；失败登录只记录通用摘要。
- SQLite 内部审计保留租约、Thread、Turn、Tool 和审批关联；管理员浏览器接口只返回用户、账号别名、Thread、动作、结果、摘要和时间，不返回这些运行时关联 ID。
- Demo SQL 只接受单条 allowlist `SELECT`，拒绝注释、多语句、DDL/DML、SQLite 系统对象和超限结果。
- Runtime 错误和 Tool 错误做基础 Token 脱敏。

## 故障恢复

### 浏览器或 SSE 断线

Thread Item 先写入 SQLite，再推送到浏览器。刷新 Thread 后，客户端用最后一个 sequence 重连，API 根据 `Last-Event-ID` 重放缺失 Item。增量只在相同 `threadId + turnId + itemId + type` 内合并；浏览器断线不会主动释放租约。

### API 正常重启

1. 先停止新任务，等待正在运行的只读任务结束。
2. 用 `Ctrl-C` 正常停止，并成对保留当前配置解析后的 `DATABASE_PATH` 与 `RUNTIME_DATA_DIR`。默认 fake 是 `.data/codexplatform.sqlite` + `.data/runtime`；本手册的 real 示例是 `.data/real-codexplatform.sqlite` + `.data/real-runtime`。
3. 重新执行 `pnpm dev`。
4. 启动过程会立即把数据库中遗留的运行中 Turn，以及“已创建但尚未完成租约/排队状态写入”的孤立 `ALLOCATING` Turn 标为 `NEEDS_RECOVERY`，取消残留排队项并释放 `RUNNING / NEEDS_RECOVERY` Turn 槽；它不会等待 45 秒超时，也不会自动重放旧 Turn。
5. 检查账号状态、Thread 时间线和审计记录。对已有 Runtime Thread 绑定的 Thread 点击“继续”时，real adapter 会先尝试 `thread/resume`；只有 Thread 明确空闲且所有已返回 Turn 都是已知终态时，才从新的 Turn 边界启动。

`thread/resume` 不是活动 Turn 重新附着接口。若恢复响应包含 active/in-progress、未知、格式错误、`notLoaded` 或 `systemError` 等不可证明安全的状态，平台会拒绝本次 Prompt、停止并隔离账号、清除该账号运行绑定，并把受影响任务标记为 `NEEDS_RECOVERY`。不得把这个结果描述为“原 Turn 已继续”。

不要删除 `codex-accounts` 目录来“修复”认证；这会丢失本地凭证。需要重认证时使用账号池的“重新认证”。

### App Server 意外退出或机器断电

API 启动时会立即恢复所有遗留运行 Turn；运行期间平台每 15 秒为已登记的活动 Turn 续心跳，并把超过 45 秒无心跳的 Turn 标记为 `NEEDS_RECOVERY`。App Server 意外退出时，账号会立即进入 `QUARANTINED`，活动任务收到 `RECOVERY_REQUIRED`，Turn 槽被释放，不再把新任务分配给该账号。

正常协议终态不会混入恢复态：`TURN_COMPLETED`、`TURN_FAILED`、`TURN_INTERRUPTED` 分别落为 `COMPLETED`、`FAILED`、`INTERRUPTED`。同一任务任一时刻最多存在一个 `ALLOCATING / QUEUED / RUNNING / WAITING_APPROVAL` Turn；重复提交返回 HTTP 409。

任务状态更新还会校验事件的 Turn ID 必须等于当前 Turn。旧 Turn 的延迟或重复终态仍保留在审计时间线中，但不能清空或终止已经开始的新 Turn。

当一个账号 App Server 被停止、崩溃或因不安全恢复而隔离时，平台按账号边界清理该连接上的 Actor、审批和运行映射，并将该账号上所有受影响的活动 Turn 进入恢复态，避免留下可继续调用企业 Tool 的孤立映射。

因此本 MVP 的保守处理是：

1. 立即停止提交新任务，不假设旧 Turn 已失败或已成功。
2. 在目标系统核对可能发生的副作用；当前 P0 企业 Tool 均只读，风险主要来自 Codex 工作区文件修改。
3. 保留 SQLite 和 Runtime 目录并重启服务。
4. 修复 App Server 或认证问题后，由管理员恢复账号；在原 Thread 点击“继续”，仅在 Runtime 能证明该 Thread 空闲时从新的 Turn 边界显式续跑。若无法安全确认前一 Turn 的结果，则保留时间线作为证据并创建新 Thread。
5. 不要自动重复任何已发出的外部写操作。

这不是生产级自动恢复：当前不会重新附着或自动重放正在执行的 Turn。进入组织试点前，应增加独立 Worker、进程级健康检查、可审计的回收/恢复操作和副作用账本。

### SQLite 备份与恢复

停止 API 后再做一致性备份。必须选择当前运行模式实际配置的一对路径，例如：

```bash
# 默认 fake
sqlite3 .data/codexplatform.sqlite ".backup '.data/codexplatform.backup.sqlite'"

# 本手册的 real 示例
sqlite3 .data/real-codexplatform.sqlite ".backup '.data/real-codexplatform.backup.sqlite'"
```

同时备份与数据库配对的 Runtime 目录：fake 为 `.data/runtime`，上述 real 示例为 `.data/real-runtime`。账号凭证目录属于敏感材料，备份必须加密并限制访问。恢复时只使用同一时点、同一绑定对的数据库和 Runtime 快照，避免任务 Thread 与账号目录不一致。

## 已知限制

1. **真实多人未开放。** 当前 Mac 探针为 `READABLE`，real 只允许首位 operator；fake 的 4 人结果只是调度模拟。
2. **不是生产隔离。** 所有 Worker 仍在同一 OS 用户下，没有容器、独立系统用户、KMS/Credential Broker 或网络策略。
3. **合规门禁在流程外。** OpenAI 书面许可没有被环境变量或数据库自动验证；上线必须人工审查许可范围。
4. **只有首项管理员生效。** 配置可解析多个 OpenID，但当前角色授予和 real operator 只使用第一项。
5. **未知周额度会阻塞。** 没有精确 7 天额度桶时，新任务不能获得账号；当前没有管理员 override UI/API。
6. **恢复仍需人工确认。** 已有启动即恢复、15 秒活动 Turn 心跳、crash 后账号隔离、Turn 槽释放和显式 Turn 边界续跑，但没有执行中 Turn 的重新附着或自动重放；这是为了避免并行 Turn 和重复外部副作用。
7. **心跳仅为单进程实现。** 平台定时器和 Runtime 事件都会刷新心跳，但没有独立 Worker 健康探针或分布式租约仲裁。
8. **单机状态。** SQLite、进程内事件总线和 ActorRegistry 不支持多实例或 HA。
9. **Dynamic Tools 是实验接口。** 已锁定 Codex 版本并隔离适配层，但协议升级仍需重新生成类型并审查。
10. **飞书范围有限。** 只支持搜索和 Wiki/Docx 文本读取；图片、表格语义、Sheet、Base、Slides 和写操作未接入。
11. **数据库/业务系统仍为 Mock。** SQL 仅访问两个 Demo 表；业务查询返回确定性假数据。
12. **仅本机 HTTP。** Cookie 的 `Secure` 为 false，只能在 loopback 开发环境使用，不能直接暴露到局域网或公网。
13. **真实外部测试默认跳过。** 测试文件存在不等于真实 Codex 登录、额度或飞书文档链路已通过。
14. **只开放 CODEX 模式。** ChatGPT Chat / Work、Voice、Browser、Computer Use 和 Office 原生对象能力尚未接入。
15. **Subagent 治理未生产化。** 已有事件规范化、owner 继承、Active/Done、详情和用量归集；独立 Worker、硬并发/预算执行器和任意子 Agent 直接控制尚未交付。
16. **Settings 仍是 1.1A 范围。** 用户偏好和 Turn 快照已实现；Project 级执行设置、完整组织策略编辑、插件安装和平台 Memory 尚未实现。
17. **原生 Memory 已在 real Runtime 的 Thread 级关闭，但多人隔离仍未完成。** 1.1A real Runtime 已在每次新建/恢复 Thread 后强制下发 `thread/memoryMode=disabled`，并在失败时 fail closed；真实多人开放仍需通过跨用户 Memory、Thread 历史和文件哨兵测试，并完成独立 Worker/`CODEX_HOME` 隔离。
18. **企业 App Server client 尚需登记。** 组织试点前必须按 OpenAI App Server 初始化要求联系 OpenAI，将 `codexplatform` 加入 known clients；本仓库发送 `clientInfo` 不等于已获准。
