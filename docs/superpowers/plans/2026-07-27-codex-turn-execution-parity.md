# Codex Turn Execution Parity Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make CodexPlatform render each Turn with the same observable execution structure as Codex: live elapsed time and current action, interleaved compact execution activity, a distinct final answer, and automatic collapse of the completed execution process.

**Architecture:** Preserve the App Server event stream as the source of truth, add a safe message-phase event keyed by `itemId`, and build a deterministic frontend projection from `Thread → Turn → Item`. The UI renders one Turn as a user prompt, an execution group, and a final answer. Raw reasoning remains excluded; only reasoning summaries enter the browser.

**Tech Stack:** TypeScript, Zod, Fastify, React, Vitest, Testing Library, SSE, Codex App Server JSONL.

---

## Product Semantics

For every Turn, the rendered order is:

1. User prompt.
2. Turn execution group:
   - Running: `Working for <elapsed> · <current action>`.
   - Terminal: `Worked for <duration>`.
   - Commentary messages, reasoning summaries, commands, Tool calls, approvals,
     Subagents, file changes, compaction and status activity appear in protocol order.
3. Final answer outside the execution group.

Default expansion rules:

- Running Turn: expanded.
- Completed Turn with a final answer: collapsed automatically.
- Failed, interrupted or recovery-required Turn: expanded.
- A user's manual expand/collapse choice is preserved for that mounted Turn.

Current-action priority:

1. Waiting for approval.
2. Subagent working.
3. Tool running.
4. Command running.
5. Reading, editing, searching or verifying.
6. Compacting context.
7. Thinking.

Security rules:

- Only `reasoning.summary` is projected.
- Raw reasoning content, encrypted reasoning and provider-private fields never enter
  `TaskEvent`, SSE, logs or browser state.
- Message phase is metadata only; it never carries hidden content.

## Task 1: Add a Safe Agent Message Phase Contract

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

### Step 1: Write the failing contract test

Add a test that parses both supported phases and rejects any unknown phase:

```ts
test("accepts only safe agent message presentation phases", () => {
  expect(AgentMessagePhaseSchema.parse("commentary")).toBe("commentary");
  expect(AgentMessagePhaseSchema.parse("final_answer")).toBe("final_answer");
  expect(() => AgentMessagePhaseSchema.parse("raw_reasoning")).toThrow();
  expect(TASK_EVENT_TYPES).toContain("AGENT_MESSAGE_PHASE");
});
```

### Step 2: Run the focused test and verify failure

Run:

```bash
pnpm --filter @codexplatform/contracts test
```

Expected: FAIL because `AGENT_MESSAGE_PHASE` is not a recognized event type.

### Step 3: Implement the contract

Add:

```ts
export const AgentMessagePhaseSchema = z.enum(["commentary", "final_answer"]);
export type AgentMessagePhase = z.infer<typeof AgentMessagePhaseSchema>;
```

Add `AGENT_MESSAGE_PHASE` to `TASK_EVENT_TYPES` and its payload:

```ts
AGENT_MESSAGE_PHASE: {
  itemId: string;
  phase: AgentMessagePhase | null;
};
```

Keep `phase: null` valid because the generated App Server protocol explicitly permits
providers to omit the phase.

### Step 4: Run the focused test and verify pass

Run:

```bash
pnpm --filter @codexplatform/contracts test
pnpm --filter @codexplatform/contracts typecheck
```

Expected: PASS.

### Step 5: Commit

```bash
git add packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git commit -m "feat: add safe agent message phase events"
```

## Task 2: Normalize App Server Message Phase Without Exposing Content

**Files:**

- Modify: `apps/api/src/infra/codex/event-normalizer.ts`
- Test: `apps/api/src/infra/codex/event-normalizer.test.ts`

### Step 1: Write the failing normalizer tests

Add lifecycle fixtures for `item/started` and `item/completed` with:

```ts
{
  type: "agentMessage",
  id: "message-1",
  text: "Visible final answer",
  phase: "final_answer",
}
```

Assert the normalized event is:

```ts
{
  type: "AGENT_MESSAGE_PHASE",
  payload: {
    itemId: "message-1",
    phase: "final_answer",
  },
}
```

