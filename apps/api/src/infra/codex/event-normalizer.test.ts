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
});
