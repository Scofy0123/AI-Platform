import type { SubagentThread, TaskEvent, Turn } from "@codexplatform/contracts";
import { describe, expect, test } from "vitest";
import {
  projectThreadPresentation,
  selectChangeDetails,
  selectOutputResources,
  selectPlanDetails,
  selectSourceResources,
  selectTerminalDetails,
  selectToolDetails,
} from "./thread-presentation.js";

const CONFIG = {
  model: "fake-codex-standard",
  reasoningEffort: "medium",
  permissionMode: "DEFAULT",
  approvalMode: "ASK",
  personality: "PRAGMATIC",
  instructions: "",
  sourceVersion: "test",
} as const;

function turn(id: string, prompt: string, status: Turn["status"] = "COMPLETED"): Turn {
  return {
    id,
    threadId: "thread-1",
    prompt,
    status,
    startedAt: `2026-07-27T12:00:0${id === "turn-1" ? "1" : "2"}.000Z`,
    completedAt: status === "RUNNING" ? null : "2026-07-27T12:01:00.000Z",
    durationMs: status === "RUNNING" ? null : 59_000,
    model: CONFIG.model,
    effort: CONFIG.reasoningEffort,
    permissionMode: CONFIG.permissionMode,
    configSnapshot: CONFIG,
  };
}

function event(input: {
  sequence: number;
  turnId: string | null;
  itemId: string;
  type: string;
  payload: Record<string, unknown>;
  threadId?: string;
}): TaskEvent {
  return {
    taskId: "thread-1",
    threadId: input.threadId ?? "thread-1",
    turnId: input.turnId,
    itemId: input.itemId,
    sequence: input.sequence,
    timestamp: `2026-07-27T12:00:${String(input.sequence).padStart(2, "0")}.000Z`,
    type: input.type,
    payload: input.payload,
  } as TaskEvent;
}

function subagent(parentTurnId: string): SubagentThread {
  return {
    threadId: "agent-thread-1",
    parentThreadId: "thread-1",
    parentTurnId,
    sessionId: null,
    name: "reviewer",
    role: "review",
    model: null,
    effort: null,
    status: "DONE",
    startedAt: "2026-07-27T12:00:10.000Z",
    completedAt: "2026-07-27T12:00:20.000Z",
    elapsedMs: 10_000,
    resultSummary: "No findings",
    tokenUsage: null,
  };
}