Add a second case with `phase: null` and assert it remains `null`. Also assert the
event payload does not contain `text`, `content`, `encrypted_content` or reasoning
fields.

### Step 2: Run the focused test and verify failure

Run:

```bash
pnpm --filter @codexplatform/api test -- event-normalizer.test.ts
```

Expected: FAIL because agent-message lifecycle events are currently ignored.

### Step 3: Implement lifecycle normalization

In both item lifecycle handlers, detect `item.type === "agentMessage"` and emit:

```ts
return [
  this.event(input, "AGENT_MESSAGE_PHASE", {
    itemId: item.id,
    phase:
      item.phase === "commentary" || item.phase === "final_answer"
        ? item.phase
        : null,
  }),
];
```

Do not copy item text into the phase event. Continue to stream visible text only
through the existing `AGENT_MESSAGE_DELTA` event.

### Step 4: Run the focused API tests

Run:

```bash
pnpm --filter @codexplatform/api test -- event-normalizer.test.ts
pnpm --filter @codexplatform/api typecheck
```

Expected: PASS.

### Step 5: Commit

```bash
git add apps/api/src/infra/codex/event-normalizer.ts apps/api/src/infra/codex/event-normalizer.test.ts
git commit -m "feat: preserve Codex agent message phases"
```

## Task 3: Project a Turn Into Prompt, Execution and Final Answer

**Files:**

- Modify: `apps/web/src/thread-events.ts`
- Modify: `apps/web/src/thread-presentation.ts`
- Test: `apps/web/src/thread-events.test.ts`
- Test: `apps/web/src/thread-presentation.test.ts`

### Step 1: Write failing event-safety and projection tests

Add an event safety test proving `AGENT_MESSAGE_PHASE` survives replay but does not
become a free-standing transcript row.

Add a presentation fixture containing:

1. `TURN_STARTED`.
2. Commentary `AGENT_MESSAGE_DELTA` for `message-commentary`.
3. `AGENT_MESSAGE_PHASE` for `message-commentary = commentary`.
4. `COMMAND_STARTED`.
5. `COMMAND_COMPLETED`.
6. Final `AGENT_MESSAGE_DELTA` for `message-final`.
7. `AGENT_MESSAGE_PHASE` for `message-final = final_answer`.
8. `TURN_COMPLETED`.

Assert the projected Turn contains:

```ts
{
  prompt: expect.objectContaining({ text: "Fix the runtime" }),
  executionRows: [
    expect.objectContaining({
      kind: "assistant",
      itemId: "message-commentary",
      messagePhase: "commentary",
    }),
    expect.objectContaining({ kind: "activity", activityKind: "command" }),
  ],
  finalAnswer: expect.objectContaining({
    kind: "assistant",
    itemId: "message-final",
    messagePhase: "final_answer",
  }),
  startedAt: "2026-07-27T00:00:00.000Z",
  durationMs: 12_000,
  status: "COMPLETED",
  defaultExpanded: false,
}
```

Add cases for:

- Phase arriving after text delta.
- Phase arriving before text delta.
- Unknown/null phase stays in execution as commentary-safe content.
- Failed and interrupted Turns default to expanded.
- No final answer means a completed Turn stays expanded.
- Raw reasoning event types remain dropped.

### Step 2: Run the focused web tests and verify failure

Run:

```bash
pnpm --filter @codexplatform/web test -- thread-events.test.ts thread-presentation.test.ts
```

Expected: FAIL because phase events are not safe-listed and the projection has no
execution/final split.

### Step 3: Extend replay and event safety

Add `AGENT_MESSAGE_PHASE` to the safe conversation event types. Do not treat it as a
delta and do not render it directly.

The phase event must retain `itemId`, `turnId`, `sequence` and `phase` so replay
produces the same projection regardless of whether lifecycle metadata arrived before
or after text.

### Step 4: Replace row-only groups with Turn presentation groups

Define:

```ts
export type TurnExecutionStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED"
  | "NEEDS_RECOVERY";

export interface TranscriptTurnGroup {
  id: string;
  threadId: string;
  turnId: string;
  prompt: TranscriptUserRow | null;
  executionRows: TranscriptRow[];
  finalAnswer: TranscriptMessageRow | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  status: TurnExecutionStatus;
  currentAction: string;
  defaultExpanded: boolean;
}
```

