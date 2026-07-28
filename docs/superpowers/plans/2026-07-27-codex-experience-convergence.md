# Codex 体验收敛 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CodexPlatform 使用真实 App Server 模型目录，并把 Thread 页面重构为 Codex 式主对话流与三个可独立组合的 Workspace Surface。

**Architecture:** 后端增加账号作用域的 `model/list` 目录适配、短期缓存和组织策略校验，前端使用 Runtime 返回的模型与 Effort 驱动 Composer。Web 新增纯函数事件投影层，将同一 Thread 的 Item 分别投影到主对话流、Pinned Summary、Side Panel 和 Bottom Panel；三个 Surface 的开关与尺寸只属于客户端布局状态。

**Tech Stack:** TypeScript、Fastify、React、TanStack Query、Zod、Codex App Server stdio JSONL、Vitest、Testing Library、Playwright、Biome。

---

## File map

### Contracts and API

- `packages/contracts/src/index.ts`：新增模型目录、实际模型和可读 Runtime 通知契约。
- `packages/contracts/src/index.test.ts`：模型目录解析与未来未知 Effort 兼容测试。
- `apps/api/src/web-api.ts`：给 `PlatformApi` 增加 `listModels(userId)`。
- `apps/api/src/server.ts`：增加 `GET /api/models`。
- `apps/api/src/server-api.test.ts`：模型目录鉴权与 HTTP 输出测试。

### Codex runtime and platform domain

- `apps/api/src/infra/codex/codex-runtime.ts`：分页调用 `model/list`。
- `apps/api/src/infra/codex/codex-runtime.test.ts`：分页、隐藏模型和字段投影测试。
- `apps/api/src/infra/codex/app-server-execution-adapter.ts`：按账号读取目录并提供给 Platform 层。
- `apps/api/src/infra/codex/fake-execution-adapter.ts`：提供确定性 fake 模型目录。
- `apps/api/src/domain/platform-service.ts`：缓存目录、应用组织策略、校验模型与 Effort。
- `apps/api/src/domain/platform-service.test.ts`：默认模型、非法模型、非法 Effort、缓存失败测试。
- `apps/api/src/infra/codex/event-normalizer.ts`：规范化 `model/rerouted`、warning 和 context compaction。
- `apps/api/src/infra/codex/event-normalizer.test.ts`：新事件的显示字段与敏感字段边界。

### Web

- `apps/web/src/api.ts`：增加 `getModels()`。
- `apps/web/src/api.test.ts`：模型目录解析和错误传播。
- `apps/web/src/types.ts`：复用 contracts 的模型类型。
- `apps/web/src/thread-presentation.ts`：纯函数 Thread 内容投影。
- `apps/web/src/thread-presentation.test.ts`：内容唯一归属、当前 Turn Pinned Summary 和敏感事件过滤。
- `apps/web/src/workspace-layout.ts`：三个 Surface 的 reducer。
- `apps/web/src/workspace-layout.test.ts`：独立开关、Tab、Thread 切换复位。
- `apps/web/src/components/thread/ModelEffortPicker.tsx`：模型与 Effort 联动控件。
- `apps/web/src/components/thread/Transcript.tsx`：主对话流。
- `apps/web/src/components/thread/PinnedExecutionSummary.tsx`：悬浮摘要。
- `apps/web/src/components/thread/SidePanel.tsx`：右侧多 Tab Dock。
- `apps/web/src/components/thread/BottomPanel.tsx`：底部 Terminal Dock。
- `apps/web/src/components/thread/ThreadComposer.tsx`：统一 Composer。
- `apps/web/src/app.tsx`：组合新组件，移除固定右栏和事件大卡片入口。
- `apps/web/src/styles.css`：Workspace Grid、浮层、两个 Dock 和响应式。
- `apps/web/src/v11-app.test.tsx`：用户交互与可访问性测试。
- `tests/e2e/workspace.spec.ts`：模型选择与三个 Surface 的浏览器验收。

### Documentation

- `docs/codexplatform-1.1-product-and-technical-spec.md`：产品与技术基线。
- `docs/architecture.md`：模型目录和 Workspace Surface 数据流。
- `docs/acceptance.md`：P0 UAT。

