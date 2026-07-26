import { describe, expect, test } from "vitest";
import { CodexEventNormalizer } from "./event-normalizer.js";

describe("CodexEventNormalizer", () => {
  test("normalizes the user-visible Codex lifecycle and never emits raw reasoning content", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });
    const messages = [
      { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Hello" },
      },
      {
        method: "turn/plan/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [{ step: "Inspect", status: "inProgress" }],
        },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "commandExecution", id: "cmd-1", command: "pnpm test", cwd: "/repo" },
        },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "PASS" },
      },
      {
        method: "turn/diff/updated",
        params: { threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/a b/a" },
      },
      {
        method: "item/reasoning/textDelta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "secret" },
      },
    ];

    const events = messages.flatMap((message) => normalizer.normalizeNotification(message));

    expect(events.map((event) => event.type)).toEqual([
      "TURN_STARTED",
      "AGENT_MESSAGE_DELTA",
      "PLAN_UPDATED",
      "COMMAND_STARTED",
      "COMMAND_OUTPUT",
      "DIFF_UPDATED",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("normalizes command completion, dynamic tools, approvals, and turn failure", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });
    const command = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test",
          cwd: "/repo",
          status: "completed",
          exitCode: 0,
          durationMs: 42,
        },
      },
    });
    const tool = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "feishu_doc_read",
          arguments: { url: "https://example.test" },
          success: true,
          durationMs: 25,
        },
      },
    });
    const approval = normalizer.normalizeServerRequest({
      id: "approval-1",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "change-1",
        reason: "write file",
      },
    });
    const failure = normalizer.normalizeNotification({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "failed", error: { message: "boom" } },
      },
    });

    expect(command).toEqual([expect.objectContaining({ type: "COMMAND_COMPLETED" })]);
    expect(tool).toEqual([expect.objectContaining({ type: "TOOL_COMPLETED" })]);
    expect(approval).toEqual(expect.objectContaining({ type: "APPROVAL_REQUESTED" }));
    expect(failure).toEqual([expect.objectContaining({ type: "TURN_FAILED" })]);
  });

  test("only exposes reasoning summaries and drops every raw reasoning field", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const summary = normalizer.normalizeNotification({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reason-1",
        delta: "Inspect the repository.",
        reasoningTextDelta: "private reasoning",
        content: "private content",
        encrypted_content: "ciphertext",
      },
    });
    const raw = normalizer.normalizeNotification({
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reason-1",
        delta: "private reasoning",
        content: "private content",
        encrypted_content: "ciphertext",
      },
    });

    expect(summary).toEqual([
      expect.objectContaining({
        itemId: "reason-1",
        type: "REASONING_SUMMARY_DELTA",
        payload: { itemId: "reason-1", delta: "Inspect the repository." },
      }),
    ]);
    expect(raw).toEqual([]);
    expect(JSON.stringify(summary)).not.toMatch(
      /private reasoning|private content|ciphertext|reasoningTextDelta|encrypted_content/,
    );
  });

  test("drops malformed item events instead of inventing a type-plus-Turn item boundary", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });
    const malformed = [
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "message" },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "summary" },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "thread-1", turnId: "turn-1", delta: "output" },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "commandExecution", command: "pwd", cwd: "/workspace" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "dynamicToolCall", tool: "demo", status: "completed" },
        },
      },
    ];

    expect(malformed.flatMap((message) => normalizer.normalizeNotification(message))).toEqual([]);
    expect(
      normalizer.normalizeServerRequest({
        id: 9,
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-1", turnId: "turn-1" },
      }),
    ).toBeNull();
  });

  test("normalizes only observable subagent activity and ignores unknown protocol events", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const started = normalizer.normalizeNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "subagent-activity-1",
          kind: "started",
          agentThreadId: "agent-thread-1",
          agentPath: "research/repository-audit",
        },
      },
    });
    const completed = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "wait",
          status: "completed",
          senderThreadId: "thread-1",
          receiverThreadIds: ["agent-thread-1"],
          prompt: null,
          model: "gpt-5",
          reasoningEffort: "high",
          agentsStates: {
            "agent-thread-1": { status: "completed", message: "No critical findings" },
          },
        },
      },
    });
    const unknown = normalizer.normalizeNotification({
      method: "experimental/futureSubagentEvent",
      params: { agentThreadId: "agent-thread-secret", content: "must not leak" },
    });

    expect(started).toEqual([
      expect.objectContaining({
        itemId: "subagent-activity-1",
        type: "SUBAGENT_ACTIVITY",
        payload: expect.objectContaining({
          agentThreadId: "agent-thread-1",
          name: "repository-audit",
          status: "ACTIVE",
        }),
      }),
    ]);
    expect(completed).toEqual([
      expect.objectContaining({
        itemId: "collab-1:agent-thread-1",
        type: "SUBAGENT_ACTIVITY",
        payload: expect.objectContaining({
          agentThreadId: "agent-thread-1",
          status: "DONE",
          resultSummary: "No critical findings",
        }),
      }),
    ]);
    expect(unknown).toEqual([]);
  });

  test("normalizes the generated thread token-usage snapshot without inventing quota semantics", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    expect(
      normalizer.normalizeNotification({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 120,
              inputTokens: 80,
              cachedInputTokens: 20,
              outputTokens: 40,
              reasoningOutputTokens: 10,
            },
            last: {
              totalTokens: 20,
              inputTokens: 12,
              cachedInputTokens: 2,
              outputTokens: 8,
              reasoningOutputTokens: 3,
            },
            modelContextWindow: 200_000,
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "TOKEN_USAGE_UPDATED",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "token-usage:thread-1",
        payload: {
          total: {
            totalTokens: 120,
            inputTokens: 80,
            cachedInputTokens: 20,
            outputTokens: 40,
            reasoningOutputTokens: 10,
          },
          last: {
            totalTokens: 20,
            inputTokens: 12,
            cachedInputTokens: 2,
            outputTokens: 8,
            reasoningOutputTokens: 3,
          },
          modelContextWindow: 200_000,
        },
      }),
    ]);
  });
});
