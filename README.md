# CodexPlatform

CodexPlatform 是一个本机纵切 MVP：组织成员使用真实飞书身份登录，在统一工作台内创建任务、查看 Codex 风格执行时间线，并由后端统一管理账号槽位、审批、工具身份和审计数据。

当前默认使用 `fake` Runtime。它会生成可重复的 Plan、命令、Tool、Diff 和结果事件，适合验证工作台和“单账号最多 4 名活跃用户、同一用户最多 2 个并行 Turn、FIFO 排队”规则；它不使用真实 Codex 凭证，也不能证明真实多人共享安全。

`real` Runtime 已接入固定版本 `@openai/codex@0.144.6` 的 App Server，但当前开发 Mac 的凭证隔离探针结论为 `READABLE`。因此真实 Codex 默认只允许 `FEISHU_ADMIN_OPEN_IDS` 中第一位用户执行，其他用户在安全隔离通过前会被拒绝。

## 已实现范围

- 飞书 Web OAuth、同租户限制、HttpOnly Session、CSRF 和逐用户任务 ACL。
- SQLite WAL 数据层、账号/Turn 固定槽、FIFO 排队、额度新鲜度和 30 分钟空闲租约回收。
- 单任务 active Turn 原子约束、明确完成/失败/中断终态，以及启动即恢复且不自动重放副作用。
- REST 命令接口与支持 `Last-Event-ID` 重放的 SSE 时间线。
- Codex Thread/Turn、Steer、Interrupt、审批、Plan、命令输出、Diff、Tool 和结果事件规范化。
- 真实只读飞书 Tool：`feishu_wiki_search`、`feishu_doc_read`。
- Mock Tool：只读 `demo_db_query` 和确定性 `demo_business_get`。
- 管理员账号池、额度/健康度、排空/隔离/恢复和审计页面。
- Codex 子进程环境白名单、transport-scoped 审批身份、写确认和飞书管理员操作审计。

这仍是单机开发版，不是组织生产环境。安全边界和已知限制见 [安全与运维手册](docs/security-and-operations.md)。

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

浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，使用飞书登录后即可创建任务；没有项目时工作台会自动创建默认项目。默认数据库和运行目录分别位于仓库根目录的 `.data/codexplatform.sqlite` 与 `.data/runtime`。

飞书后台的权限、回调地址和发布步骤见 [飞书配置](docs/feishu-setup.md)。

## 切换真实 Codex

1. 先完成 fake 模式的飞书登录和基础验收。
2. 不要复用 fake 的数据库和运行目录。在 `.env.local` 同时设置：

   ```dotenv
   RUNTIME_MODE=real
   DATABASE_PATH=../../.data/real-codexplatform.sqlite
   RUNTIME_DATA_DIR=../../.data/real-runtime
   ```

   并确认 `CODEX_BIN` 指向仓库锁定的 `node_modules/.bin/codex`。数据库与运行目录会通过双向绑定标记组成同一存储环境；任一侧缺失、复制或混用时服务都会拒绝启动，避免把 fake 账号、额度、租约、Thread 或真实 `CODEX_HOME` 关联到错误环境。
3. 重新执行 `pnpm dev`。服务启动时会自动运行凭证隔离探针。
4. 新数据库不包含旧 Session，需要重新完成一次飞书 OAuth。
5. 首位管理员进入“账号池”，对预置的 `Codex A` 点击“重新认证”，亲自在浏览器完成 ChatGPT/Codex 登录。
6. 回到账号池刷新页面，确认认证状态和周额度，再由首位管理员提交一个无外部写操作的小任务。

完整步骤与 `READABLE` 门禁解释见 [安全与运维手册](docs/security-and-operations.md#首个-codex-账号交互登录)。

## 验证

不需要外部凭证的主验证命令：

```bash
pnpm verify
```

真实 Codex 和真实飞书 Smoke Test 都是显式门禁测试，默认跳过；仓库包含测试代码不代表外部链路已经跑通。只有在本机设置所需环境变量并保留成功输出后，才能把对应链路标记为已验证。命令见 [验收手册](docs/acceptance.md#真实外部-smoke-test)。

## 文档

- [架构与数据流](docs/architecture.md)
- [飞书配置](docs/feishu-setup.md)
- [安全、Codex 登录、故障恢复与已知限制](docs/security-and-operations.md)
- [5 人争抢、同用户 3 Turn、Feishu Tool 与真实 Smoke 验收](docs/acceptance.md)

## 证据边界

本文档描述仓库当前实现和可执行的验收路径，不把未执行的真实 Codex/飞书外部测试写成“已通过”。共享人类账号是否允许、是否覆盖后台凭证托管与多人调度，仍需以 OpenAI 的书面许可为上线前置条件；代码中的 4 人槽位不能替代合规许可或生产级隔离。