---

### Task 1: Define the runtime model catalog contract

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

- [x] **Step 1: Write the failing contract tests**

```ts
it("accepts runtime ordered effort strings without a local enum", () => {
  const catalog = ModelCatalogSchema.parse({
    models: [{
      id: "gpt-5.6-codex",
      model: "gpt-5.6-codex",
      displayName: "5.6 Sol",
      description: "Coding model",
      isDefault: true,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { value: "high", description: "Deep work" },
        { value: "ultra", description: "Maximum delegation" },
      ],
      inputModalities: ["text", "image"],
      supportsPersonality: true,
    }],
    scope: "SINGLE_ACCOUNT",
    accountCount: 1,
    observedAt: "2026-07-27T04:00:00.000Z",
    stale: false,
  });
  expect(catalog.models[0]?.supportedReasoningEfforts.map((item) => item.value))
    .toEqual(["high", "ultra"]);
});
```

- [x] **Step 2: Run the contract test and verify RED**

Run: `pnpm test packages/contracts/src/index.test.ts`

Expected: FAIL because `ModelCatalogSchema` is not exported.

- [x] **Step 3: Add the minimal schemas**

```ts
export const ModelEffortOptionSchema = z.object({
  value: z.string().trim().min(1),
  description: z.string(),
}).strict();

export const ModelOptionSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  hidden: z.boolean(),
  isDefault: z.boolean(),
  defaultReasoningEffort: z.string().min(1),
  supportedReasoningEfforts: z.array(ModelEffortOptionSchema).min(1),
  inputModalities: z.array(z.string().min(1)),
  supportsPersonality: z.boolean(),
}).strict().superRefine((model, context) => {
  const efforts = model.supportedReasoningEfforts.map((item) => item.value);
  if (!efforts.includes(model.defaultReasoningEffort)) {
    context.addIssue({ code: "custom", path: ["defaultReasoningEffort"], message: "..." });
  }
  if (new Set(efforts).size !== efforts.length) {
    context.addIssue({ code: "custom", path: ["supportedReasoningEfforts"], message: "..." });
  }
});

export const ModelCatalogSchema = z.object({
  models: z.array(ModelOptionSchema),
  scope: z.enum(["SINGLE_ACCOUNT", "ELIGIBLE_ACCOUNT_INTERSECTION"]),
  accountCount: z.number().int().positive(),
  observedAt: z.iso.datetime(),
  stale: z.boolean(),
}).strict().superRefine((catalog, context) => {
  if (catalog.scope === "SINGLE_ACCOUNT" && catalog.accountCount !== 1) {
    context.addIssue({ code: "custom", path: ["accountCount"], message: "..." });
  }
});
```

- [x] **Step 4: Verify GREEN**

Run: `pnpm test packages/contracts/src/index.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat(contracts): define runtime model catalog"
```

### Task 2: Read the real App Server model catalog

**Files:**
- Modify: `apps/api/src/infra/codex/codex-runtime.ts`
- Test: `apps/api/src/infra/codex/codex-runtime.test.ts`

- [x] **Step 1: Write the failing pagination test**

```ts
it("reads every visible model page in runtime order", async () => {
  rpc.request
    .mockResolvedValueOnce({ data: [modelA], nextCursor: "page-2" })
    .mockResolvedValueOnce({ data: [hiddenModel, modelB], nextCursor: null });

  await expect(runtime.listModels()).resolves.toEqual([modelA, modelB]);
  expect(rpc.request).toHaveBeenNthCalledWith(1, "model/list", {
    cursor: null, limit: 100, includeHidden: false,
  });
  expect(rpc.request).toHaveBeenNthCalledWith(2, "model/list", {
    cursor: "page-2", limit: 100, includeHidden: false,
  });
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm test apps/api/src/infra/codex/codex-runtime.test.ts`

Expected: FAIL because `listModels()` does not exist.

- [x] **Step 3: Implement paginated `model/list`**

