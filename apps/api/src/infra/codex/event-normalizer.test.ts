import { describe, expect, test } from "vitest";
import { CodexEventNormalizer } from "./event-normalizer.js";

describe("CodexEventNormalizer", () => {
  test("redacts only known runtime paths from commands, cwd, approvals, and errors", () => {
    const runtimeDataDir = "/private/var/folders/runtime/CODEX_HOME_SENTINEL_NORMALIZER_9f83";
    const codexHome = `${runtimeDataDir}/codex-accounts/codex-private`;
    const workspaceDir = `${runtimeDataDir}/workspaces/task-1`;
    const normalizer = new CodexEventNormalizer({
      taskId: "task-1",
      runtimeDataDir,
      codexHome,
      workspaceDir,
    });

    const events = [
      normalizer.normalizeNotification({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "cmd-1",
            command: `CODEX_HOME=${codexHome} node ${workspaceDir}/script.js packages/app/src/index.ts`,
            cwd: workspaceDir,
          },
        },
      }),
      normalizer.normalizeNotification({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "cmd-1",
            command: `cat ${codexHome}/auth.json`,
            aggregatedOutput: `failed under ${runtimeDataDir}`,
            exitCode: 1,
            durationMs: 5,
          },
        },
      }),
      normalizer.normalizeNotification({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: `cannot read ${codexHome}/auth.json` },
          },
        },
      }),
    ].flat();
    const approval = normalizer.normalizeServerRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "cmd-2",
        command: `ls ${codexHome}`,
        cwd: workspaceDir,
        reason: `inspect ${runtimeDataDir}`,
      },
    });
    const serialized = JSON.stringify({ events, approval });

    expect(serialized).not.toContain(runtimeDataDir);
    expect(serialized).not.toContain("CODEX_HOME_SENTINEL_NORMALIZER_9f83");
    expect(serialized).toContain("[CODEX_HOME]");
    expect(serialized).toContain("[WORKSPACE]");
    expect(serialized).toContain("packages/app/src/index.ts");
  });

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

  test("normalizes agent message phase metadata without copying message or reasoning content", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });
    const started = normalizer.normalizeNotification({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-1",
          text: "Visible final answer",
          phase: "final_answer",
          content: "private content",
          encrypted_content: "ciphertext",
        },
      },
    });
    const completedWithUnknownPhase = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-2",
          text: "Visible commentary",
          phase: null,
          reasoningTextDelta: "private reasoning",
        },
      },
    });

    expect(started).toEqual([
      expect.objectContaining({
        type: "AGENT_MESSAGE_PHASE",
        payload: { itemId: "message-1", phase: "final_answer" },
      }),
    ]);
    expect(completedWithUnknownPhase).toEqual([
      expect.objectContaining({
        type: "AGENT_MESSAGE_PHASE",
        payload: { itemId: "message-2", phase: null },
      }),
    ]);
    expect(JSON.stringify({ started, completedWithUnknownPhase })).not.toMatch(
      /Visible final answer|Visible commentary|private content|ciphertext|private reasoning/,
    );
  });

  test("emits a final answer delivered only by item completion", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const events = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-final",
          text: "<proposed_plan>Final plan</proposed_plan>",
          phase: "final_answer",
          content: "private content",
          encrypted_content: "ciphertext",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "AGENT_MESSAGE_PHASE",
        payload: { itemId: "message-final", phase: "final_answer" },
      }),
      expect.objectContaining({
        type: "AGENT_MESSAGE_DELTA",
        payload: {
          itemId: "message-final",
          delta: "<proposed_plan>Final plan</proposed_plan>",
        },
      }),
      expect.objectContaining({
        type: "PROPOSED_PLAN_PUBLISHED",
        payload: {
          itemId: "message-final",
          markdown: "Final plan",
          title: "Final plan",
        },
      }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private content|ciphertext/);
  });

  test("does not duplicate agent message text already delivered as deltas", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });
    normalizer.normalizeNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-final",
        delta: "Final plan",
      },
    });

    const events = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-final",
          text: "Final plan",
          phase: "final_answer",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "AGENT_MESSAGE_PHASE",
        payload: { itemId: "message-final", phase: "final_answer" },
      }),
    ]);
  });

  test("normalizes a final answer delivered by raw response item completion", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const events = normalizer.normalizeNotification({
      method: "rawResponseItem/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "message",
          id: "message-final",
          role: "assistant",
          phase: "final_answer",
          content: [
            { type: "output_text", text: "<proposed_plan>Final plan</proposed_plan>" },
            { type: "input_text", text: "private input" },
          ],
          encrypted_content: "ciphertext",
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "AGENT_MESSAGE_PHASE",
        payload: { itemId: "message-final", phase: "final_answer" },
      }),
      expect.objectContaining({
        type: "AGENT_MESSAGE_DELTA",
        payload: {
          itemId: "message-final",
          delta: "<proposed_plan>Final plan</proposed_plan>",
        },
      }),
      expect.objectContaining({
        type: "PROPOSED_PLAN_PUBLISHED",
        payload: {
          itemId: "message-final",
          markdown: "Final plan",
          title: "Final plan",
        },
      }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private input|ciphertext/);
  });

  test("publishes a complete Markdown Plan without leaking content outside the envelope", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const events = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "message-final",
          text: [
            "<proposed_plan>",
            "# 华东出差计划",
            "",
            "## 行程",
            "- 上海",
            "- 杭州",
            "</proposed_plan>",
          ].join("\n"),
          phase: "final_answer",
        },
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "PROPOSED_PLAN_PUBLISHED",
        payload: {
          itemId: "message-final",
          markdown: "# 华东出差计划\n\n## 行程\n- 上海\n- 杭州",
          title: "华东出差计划",
        },
      }),
    );
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
          aggregatedOutput: "PASS\n",
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
          contentItems: [{ type: "inputText", text: '{"title":"UAT result"}' }],
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

    expect(command).toEqual([
      expect.objectContaining({
        type: "COMMAND_COMPLETED",
        payload: {
          itemId: "cmd-1",
          command: "pnpm test",
          aggregatedOutput: "PASS\n",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    ]);
    expect(tool).toEqual([
      expect.objectContaining({
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-1",
          tool: "feishu_doc_read",
          result: [{ type: "inputText", text: '{"title":"UAT result"}' }],
          durationMs: 25,
        },
      }),
    ]);
    expect(approval).toEqual(expect.objectContaining({ type: "APPROVAL_REQUESTED" }));
    expect(failure).toEqual([expect.objectContaining({ type: "TURN_FAILED" })]);
  });

  test("normalizes the official MCP result field without exposing unrelated item fields", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const tool = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "mcpToolCall",
          id: "tool-1",
          server: "enterprise",
          tool: "business_read",
          status: "completed",
          arguments: { id: "order-1" },
          result: {
            content: [{ type: "text", text: "PAID" }],
            structuredContent: { id: "order-1", status: "PAID" },
            _meta: null,
          },
          durationMs: 17,
          privateTransportState: "must-not-leak",
        },
      },
    });

    expect(tool).toEqual([
      expect.objectContaining({
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-1",
          tool: "business_read",
          result: {
            content: [{ type: "text", text: "PAID" }],
            structuredContent: { id: "order-1", status: "PAID" },
            _meta: null,
          },
          durationMs: 17,
        },
      }),
    ]);
    expect(JSON.stringify(tool)).not.toContain("privateTransportState");
  });

  test("normalizes a completed Tool without an official result as null", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const tool = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          tool: "empty_tool",
          status: "completed",
          success: true,
          contentItems: null,
          durationMs: 3,
        },
      },
    });

    expect(tool).toEqual([
      expect.objectContaining({
        type: "TOOL_COMPLETED",
        payload: expect.objectContaining({ result: null }),
      }),
    ]);
  });

  test("normalizes a missing command output snapshot as null", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const command = normalizer.normalizeNotification({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "true",
          cwd: "/repo",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 1,
        },
      },
    });

    expect(command).toEqual([
      expect.objectContaining({
        type: "COMMAND_COMPLETED",
        payload: expect.objectContaining({ aggregatedOutput: null }),
      }),
    ]);
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

  test("normalizes model reroutes without retaining provider-specific or sensitive fields", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const events = normalizer.normalizeNotification({
      method: "model/rerouted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        fromModel: "requested-model",
        toModel: "actual-model",
        reason: "highRiskCyberActivity",
        providerTraceId: "provider-secret",
        reasoningTextDelta: "private reasoning",
        content: "private content",
        encrypted_content: "ciphertext",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
        type: "MODEL_REROUTED",
        payload: {
          fromModel: "requested-model",
          toModel: "actual-model",
          reason: "SAFETY_POLICY",
        },
      }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /highRiskCyberActivity|provider-secret|private reasoning|private content|ciphertext|encrypted_content/,
    );
  });

  test("normalizes runtime warnings through an explicit field allowlist", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const events = normalizer.normalizeNotification({
      method: "warning",
      params: {
        threadId: "thread-1",
        message: "The selected capability is temporarily unavailable.",
        providerPayload: { retryAfter: 30 },
        reasoningTextDelta: "private reasoning",
        encrypted_content: "ciphertext",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        turnId: null,
        type: "RUNTIME_WARNING",
        payload: { message: "The selected capability is temporarily unavailable." },
      }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /providerPayload|retryAfter|private reasoning|ciphertext|encrypted_content/,
    );
  });

  test("normalizes context compaction as an observable lifecycle event only", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    const events = normalizer.normalizeNotification({
      method: "thread/compacted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        rawProviderPayload: { discardedTokens: 12_345 },
        content: "private content",
        encrypted_content: "ciphertext",
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
        type: "CONTEXT_COMPACTED",
        payload: { status: "completed" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /rawProviderPayload|discardedTokens|private content|ciphertext|encrypted_content/,
    );
  });

  test("drops malformed model reroutes and runtime notices instead of inventing display data", () => {
    const normalizer = new CodexEventNormalizer({ taskId: "task-1" });

    expect(
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "requested-model",
          },
        },
        { method: "warning", params: { threadId: "thread-1", message: "" } },
        { method: "thread/compacted", params: { threadId: "thread-1" } },
      ].flatMap((message) => normalizer.normalizeNotification(message)),
    ).toEqual([]);
  });
});