describe("Thread presentation projection", () => {
  test("projects a final proposed Plan into the transcript and pinned Plan panel", () => {
    const events = [
      event({
        sequence: 1,
        turnId: "turn-1",
        itemId: "message-final",
        type: "AGENT_MESSAGE_DELTA",
        payload: {
          itemId: "message-final",
          delta: "<proposed_plan>\n# 华东出差计划\n\n- 上海\n- 杭州\n</proposed_plan>",
        },
      }),
      event({
        sequence: 2,
        turnId: "turn-1",
        itemId: "message-final",
        type: "AGENT_MESSAGE_PHASE",
        payload: { itemId: "message-final", phase: "final_answer" },
      }),
      event({
        sequence: 3,
        turnId: "turn-1",
        itemId: "message-final",
        type: "PROPOSED_PLAN_PUBLISHED",
        payload: {
          itemId: "message-final",
          markdown: "# 华东出差计划\n\n- 上海\n- 杭州",
          title: "华东出差计划",
        },
      }),
    ];

    const presentation = projectThreadPresentation(events, [turn("turn-1", "制定出差计划")], []);

    expect(presentation.transcript.groups[0]?.finalAnswer?.text).toBe(
      "# 华东出差计划\n\n- 上海\n- 杭州",
    );
    expect(presentation.side.plan).toEqual(
      expect.objectContaining({
        itemId: "message-final",
        title: "华东出差计划",
        markdown: "# 华东出差计划\n\n- 上海\n- 杭州",
      }),
    );
    expect(presentation.pinned?.plan?.title).toBe("华东出差计划");
  });

  test("separates Codex commentary execution from the final answer independent of phase arrival order", () => {
    const presentation = projectThreadPresentation(
      [
        event({
          sequence: 1,
          turnId: "turn-1",
          itemId: "turn:turn-1",
          type: "TURN_STARTED",
          payload: { status: "inProgress" },
        }),
        event({
          sequence: 2,
          turnId: "turn-1",
          itemId: "message-commentary",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-commentary", delta: "I’m inspecting the runtime." },
        }),
        event({
          sequence: 3,
          turnId: "turn-1",
          itemId: "message-commentary",
          type: "AGENT_MESSAGE_PHASE",
          payload: { itemId: "message-commentary", phase: "commentary" },
        }),
        event({
          sequence: 4,
          turnId: "turn-1",
          itemId: "cmd-1",
          type: "COMMAND_STARTED",
          payload: { itemId: "cmd-1", command: "pnpm test", cwd: "/repo" },
        }),
        event({
          sequence: 5,
          turnId: "turn-1",
          itemId: "cmd-1",
          type: "COMMAND_COMPLETED",
          payload: {
            itemId: "cmd-1",
            command: "pnpm test",
            aggregatedOutput: "PASS",
            exitCode: 0,
            durationMs: 1_000,
          },
        }),
        event({
          sequence: 6,
          turnId: "turn-1",
          itemId: "message-final",
          type: "AGENT_MESSAGE_PHASE",
          payload: { itemId: "message-final", phase: "final_answer" },
        }),
        event({
          sequence: 7,
          turnId: "turn-1",
          itemId: "message-final",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-final", delta: "The runtime is fixed." },
        }),
        event({
          sequence: 8,
          turnId: "turn-1",
          itemId: "turn:turn-1",
          type: "TURN_COMPLETED",
          payload: { status: "completed", durationMs: 59_000 },
        }),
      ],
      [turn("turn-1", "Fix the runtime")],
      [],
    );

    expect(presentation.transcript.groups[0]).toMatchObject({
      prompt: expect.objectContaining({ kind: "user", text: "Fix the runtime" }),
      executionRows: [
        expect.objectContaining({
          kind: "assistant",
          itemId: "message-commentary",
          messagePhase: "commentary",
        }),
        expect.objectContaining({ kind: "command", itemId: "cmd-1" }),
        expect.objectContaining({ kind: "status", status: "completed" }),
      ],
      finalAnswer: expect.objectContaining({
        kind: "assistant",
        itemId: "message-final",
        text: "The runtime is fixed.",
        messagePhase: "final_answer",
      }),
      startedAt: "2026-07-27T12:00:01.000Z",
      completedAt: "2026-07-27T12:01:00.000Z",
      durationMs: 59_000,
      status: "COMPLETED",
      currentAction: "Thinking",
      defaultExpanded: false,
    });
  });

  test.each(["FAILED", "INTERRUPTED", "NEEDS_RECOVERY"] as const)(
    "keeps a %s Turn execution process expanded",
    (status) => {
      const presentation = projectThreadPresentation(
        [],
        [turn("turn-1", "Recover it", status)],
        [],
      );

      expect(presentation.transcript.groups[0]).toMatchObject({
        status,
        defaultExpanded: true,
        finalAnswer: null,
      });
    },
  );

  test("coalesces message deltas within an exact Thread, Turn and Item boundary", () => {
    const presentation = projectThreadPresentation(
      [
        event({
          sequence: 1,
          turnId: "turn-1",
          itemId: "message-1",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-1", delta: "First " },
        }),
        event({
          sequence: 2,
          turnId: "turn-1",
          itemId: "message-1",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-1", delta: "answer" },
        }),
        event({
          sequence: 3,
          turnId: "turn-2",
          itemId: "message-1",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-1", delta: "Second answer" },
        }),
        event({
          sequence: 4,
          threadId: "thread-2",
          turnId: "turn-2",
          itemId: "message-1",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-1", delta: "Other Thread answer" },
        }),
      ],
      [turn("turn-1", "First question"), turn("turn-2", "Second question")],
      [],
    );

    expect(
      presentation.transcript.groups.map((group) => ({
        threadId: group.threadId,
        turnId: group.turnId,
        rows: group.rows.map((row) => ({ kind: row.kind, text: row.text })),
      })),
    ).toEqual([
      {
        threadId: "thread-1",
        turnId: "turn-1",
        rows: [
          { kind: "user", text: "First question" },
          { kind: "assistant", text: "First answer" },
        ],
      },
      {
        threadId: "thread-1",
        turnId: "turn-2",
        rows: [
          { kind: "user", text: "Second question" },
          { kind: "assistant", text: "Second answer" },
        ],
      },
      {
        threadId: "thread-2",
        turnId: "turn-2",
        rows: [{ kind: "assistant", text: "Other Thread answer" }],
      },
    ]);
  });

  test("orders Turn groups chronologically instead of depending on API array order", () => {
    const presentation = projectThreadPresentation(
      [
        event({
          sequence: 2,
          turnId: "turn-2",
          itemId: "message-2",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-2", delta: "Later" },
        }),
        event({
          sequence: 1,
          turnId: "turn-1",
          itemId: "message-1",
          type: "AGENT_MESSAGE_DELTA",
          payload: { itemId: "message-1", delta: "Earlier" },
        }),
      ],
      [turn("turn-2", "Second question"), turn("turn-1", "First question")],
      [],
    );

    expect(presentation.transcript.groups.map((group) => group.turnId)).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });

  test("projects every supported Item family into stable vendor-independent rows", () => {
    const events = [
      event({
        sequence: 1,
        turnId: "turn-1",
        itemId: "assistant-1",
        type: "AGENT_MESSAGE_DELTA",
        payload: { itemId: "assistant-1", delta: "Done." },
      }),
      event({
        sequence: 2,
        turnId: "turn-1",
        itemId: "steer-1",
        type: "USER_MESSAGE",
        payload: { itemId: "steer-1", kind: "STEER", text: "Check tests too." },
      }),
      event({
        sequence: 3,
        turnId: "turn-1",
        itemId: "reason-1",
        type: "REASONING_SUMMARY_DELTA",
        payload: { itemId: "reason-1", delta: "Inspect, " },
      }),
      event({
        sequence: 4,
        turnId: "turn-1",
        itemId: "reason-1",
        type: "REASONING_SUMMARY_DELTA",
        payload: { itemId: "reason-1", delta: "then verify." },
      }),
      event({
        sequence: 5,
        turnId: "turn-1",
        itemId: "plan:turn-1",
        type: "PLAN_UPDATED",
        payload: {
          explanation: "Implementation plan",
          plan: [{ step: "Inspect", status: "completed" }],
        },
      }),
      event({
        sequence: 6,
        turnId: "turn-1",
        itemId: "cmd-1",
        type: "COMMAND_STARTED",
        payload: { itemId: "cmd-1", command: "pnpm test", cwd: "/repo" },
      }),
      event({
        sequence: 7,
        turnId: "turn-1",
        itemId: "cmd-1",
        type: "COMMAND_OUTPUT",
        payload: { itemId: "cmd-1", delta: "all green\n" },
      }),
      event({
        sequence: 8,
        turnId: "turn-1",
        itemId: "cmd-1",
        type: "COMMAND_COMPLETED",
        payload: {
          itemId: "cmd-1",
          command: "pnpm test",
          aggregatedOutput: "all green\n",
          exitCode: 0,
          durationMs: 12,
        },
      }),
      event({
        sequence: 9,
        turnId: "turn-1",
        itemId: "tool-1",
        type: "TOOL_STARTED",
        payload: { itemId: "tool-1", tool: "read_document", arguments: { id: "doc-1" } },
      }),
      event({
        sequence: 10,
        turnId: "turn-1",
        itemId: "tool-1",
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-1",
          tool: "read_document",
          result: { title: "PRD" },
          durationMs: 8,
        },
      }),
      event({
        sequence: 11,
        turnId: "turn-1",
        itemId: "diff-1",
        type: "DIFF_UPDATED",
        payload: { diff: "+++ b/file.ts\n+export const value = 1;" },
      }),
      event({
        sequence: 12,
        turnId: "turn-1",
        itemId: "approval-command-1",
        type: "APPROVAL_REQUESTED",
        payload: {
          approvalId: "approval-1",
          itemId: "approval-command-1",
          approvalType: "COMMAND",
          reason: "Needs permission",
          command: "deploy",
          cwd: "/repo",
        },
      }),
      event({
        sequence: 13,
        turnId: "turn-1",
        itemId: "approval:approval-1",
        type: "APPROVAL_DECIDED",
        payload: { approvalId: "approval-1", decision: "accept" },
      }),
      event({
        sequence: 14,
        turnId: "turn-1",
        itemId: "turn:turn-1",
        type: "TURN_STARTED",
        payload: { status: "inProgress" },
      }),
      event({
        sequence: 15,
        turnId: "turn-1",
        itemId: "turn:turn-1",
        type: "TURN_COMPLETED",
        payload: { status: "completed", durationMs: 100 },
      }),
      event({
        sequence: 16,
        turnId: "turn-1",
        itemId: "agent-activity-1",
        type: "SUBAGENT_ACTIVITY",
        payload: {
          itemId: "agent-activity-1",
          agentThreadId: "agent-thread-1",
          kind: "completed",
          name: "reviewer",
          role: "review",
          model: null,
          effort: null,
          status: "DONE",
          resultSummary: "No findings",
        },
      }),
    ];

    const presentation = projectThreadPresentation(events, [turn("turn-1", "Implement it")], []);
    const rows = presentation.transcript.rows;

    expect(rows.map((row) => row.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "reasoning-summary",
      "plan",
      "command",
      "tool",
      "diff",
      "approval",
      "status",
      "subagent",
    ]);
    expect(rows.filter((row) => row.itemId === "cmd-1")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "approval")).toEqual([
      expect.objectContaining({ itemId: "approval-command-1", status: "accepted" }),
    ]);
    expect(presentation.transcript.groups[0]?.executionRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", itemId: "steer-1", text: "Check tests too." }),
      ]),
    );
    expect(presentation.transcript.activities.map((row) => row.kind)).toEqual([
      "command",
      "tool",
      "diff",
      "approval",
      "status",
      "subagent",
    ]);
    expect(JSON.stringify(presentation.transcript)).not.toContain("all green");
  });

  test("drops provider reasoning events and raw reasoning transport fields", () => {
    const presentation = projectThreadPresentation(
      [
        event({
          sequence: 1,
          turnId: "turn-1",
          itemId: "reason-raw",
          type: "PROVIDER_REASONING_TEXT",
          payload: { itemId: "reason-raw", delta: "reasoning-canary" },
        }),
        event({
          sequence: 2,
          turnId: "turn-1",
          itemId: "reason-summary",
          type: "REASONING_SUMMARY_DELTA",
          payload: {
            itemId: "reason-summary",
            delta: "Safe execution summary",
            reasoningTextDelta: "reasoning-canary",
            reasoning_text_delta: "reasoning-canary",
            content: "reasoning-canary",
            encrypted_content: "reasoning-canary",
          },
        }),
        event({
          sequence: 3,
          turnId: "turn-1",
          itemId: "plan:turn-1",
          type: "PLAN_UPDATED",
          payload: {
            explanation: "Safe plan",
            plan: [
              {
                step: "Inspect",
                status: "completed",
                content: "reasoning-canary",
                reasoningTextDelta: "reasoning-canary",
              },
            ],
          },
        }),
      ],
      [turn("turn-1", "Inspect safely")],
      [],
    );

    expect(presentation.visibleText).toContain("Safe execution summary");
    expect(presentation.visibleText).not.toContain("reasoning-canary");
    expect(JSON.stringify(presentation)).not.toContain("reasoning-canary");
  });

  test("projects model reroutes, warnings and compaction as readable runtime status", () => {
    const presentation = projectThreadPresentation(
      [
        event({
          sequence: 1,
          turnId: "turn-1",
          itemId: "model-rerouted:turn-1",
          type: "MODEL_REROUTED",
          payload: {
            fromModel: "gpt-codex-a",
            toModel: "gpt-codex-b",
            reason: "AVAILABILITY",
          },
        }),
        event({
          sequence: 2,
          turnId: "turn-1",
          itemId: "runtime-warning:turn-1",
          type: "RUNTIME_WARNING",
          payload: { message: "Runtime is retrying a safe read" },
        }),
        event({
          sequence: 3,
          turnId: "turn-1",
          itemId: "context-compacted:turn-1",
          type: "CONTEXT_COMPACTED",
          payload: { status: "completed" },
        }),
      ],
      [turn("turn-1", "Continue")],
      [],
    );

    expect(presentation.transcript.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          status: "model-rerouted",
          text: "模型已从 gpt-codex-a 切换至 gpt-codex-b（AVAILABILITY）",
        }),
        expect.objectContaining({
          kind: "status",
          status: "runtime-warning",
          text: "Runtime is retrying a safe read",
        }),
        expect.objectContaining({
          kind: "status",
          status: "context-compacted",
          text: "上下文已自动压缩",
        }),
      ]),
    );
  });

  test("preserves repeated runtime notices instead of folding them by provider item id", () => {
    const presentation = projectThreadPresentation(
      [
        event({
          sequence: 1,
          turnId: "turn-1",
          itemId: "runtime-warning:turn-1",
          type: "RUNTIME_WARNING",
          payload: { message: "First warning" },
        }),
        event({
          sequence: 2,
          turnId: "turn-1",
          itemId: "runtime-warning:turn-1",
          type: "RUNTIME_WARNING",
          payload: { message: "Second warning" },
        }),
      ],
      [turn("turn-1", "Inspect runtime")],
      [],
    );

    expect(
      presentation.transcript.rows
        .filter((row) => row.kind === "status" && row.status === "runtime-warning")
        .map((row) => row.text),
    ).toEqual(["First warning", "Second warning"]);
  });

  test("derives pinned, side and bottom Panel data without inventing outputs or sources", () => {
    const events = [
      event({
        sequence: 1,
        turnId: "turn-1",
        itemId: "plan:turn-1",
        type: "PLAN_UPDATED",
        payload: { explanation: "Old plan", plan: [{ step: "Old", status: "completed" }] },
      }),
      event({
        sequence: 2,
        turnId: "turn-2",
        itemId: "plan:turn-2",
        type: "PLAN_UPDATED",
        payload: { explanation: "Current plan", plan: [{ step: "Run", status: "in_progress" }] },
      }),
      event({
        sequence: 3,
        turnId: "turn-2",
        itemId: "cmd-1",
        type: "COMMAND_STARTED",
        payload: { itemId: "cmd-1", command: "pnpm test", cwd: "/repo" },
      }),
      event({
        sequence: 4,
        turnId: "turn-2",
        itemId: "cmd-1",
        type: "COMMAND_OUTPUT",
        payload: { itemId: "cmd-1", delta: "complete command output\n" },
      }),
      event({
        sequence: 5,
        turnId: "turn-2",
        itemId: "cmd-1",
        type: "COMMAND_COMPLETED",
        payload: {
          itemId: "cmd-1",
          command: "pnpm test",
          aggregatedOutput: "complete command output\n",
          exitCode: 0,
          durationMs: 25,
        },
      }),
      event({
        sequence: 6,
        turnId: "turn-2",
        itemId: "diff-1",
        type: "DIFF_UPDATED",
        payload: { diff: "+++ b/report.md\n+result" },
      }),
      event({
        sequence: 7,
        turnId: "turn-2",
        itemId: "tool-1",
        type: "TOOL_STARTED",
        payload: { itemId: "tool-1", tool: "create_report", arguments: { format: "pdf" } },
      }),
      event({
        sequence: 8,
        turnId: "turn-2",
        itemId: "tool-1",
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-1",
          tool: "create_report",
          result: {
            artifact: {
              artifactId: "artifact-1",
              name: "report.pdf",
              mimeType: "application/pdf",
              downloadUrl: "/api/artifacts/artifact-1",
            },
            source: {
              title: "Source PRD",
              url: "https://example.com/prd",
            },
            providerReasoning: {
              kind: "PROVIDER_REASONING_TEXT",
              content: "panel-reasoning-canary",
              reasoningTextDelta: "panel-reasoning-canary",
              encrypted_content: "panel-reasoning-canary",
            },
          },
          durationMs: 30,
        },
      }),
      event({
        sequence: 9,
        turnId: "turn-2",
        itemId: "assistant-1",
        type: "AGENT_MESSAGE_DELTA",
        payload: { itemId: "assistant-1", delta: "The report is ready." },
      }),
      event({
        sequence: 10,
        turnId: "turn-2",
        itemId: "tool-no-resource",
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-no-resource",
          tool: "plain_tool",
          result: { message: "not an artifact or source" },
          durationMs: 1,
        },
      }),
    ];
    const turns = [turn("turn-1", "Old request"), turn("turn-2", "Current request", "RUNNING")];
    const agents = [subagent("turn-2")];

    expect(selectPlanDetails(events, "turn-2")).toEqual([
      expect.objectContaining({ itemId: "plan:turn-2", explanation: "Current plan" }),
    ]);
    expect(selectTerminalDetails(events)).toEqual([
      expect.objectContaining({
        itemId: "cmd-1",
        command: "pnpm test",
        output: "complete command output\n",
        status: "completed",
      }),
    ]);
    expect(selectChangeDetails(events)).toEqual([
      expect.objectContaining({ itemId: "diff-1", diff: "+++ b/report.md\n+result" }),
    ]);
    expect(selectToolDetails(events)).toEqual([
      expect.objectContaining({
        itemId: "tool-1",
        tool: "create_report",
        status: "completed",
      }),
      expect.objectContaining({
        itemId: "tool-no-resource",
        tool: "plain_tool",
        status: "completed",
      }),
    ]);
    expect(selectOutputResources(events)).toEqual([
      expect.objectContaining({
        itemId: "tool-1",
        artifactId: "artifact-1",
        name: "report.pdf",
        uri: null,
      }),
    ]);
    expect(selectSourceResources(events)).toEqual([
      expect.objectContaining({
        itemId: "tool-1",
        title: "Source PRD",
        uri: "https://example.com/prd",
      }),
    ]);

    const presentation = projectThreadPresentation(events, turns, agents);
    expect(presentation.pinned).toEqual(
      expect.objectContaining({
        turnId: "turn-2",
        status: "RUNNING",
        plan: expect.objectContaining({ explanation: "Current plan" }),
        outputs: [expect.objectContaining({ artifactId: "artifact-1" })],
        sources: [expect.objectContaining({ title: "Source PRD" })],
        subagents: agents,
      }),
    );
    expect(presentation.side.outputs).toHaveLength(1);
    expect(presentation.side.sources).toHaveLength(1);
    expect(presentation.side.changes).toHaveLength(1);
    expect(presentation.side.tools).toHaveLength(2);
    expect(presentation.bottom.terminals).toHaveLength(1);
    expect(JSON.stringify(presentation.transcript)).not.toMatch(
      /complete command output|\+\+\+ b\/report\.md/,
    );
    expect(JSON.stringify(presentation)).not.toContain("panel-reasoning-canary");
    expect(JSON.stringify(presentation.bottom)).toContain("complete command output");
    expect(JSON.stringify(presentation.side)).toContain("+++ b/report.md");
    expect(JSON.stringify(presentation.side)).not.toContain("panel-reasoning-canary");
  });

  test("keeps the pinned summary scoped to the current Turn", () => {
    const events = [
      event({
        sequence: 1,
        turnId: "turn-1",
        itemId: "tool-old-output",
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-old-output",
          tool: "create_report",
          result: {
            artifact: {
              artifactId: "old-artifact",
              name: "old-report.pdf",
              downloadUrl: "/api/artifacts/old-artifact",
            },
            source: {
              title: "Old source",
              url: "https://example.com/old",
            },
          },
          durationMs: 5,
        },
      }),
      event({
        sequence: 2,
        turnId: "turn-2",
        itemId: "reason-current",
        type: "REASONING_SUMMARY_DELTA",
        payload: { itemId: "reason-current", delta: "Current execution summary" },
      }),
    ];

    const presentation = projectThreadPresentation(
      events,
      [turn("turn-1", "Old request"), turn("turn-2", "Current request", "RUNNING")],
      [],
    );

    expect(presentation.side.outputs).toHaveLength(1);
    expect(presentation.side.sources).toHaveLength(1);
    expect(presentation.pinned).toMatchObject({
      turnId: "turn-2",
      outputs: [],
      sources: [],
      reasoningSummary: "Current execution summary",
    });
  });

  test("never promotes filesystem paths or unsafe URI schemes into Outputs and Sources", () => {
    const events = [
      event({
        sequence: 1,
        turnId: "turn-1",
        itemId: "unsafe-resources",
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "unsafe-resources",
          tool: "create_report",
          result: {
            localArtifact: {
              kind: "artifact",
              name: "local-secret.pdf",
              path: "/Users/example/private/local-secret.pdf",
            },
            unsafeArtifact: {
              kind: "artifact",
              artifactId: "artifact-unsafe",
              name: "unsafe.html",
              url: "javascript:alert(1)",
            },
            safeArtifact: {
              kind: "artifact",
              artifactId: "artifact-safe",
              name: "/Users/example/private/safe.pdf",
              downloadUrl: "/api/artifacts/artifact-safe",
            },
            unsafeSource: {
              title: "Unsafe source",
              url: "file:///Users/example/private/source.md",
            },
            safeSource: {
              title: "/Users/example/private/source-title.md",
              url: "https://example.com/source",
            },
          },
          durationMs: 5,
        },
      }),
    ];

    expect(selectOutputResources(events)).toEqual([
      expect.objectContaining({
        artifactId: "artifact-unsafe",
        name: "unsafe.html",
        uri: null,
      }),
      expect.objectContaining({
        artifactId: "artifact-safe",
        name: "artifact-safe",
        uri: null,
      }),
    ]);
    expect(selectSourceResources(events)).toEqual([
      expect.objectContaining({
        title: "https://example.com/source",
        uri: "https://example.com/source",
      }),
    ]);
    expect(JSON.stringify(selectOutputResources(events))).not.toMatch(/Users\/example|javascript:/);
    expect(JSON.stringify(selectSourceResources(events))).not.toMatch(/Users\/example|file:/);
  });
});