```ts
async listModels(): Promise<Model[]> {
  const models: Model[] = [];
  const seenCursors = new Set<string>();
  const maxPages = 100;
  let pageCount = 0;
  let cursor: string | null = null;
  do {
    if (pageCount >= maxPages) {
      throw new Error(`Codex model/list exceeded ${maxPages} pages`);
    }
    pageCount += 1;
    const page = await this.rpc.request<ModelListResponse>("model/list", {
      cursor,
      limit: 100,
      includeHidden: false,
    });
    models.push(...page.data.filter((model) => !model.hidden));
    if (page.nextCursor !== null && seenCursors.has(page.nextCursor)) {
      throw new Error("Codex model/list returned a repeated pagination cursor");
    }
    if (page.nextCursor !== null) seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return models;
}
```

- [x] **Step 4: Verify GREEN and existing runtime tests**

Run: `pnpm test apps/api/src/infra/codex/codex-runtime.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/api/src/infra/codex/codex-runtime.ts apps/api/src/infra/codex/codex-runtime.test.ts
git commit -m "feat(runtime): read Codex model catalog"
```

### Task 3: Expose and validate the account model catalog

**Files:**
- Modify: `apps/api/src/infra/codex/app-server-execution-adapter.ts`
- Modify: `apps/api/src/infra/codex/fake-execution-adapter.ts`
- Modify: `apps/api/src/domain/platform-service.ts`
- Modify: `apps/api/src/web-api.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/domain/platform-service.test.ts`
- Test: `apps/api/src/server-api.test.ts`

- [x] **Step 1: Write failing service tests**

```ts
it("returns the eligible account catalog and validates model-specific effort", async () => {
  execution.listModels.mockResolvedValue([runtimeModel]);
  const catalog = await service.listModels("admin");
  expect(catalog.models[0]?.model).toBe("gpt-5.6-codex");
  await expect(service.startThreadTurn(
    thread.id, "admin", "run", { model: "gpt-5.6-codex", reasoningEffort: "ultra" },
  )).resolves.toBeDefined();
});

it("rejects an effort that the selected model does not support", async () => {
  await expect(service.startThreadTurn(
    thread.id, "admin", "run", { model: "gpt-5.6-codex", reasoningEffort: "tiny" },
  )).rejects.toThrow("Reasoning effort is not supported by the selected model");
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm test apps/api/src/domain/platform-service.test.ts apps/api/src/server-api.test.ts`

Expected: FAIL because `TaskExecutionAdapter.listModels` and `PlatformApi.listModels` do not exist.

- [x] **Step 3: Implement the minimal catalog path**

```ts
interface TaskExecutionAdapter {
  listModels(account: InternalAccount): Promise<ModelOption[]>;
}

async listModels(userId: string): Promise<ModelCatalog> {
  this.requireKnownUser(userId);
  const account = this.selectCatalogAccount();
  return this.modelCatalogCache.getOrLoad(account.id, () => this.options.execution.listModels(account));
}
```

Cache rules:

- TTL is 60 seconds.
- A failed refresh may return the previous value with `stale=true`.
- No previous value means the request fails; do not invent a model.
- Browser DTO contains no account ID, alias, `CODEX_HOME`, or credential metadata.
- An unbound new Thread receives the model/effort intersection across eligible accounts and `scope=ELIGIBLE_ACCOUNT_INTERSECTION`; an account-bound Thread receives that account's catalog and `scope=SINGLE_ACCOUNT`.
- Fake runtime exposes two explicitly fake models: `fake-codex-standard` (`low`, `medium`, `high`; default `medium`) and `fake-codex-deep` (`medium`, `high`, `xhigh`; default `high`). Fake names must not imply a real OpenAI model.
- Model and Effort are validated before Turn creation and again after account allocation.

- [x] **Step 4: Add `GET /api/models`**

```ts
app.get("/api/models", async (request, reply) => {
  const actor = requireSession(request, reply, auth);
  if (!actor) return;
  return platform.listModels(actor.user.id);
});
```

- [x] **Step 5: Verify GREEN**

Run: `pnpm test apps/api/src/domain/platform-service.test.ts apps/api/src/server-api.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/infra/codex apps/api/src/domain/platform-service.ts \
  apps/api/src/web-api.ts apps/api/src/server.ts \
  apps/api/src/domain/platform-service.test.ts apps/api/src/server-api.test.ts
git commit -m "feat(api): expose validated model catalog"
```