Add `messagePhase` to assistant rows:

```ts
messagePhase: "commentary" | "final_answer" | null;
```

Build a phase map keyed by `turnId + itemId`, then classify agent message rows after
all events are collected. This makes the projection independent of event arrival
order.

Derive `currentAction` from active events using the priority in Product Semantics.
When no higher-priority action is active, use `Thinking`.

Exclude lifecycle-only phase events from visible rows.

### Step 5: Run focused tests and typecheck

Run:

```bash
pnpm --filter @codexplatform/web test -- thread-events.test.ts thread-presentation.test.ts
pnpm --filter @codexplatform/web typecheck
```

Expected: PASS.

### Step 6: Commit

```bash
git add apps/web/src/thread-events.ts apps/web/src/thread-events.test.ts apps/web/src/thread-presentation.ts apps/web/src/thread-presentation.test.ts
git commit -m "feat: project Codex turns into execution and final phases"
```

## Task 4: Render the Codex Turn Execution Group

**Files:**

- Create: `apps/web/src/components/thread/TurnExecutionGroup.tsx`
- Create: `apps/web/src/components/thread/TurnExecutionGroup.test.tsx`
- Modify: `apps/web/src/components/thread/Transcript.tsx`
- Modify: `apps/web/src/components/thread/Transcript.test.tsx`

### Step 1: Write failing component tests

Test these observable behaviors:

1. A running Turn shows `Working for 12s · Thinking` and its process is expanded.
2. The displayed timer advances with fake timers.
3. A completed Turn with a final answer shows `Worked for 12s`, has its process
   collapsed, and keeps the final answer visible.
4. Clicking the header expands a completed process.
5. Failed, interrupted and recovery-required Turns remain expanded.
6. Commentary appears inside the group.
7. Final answer appears after and outside the group.
8. Tool, approval, Subagent and Feishu activity use compact action rows.

Use accessible buttons and `aria-expanded` assertions rather than CSS-only tests.

### Step 2: Run the component tests and verify failure

Run:

```bash
pnpm --filter @codexplatform/web test -- TurnExecutionGroup.test.tsx Transcript.test.tsx
```

Expected: FAIL because the component and new Turn structure do not exist.

### Step 3: Implement elapsed-time formatting

Implement:

```ts
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
```

For running Turns, update elapsed time once per second from `startedAt`. For terminal
Turns, render the immutable `durationMs`.

### Step 4: Implement controlled automatic collapse

`TurnExecutionGroup` owns expansion state:

```ts
const [expanded, setExpanded] = useState(group.defaultExpanded);
const userToggled = useRef(false);

useEffect(() => {
  if (!userToggled.current) {
    setExpanded(group.defaultExpanded);
  }
}, [group.defaultExpanded]);
```

The header is a button with:

- Running: `Working for <elapsed> · <currentAction>`.
- Terminal: `Worked for <duration>`.

Render process rows only when expanded. Never hide `finalAnswer`.

### Step 5: Refactor Transcript

For each projected Turn:

```tsx
{group.prompt ? <UserMessage row={group.prompt} /> : null}
<TurnExecutionGroup group={group} renderRow={renderExecutionRow} />
{group.finalAnswer ? <AssistantMessage row={group.finalAnswer} /> : null}
```

Keep markdown rendering, links and detail-panel callbacks unchanged.

Remove large independent status cards for Tool, approval, Subagent and Feishu
activity. Their primary representation is the existing compact action-row renderer;
details continue to open in the side panel and command output continues to open in
the bottom panel.

### Step 6: Run component tests and typecheck

Run:

```bash
pnpm --filter @codexplatform/web test -- TurnExecutionGroup.test.tsx Transcript.test.tsx
pnpm --filter @codexplatform/web typecheck
```

Expected: PASS.

### Step 7: Commit

```bash
git add apps/web/src/components/thread/TurnExecutionGroup.tsx apps/web/src/components/thread/TurnExecutionGroup.test.tsx apps/web/src/components/thread/Transcript.tsx apps/web/src/components/thread/Transcript.test.tsx
git commit -m "feat: render Codex-style turn execution groups"
```

