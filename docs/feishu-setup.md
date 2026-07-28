# 飞书配置

## 结论

CodexPlatform 复用当前 `lark-cli` 所连接的企业和自建应用配置，但不会读取、复制或导出 `lark-cli` 的用户 Token。平台内每位用户都要走一次浏览器 OAuth，后端以该用户身份调用飞书知识 Tool。

## 1. 确认当前企业身份

先在本机只读检查 `lark-cli` 当前身份：

```bash
LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 \
LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 \
lark-cli auth status --json --verify
```

确认以下字段符合预期：

- `identity` 为 `user`。
- `verified` 为 `true`，用户 Token 状态可用。
- `identities.user.openId` 是准备作为首位管理员的 OpenID。
- 当前身份属于计划接入的企业。

如果 `lark-cli` 身份需要刷新，按它返回的最小 scope 提示重新授权。这个动作只用于核对企业和用户，不会替代 CodexPlatform 自己的 OAuth。

## 2. 配置企业自建应用

在当前飞书企业的开发者后台使用现有自建应用，或在同一企业内创建一个专用于 CodexPlatform 的自建应用。

配置 Web 重定向 URL：

```text
http://127.0.0.1:4310/api/auth/feishu/callback
```

开通并发布以下用户身份权限：

```text
auth:user.id:read
offline_access
search:docs:read
docx:document:readonly
wiki:node:read
wiki:node:retrieve
wiki:space:retrieve
```

然后：

1. 把应用发布到测试可用范围。
2. 将首轮验收用户加入可用范围；做 5 人争抢验收时至少加入 5 个不同的飞书用户。
3. 记录 App ID、App Secret 和企业 Tenant Key。
4. 记录首位管理员的用户 OpenID。当前 MVP 只把 `FEISHU_ADMIN_OPEN_IDS` 的第一项识别为管理员和 real 模式 operator。

权限分为“应用后台已开通”和“用户已在 OAuth 页面同意”两层。任意一层缺失，飞书 Tool 都可能返回权限不足。

## 3. 填写本机配置

复制示例并限制权限：

```bash
cp .env.example .env.local
chmod 600 .env.local
```

填写：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=replace-locally
FEISHU_REDIRECT_URI=http://127.0.0.1:4310/api/auth/feishu/callback
FEISHU_TENANT_KEY=replace-with-current-tenant-key
FEISHU_ADMIN_OPEN_IDS=ou_replace_with_first_admin
FEISHU_TOKEN_ENCRYPTION_KEY=replace-with-base64-32-byte-key
```

生成加密密钥：

```bash
openssl rand -base64 32
```

该值必须是“恰好 32 个随机字节的标准 Base64”。不要把 App Secret、加密密钥、access token 或 refresh token 发到聊天、提交到 Git 或写进验收截图。

## 4. 验证 OAuth

保持 `RUNTIME_MODE=fake`，运行：

```bash
pnpm dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，点击“使用飞书登录”。验收点：

1. 浏览器进入当前企业的授权页，回调后返回工作台。
2. 首位 OpenID 登录后能看到“账号池”和“审计记录”。
3. 同企业其他用户可以登录，但看不到管理页面。
4. 非配置 Tenant Key 的用户在回调时被拒绝。
5. 用户 A 直接访问用户 B 的任务 URL 或事件接口时得到 404/拒绝，而不是任务数据。
6. 首次授权后关闭并重新打开浏览器、或重启 API，30 天内仍直接进入工作台；Profile 中可主动退出。

平台保存的是加密后的用户 Token：加密密钥仅在 `.env.local`。Session Cookie 为 HttpOnly + SameSite Strict 并持久 30 天；写接口还要求 CSRF Token。飞书 Token 失效时平台登录仍有效，只有飞书 Tool/Connection 要求重新连接。

## 5. 验证飞书知识权限

真实 Feishu Tool 只在 `RUNTIME_MODE=real` 的 Codex Dynamic Tool 流程中被 Agent 调用。先完成 [首个 Codex 账号交互登录](security-and-operations.md#首个-codex-账号交互登录)，再按 [Feishu Tool 端到端验收](acceptance.md#feishu-tool-端到端验收)执行。

如果只想独立验证飞书 API Client，可运行 gated Feishu smoke。它需要当前用户的临时 OAuth access token，默认不会运行；不要从数据库中人工解密或导出生产 Token。

## 常见错误

| 现象 | 检查项 |
| --- | --- |
| OAuth 回调报 malformed / denied | 回调 URL 必须完全一致；检查用户是否取消授权 |
| `OAuth state is invalid` | state 已过期、已使用，或不是同一浏览器发起；重新从登录页开始 |
| `Feishu tenant is not allowed` | `FEISHU_TENANT_KEY` 与登录用户企业不一致 |
| 用户不是管理员 | 确认该用户 OpenID 是 `FEISHU_ADMIN_OPEN_IDS` 第一项，并重新登录生成 Session |
| 搜索/读取权限不足 | 检查后台 scope、应用版本是否发布、用户是否重新同意新 scope、文档本身权限 |
| Wiki 节点读取失败 | 当前只支持指向 Docx 的 Wiki 节点，不支持 Sheet/Base/Slides 等对象 |
| 搜索无结果但无报错 | 先确认当前用户本身能在飞书中搜索到内容；Tool 不会提升权限 |