### Task 4: Add the model and Effort picker to the Composer

**Files:**
- Create: `apps/web/src/components/thread/ModelEffortPicker.tsx`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/app.tsx`
- Test: `apps/web/src/api.test.ts`
- Test: `apps/web/src/v11-app.test.tsx`

- [x] **Step 1: Write failing component tests**

```tsx
it("uses the runtime default model and resets effort when the model changes", async () => {
  renderWorkspace({ models: [solModel, microModel] });
  expect(await screen.findByRole("button", { name: /5.6 Sol Ultra/ })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /5.6 Sol Ultra/ }));
  await user.click(screen.getByRole("option", { name: "Codex Micro" }));
  expect(screen.getByRole("button", { name: /Codex Micro Medium/ })).toBeVisible();
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm test apps/web/src/api.test.ts apps/web/src/v11-app.test.tsx`

Expected: FAIL because the model endpoint and picker do not exist.

- [x] **Step 3: Implement `getModels()` and the linked picker**

```ts
export function normalizeModelSelection(
  model: ModelOption,
  effort: string | null,
): { model: string; reasoningEffort: string } {
  const supported = model.supportedReasoningEfforts.map((option) => option.value);
  return {
    model: model.model,
    reasoningEffort:
      effort && supported.includes(effort) ? effort : model.defaultReasoningEffort,
  };
}
```

The picker must:

- preserve Runtime order;
- show only API-returned models;
- display loading, stale and unavailable states;
- submit both `model` and `reasoningEffort`;
- lock configuration while a Turn is allocating, queued, running or waiting for approval.

- [x] **Step 4: Verify GREEN**

Run: `pnpm test apps/web/src/api.test.ts apps/web/src/v11-app.test.tsx`

Expected: PASS and no `Runtime default / Model catalog not connected` assertion remains.

- [x] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add runtime model and effort picker"
```

### Task 5: Build the Thread presentation projection

**Files:**
- Create: `apps/web/src/thread-presentation.ts`
- Create: `apps/web/src/thread-presentation.test.ts`
- Modify: `apps/web/src/thread-events.ts`
- Modify: `apps/web/src/thread-events.test.ts`

- [x] **Step 1: Write failing projection tests**

```ts
it("routes one complete representation of each item", () => {
  const view = projectThreadPresentation(events, turns, subagents);
  expect(view.transcript.activities).toEqual([
    expect.objectContaining({ kind: "command", itemId: "cmd-1" }),
    expect.objectContaining({ kind: "tool", itemId: "tool-1" }),
  ]);
  expect(view.bottom.terminals).toHaveLength(1);
  expect(view.pinned?.turnId).toBe("turn-current");
  expect(view.side.outputs).toEqual([]);
  expect(view.side.sources).toEqual([]);
});

it("never projects raw reasoning into a visible region", () => {
  expect(projectThreadPresentation([rawReasoningEvent], turns, []).visibleText)
    .not.toContain("reasoning-canary");
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm test apps/web/src/thread-presentation.test.ts`

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the pure projection**

```ts
export function projectThreadPresentation(
  events: TaskEvent[],
  turns: Turn[],
  subagents: SubagentThread[],
): ThreadPresentation {
  const merged = coalesceThreadEvents(events);
  const currentTurn = selectCurrentOrLatestTurn(turns);
  return {
    transcript: projectTranscript(merged),
    pinned: projectPinnedSummary(merged, currentTurn, subagents),
    side: projectSideContent(merged, subagents),
    bottom: projectBottomContent(merged),
  };
}
```

Projection invariants:

- `threadId + turnId + itemId` is the merge boundary.
- Full command output belongs to Bottom Panel; transcript receives one activity summary.
- Outputs require a real artifact; Agent messages and Diff summaries are not artifacts.
- Sources require a URL, resource URI or citation metadata; Tool name alone is not a source.
- Pinned Summary only consumes the current or latest Turn.

- [x] **Step 4: Verify GREEN**

