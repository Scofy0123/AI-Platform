# Codex Turn 交互对齐 UAT

日期：2026-07-27

环境：本机真实 Codex Runtime，飞书 OAuth 登录

验收 Thread：`32d2278a-62a8-4678-b1f7-9c7f6c5de08c`

## 真实页面验收

提交内容：

> 这是 CodexPlatform Turn 交互 UAT。不要调用工具，不要读取文件。先用一句可见的执行说明说明正在检查，然后最终只回复 TURN_PARITY_UAT_OK。

验收结果：

- 真实 Codex Turn 在 6 秒内完成。
- 完成态显示独立最终答案 `TURN_PARITY_UAT_OK`。
- 执行过程默认折叠为 `Worked for 6s`，点击后可重新展开。
- 展开后可见执行说明“正在检查 CodexPlatform Turn 交互是否符合 UAT 预期。”
- 模型与 Effort 选择器显示本轮实际配置 `GPT-5.6-Sol · medium`。
- 线程级 Runtime 提示保持为紧凑状态行，不再伪造 `Working for 0s` Turn。
- DOM 中未出现 `reasoningTextDelta`、`encrypted_content` 或 `chain_of_thought`。

## 自动化验证

执行：

```bash
pnpm verify
```

结果：

- Biome：通过。
- TypeScript：全部 workspace 通过。
- Vitest：36 个测试文件通过，2 个跳过；472 个测试通过，2 个跳过。
- Playwright：11/11 通过。
- Codex App Server 协议校验：通过。
- API、Contracts、Web 构建：通过。

## 结论

本轮已实现并验证以下 Codex 式 Turn 语义：

1. Prompt、执行过程、最终答案属于同一 Turn，但使用不同展示层级。
2. 运行中持续计时并展示当前动作；完成后显示总耗时。
3. 最终答案独立保留，执行过程自动折叠且可手动展开。
4. 命令、Tool、审批、Subagent 和飞书操作使用 Turn 内紧凑动作行。
5. 仅展示允许公开的执行说明与推理摘要，不展示原始思维链或协议敏感字段。