## Task 5: Match Codex Visual Hierarchy and Responsive Behavior

**Files:**

- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/app.test.tsx`
- Modify: `tests/e2e/workspace.spec.ts`

### Step 1: Add failing integration assertions

In the app test, assert:

- The current execution label is present while running.
- The final answer remains visible after completion.
- The completed process button has `aria-expanded="false"`.
- The Tool detail action still opens the side panel.
- The command action still opens the bottom terminal panel.

In Playwright, assert the same semantics on a real route and include a viewport where
the right and bottom panels coexist without covering the composer or final answer.

### Step 2: Run integration tests and verify failure

Run:

```bash
pnpm --filter @codexplatform/web test -- app.test.tsx
pnpm test:e2e -- --grep "Codex turn execution"
```

Expected: FAIL until the integration fixture and styling expose the new semantics.

### Step 3: Implement the visual hierarchy

Add styles for:

```css
.codex-turn-execution
.codex-turn-execution__toggle
.codex-turn-execution__elapsed
.codex-turn-execution__action
.codex-turn-execution__rows
.codex-turn-final-answer
```

Required behavior:

- No outer card around the execution group.
- Header is quiet, left-aligned and visually subordinate to the final answer.
- Action rows are single-line by default and wrap only their result summary.
- Expanded command output is not duplicated in the transcript.
- Final answer uses the existing readable markdown width.
- Narrow screens preserve prompt → execution → final answer order.
- Side and bottom panels resize the workspace instead of overlaying transcript content.

### Step 4: Run integration tests

Run:

```bash
pnpm --filter @codexplatform/web test -- app.test.tsx
pnpm test:e2e -- --grep "Codex turn execution"
```

Expected: PASS.

### Step 5: Commit

```bash
git add apps/web/src/styles.css apps/web/src/app.test.tsx tests/e2e/workspace.spec.ts
git commit -m "style: align turn execution with Codex"
```

## Task 6: Full Verification and Real-Page UAT

**Files:**

- Modify if required by verified behavior: files from Tasks 1-5 only
- Document evidence: `docs/research/codex-turn-parity-uat.md`

### Step 1: Run focused regression tests

Run:

```bash
pnpm --filter @codexplatform/contracts test
pnpm --filter @codexplatform/api test -- event-normalizer.test.ts
pnpm --filter @codexplatform/web test -- thread-events.test.ts thread-presentation.test.ts TurnExecutionGroup.test.tsx Transcript.test.tsx app.test.tsx
```

Expected: PASS.

### Step 2: Run repository verification

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm verify
```

Expected: PASS with no protocol-schema or sensitive-field regressions.

### Step 3: Run real-page UAT

Start the current real runtime using the repository's documented development command.
Submit a Turn that produces:

- Commentary.
- A reasoning summary.
- At least one command.
- At least one Tool call.
- A final answer.

Verify:

- The timer starts when `TURN_STARTED` arrives.
- Current action changes with the live event stream.
- Commentary and actions stream in order.
- The final answer is not rendered inside the execution group.
- Completion collapses the process automatically.
- Manual expansion reveals the preserved process.
- Side panel, bottom panel and composer coexist without occlusion.
- Browser payloads and logs contain no raw reasoning fields.

Record the tested route, event sequence, screenshots and pass/fail results in:

`docs/research/codex-turn-parity-uat.md`.

### Step 4: Inspect the final diff

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Review for:

- No unrelated user changes removed.
- No credentials.
- No raw reasoning fields.
- No fake unsupported App Server controls.
- No large event cards remaining in the Turn transcript.

### Step 5: Commit UAT evidence

```bash
git add docs/research/codex-turn-parity-uat.md
git commit -m "test: document Codex turn parity UAT"
```

### Step 6: Update the existing pull request

Push the current feature branch and update the PR description with:

- Observable parity delivered.
- Contract and normalizer changes.
- Automated verification commands and results.
- Real-page UAT route and screenshots.
- Remaining deliberate differences: enterprise identity, policy, audit and account
  governance.