Run: `pnpm test apps/web/src/thread-presentation.test.ts apps/web/src/thread-events.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/thread-presentation.ts apps/web/src/thread-presentation.test.ts \
  apps/web/src/thread-events.ts apps/web/src/thread-events.test.ts
git commit -m "feat(web): project Thread items into workspace regions"
```

### Task 6: Implement the three independent Workspace Surface states

**Files:**
- Create: `apps/web/src/workspace-layout.ts`
- Create: `apps/web/src/workspace-layout.test.ts`
- Create: `apps/web/src/components/thread/PinnedExecutionSummary.tsx`
- Create: `apps/web/src/components/thread/SidePanel.tsx`
- Create: `apps/web/src/components/thread/BottomPanel.tsx`

- [x] **Step 1: Write the failing reducer tests**

```ts
it("opens pinned, side and bottom surfaces independently", () => {
  let state = createWorkspaceLayoutState();
  state = reduceWorkspaceLayout(state, { type: "TOGGLE_PINNED" });
  state = reduceWorkspaceLayout(state, { type: "OPEN_SIDE", tab: { kind: "subagent", id: "s1" } });
  state = reduceWorkspaceLayout(state, { type: "OPEN_BOTTOM", tab: "terminal", itemId: "cmd-1" });
  expect(state.pinnedSummaryOpen).toBe(true);
  expect(state.sidePanel.open).toBe(true);
  expect(state.bottomPanel.open).toBe(true);
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm test apps/web/src/workspace-layout.test.ts`

Expected: FAIL because the reducer does not exist.

- [x] **Step 3: Implement the reducer and accessible surfaces**

Requirements:

- Pinned Summary does not change workspace columns.
- Side Panel owns width and multiple typed tabs.
- Bottom Panel owns height and Terminal selection.
- `RESET_THREAD` closes resource selections while preserving user preferred dimensions.
- Buttons expose `aria-expanded` and `aria-controls`.
- Escape closes the active Dock and restores focus.

- [x] **Step 4: Verify GREEN**

Run: `pnpm test apps/web/src/workspace-layout.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/workspace-layout.ts apps/web/src/workspace-layout.test.ts \
  apps/web/src/components/thread
git commit -m "feat(web): add independent workspace surfaces"
```

### Task 7: Replace the event-card workspace with the Codex main conversation flow

**Files:**
- Create: `apps/web/src/components/thread/Transcript.tsx`
- Create: `apps/web/src/components/thread/ThreadComposer.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/v11-app.test.tsx`

- [x] **Step 1: Write failing interaction tests**

```tsx
it("renders a readable conversation and routes details to the correct surface", async () => {
  renderWorkspace({ events: planCommandToolDiffFinalEvents });
  expect(await screen.findByText("完成了 2 个文件修改")).toBeVisible();
  expect(screen.queryByText("TURN_STARTED")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /查看命令/ }));
  expect(screen.getByRole("region", { name: "Bottom panel" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");

  await user.click(screen.getByRole("button", { name: /查看 Subagents/ }));
  expect(screen.getByRole("region", { name: "Side panel" })).toBeVisible();
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm test apps/web/src/v11-app.test.tsx`

Expected: FAIL because the current page still uses event cards and a fixed context rail.

- [x] **Step 3: Compose the new workspace**

```tsx
<ThreadWorkspace layout={layout}>
  <ThreadHeader />
  <PinnedExecutionSummary summary={presentation.pinned} />
  <Transcript presentation={presentation.transcript} />
  <ThreadComposer modelCatalog={modelCatalog.data} />
  <BottomPanel state={layout.bottomPanel} content={presentation.bottom} />
  <SidePanel state={layout.sidePanel} content={presentation.side} />
</ThreadWorkspace>
```

CSS behavior:

- desktop: `minmax(0, 1fr)` plus optional Side Panel width;
- Pinned Summary is an anchored floating card;
- Bottom Panel is a real Dock below the Composer/Main viewport;
- `<=930px`: Side Panel becomes a Drawer;
- `<=720px`: Bottom Panel becomes a half/full-height Sheet.

- [x] **Step 4: Verify GREEN**

Run: `pnpm test apps/web/src/v11-app.test.tsx`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add apps/web/src/app.tsx apps/web/src/styles.css apps/web/src/components/thread
git commit -m "feat(web): converge workspace on Codex interaction model"
```

### Task 8: Normalize actual-model and important runtime events

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/infra/codex/event-normalizer.ts`
- Modify: `apps/api/src/domain/platform-service.ts`
- Modify: `apps/web/src/thread-presentation.ts`
- Test: `apps/api/src/infra/codex/event-normalizer.test.ts`
- Test: `apps/web/src/thread-presentation.test.ts`

- [x] **Step 1: Write failing reroute and warning tests**

```ts
it("emits a displayable model reroute without raw provider payload", () => {
  const [event] = normalizer.consume({
    method: "model/rerouted",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      fromModel: "requested",
      toModel: "actual",
      reason: "availability",
    },
  });
  expect(event).toMatchObject({
    type: "MODEL_REROUTED",
    payload: { fromModel: "requested", toModel: "actual" },
  });
});
```

- [x] **Step 2: Verify RED**

Run: `pnpm test apps/api/src/infra/codex/event-normalizer.test.ts`

Expected: FAIL because the event type is absent and the notification is dropped.

- [x] **Step 3: Implement safe event projection**

Add `MODEL_REROUTED`, `RUNTIME_WARNING` and `CONTEXT_COMPACTED` to the platform event union. Store only the fields needed for display and auditing; never persist raw reasoning or opaque provider payloads.

- [x] **Step 4: Verify GREEN**

Run: `pnpm test apps/api/src/infra/codex/event-normalizer.test.ts apps/web/src/thread-presentation.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/contracts/src apps/api/src/infra/codex apps/api/src/domain/platform-service.ts \
  apps/web/src/thread-presentation.ts apps/web/src/thread-presentation.test.ts
git commit -m "feat(runtime): surface actual model and runtime notices"
```

### Task 9: Browser acceptance, docs and real UAT preparation

**Files:**
- Modify: `tests/e2e/workspace.spec.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/acceptance.md`
- Modify: `docs/codexplatform-1.1-product-and-technical-spec.md`

- [x] **Step 1: Add failing browser acceptance**

Test one Thread that:

1. loads a model directory;
2. switches model and receives the correct Effort options;
3. submits a Turn with that immutable config;
4. opens Pinned Summary, Bottom Panel and Side Panel at the same time;
5. routes command details to Terminal and Subagent details to the Side Panel;
6. reconnects SSE without duplicate transcript entries.

- [x] **Step 2: Verify RED**

Run: `pnpm test:e2e --grep "model catalog and workspace surfaces"`

Expected: FAIL until all P0 slices are connected.

- [x] **Step 3: Complete the acceptance and documentation updates**

Document the actual behavior only. Keep Browser Worker, interactive PTY, Artifact store and production multi-user isolation marked as later capabilities until their separate acceptance tests pass.

- [x] **Step 4: Run the full verification**

Run:

```bash
pnpm verify
REAL_CODEX_E2E=1 pnpm test:real-codex
```

Expected:

- lint, typecheck, unit/integration, Playwright, protocol verification and build all pass;
- real Codex smoke uses the selected model or records a visible `MODEL_REROUTED`;
- no raw reasoning, credential or account identity appears in the browser or stored events.

- [x] **Step 5: Commit**

```bash
git add tests/e2e/workspace.spec.ts docs
git commit -m "test: accept Codex model and workspace convergence"
```

### Task 10: Harden product truthfulness and execution evidence after review

- [x] Strip raw reasoning at persistence, REST and SSE boundaries (`eed179a`).
- [x] Render user, Agent and reasoning summary Markdown through one safe renderer (`c4c6fe7`).
- [x] Redact managed Runtime, workspace and `CODEX_HOME` paths on write and historical read
      (`02b44fe`).
- [x] Scope Pinned Summary to `displayTurn`; keep Terminal sessions and Tool/Diff details on
      composite `threadId + turnId + itemId` identities.
- [x] Reuse Transcript for Subagent detail; show unsupported deeper navigation as read-only rather
      than a no-op control.
- [x] Remove synthetic Continue and nonexistent Artifact download links.
- [x] Run `pnpm verify` and authenticated real-page DOM UAT after the final fixes.
