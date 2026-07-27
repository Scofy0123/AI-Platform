import type { TaskEvent, ThreadItem } from "@codexplatform/contracts";
import { describe, expect, test } from "vitest";
import {
  coalesceThreadEvents,
  isSafeConversationEvent,
  mergeThreadEvents,
  projectToolDetails,
  threadItemToEvent,
} from "./thread-events.js";

function delta(
  sequence: number,
  input: {
    taskId?: string;
    threadId?: string;
    turnId?: string;
    itemId?: string;
    text: string;
    type?: "AGENT_MESSAGE_DELTA" | "REASONING_SUMMARY_DELTA" | "COMMAND_OUTPUT";
  },
): TaskEvent {
  return {
    taskId: input.taskId ?? "thread-1",
    threadId: input.threadId ?? "runtime-thread-1",
    turnId: input.turnId ?? "turn-1",
    itemId: input.itemId ?? "item-1",
    sequence,
    timestamp: `2026-07-25T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    type: input.type ?? "AGENT_MESSAGE_DELTA",
    payload: { itemId: input.itemId ?? "item-1", delta: input.text },
  } as TaskEvent;
}

function completed(
  sequence: number,
  input: {
    aggregatedOutput: string | null;
    taskId?: string;
    threadId?: string;
    turnId?: string;
    itemId?: string;
  },
): TaskEvent {
  const itemId = input.itemId ?? "command-1";
  return {
    taskId: input.taskId ?? "thread-1",
    threadId: input.threadId ?? "runtime-thread-1",
    turnId: input.turnId ?? "turn-1",
    itemId,
    sequence,
    timestamp: `2026-07-25T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    type: "COMMAND_COMPLETED",
    payload: {
      itemId,
      command: "printf output",
      aggregatedOutput: input.aggregatedOutput,
      exitCode: 0,
      durationMs: 12,
    },
  };
}

function diff(sequence: number, value: string, itemId = "diff-1"): TaskEvent {
  return {
    taskId: "thread-1",
    threadId: "runtime-thread-1",
    turnId: "turn-1",
    itemId,
    sequence,
    timestamp: `2026-07-25T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    type: "DIFF_UPDATED",
    payload: { diff: value },
  } as TaskEvent;
}

describe("Thread event projection", () => {
  test("coalesces only within an exact thread, Turn, Item and event-type boundary", () => {
    const events = [
      delta(1, { text: "A" }),
      delta(2, { text: "B" }),
      delta(3, { threadId: "runtime-thread-2", text: "other thread" }),
      delta(4, { turnId: "turn-2", text: "other turn" }),
      delta(5, { itemId: "item-2", text: "other item" }),
      delta(6, { type: "REASONING_SUMMARY_DELTA", text: "summary" }),
    ];

    expect(
      coalesceThreadEvents(events).map((event) =>
        "delta" in event.payload ? event.payload.delta : event.type,
      ),
    ).toEqual(["AB", "other thread", "other turn", "other item", "summary"]);
  });

  test("keeps events with the same sequence when they belong to different Thread boundaries", () => {
    const current = [delta(1, { threadId: "runtime-thread-1", text: "parent" })];
    const incoming = [delta(1, { threadId: "runtime-thread-2", text: "child" })];

    expect(mergeThreadEvents(current, incoming)).toHaveLength(2);
  });

  test("keeps only the latest full Diff snapshot within an exact Turn and Item boundary", () => {
    const events = [
      diff(1, "+++ b/report.md\n+first"),
      diff(2, "+++ b/report.md\n+first\n+second"),
      diff(3, "+++ b/other.md\n+other", "diff-2"),
    ];

    expect(
      coalesceThreadEvents(events).flatMap((event) =>
        event.type === "DIFF_UPDATED" ? [event.payload.diff] : [],
      ),
    ).toEqual(["+++ b/report.md\n+first\n+second", "+++ b/other.md\n+other"]);
  });

  test("removes a historical queue card after allocation or execution has progressed", () => {
    const events = [
      {
        taskId: "thread-1",
        threadId: "runtime-thread-1",
        turnId: "turn-1",
        sequence: 1,
        timestamp: "2026-07-25T12:00:01.000Z",
        type: "QUEUED",
        payload: { position: 1, etaMs: 60_000, etaEstimated: true },
      },
      {
        taskId: "thread-1",
        threadId: "runtime-thread-1",
        turnId: "turn-1",
        sequence: 2,
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "LEASE_ACQUIRED",
        payload: { accountAlias: "hidden" },
      },
      {
        taskId: "thread-1",
        threadId: "runtime-thread-1",
        turnId: "turn-1",
        sequence: 3,
        timestamp: "2026-07-25T12:00:03.000Z",
        type: "TURN_STARTED",
        payload: { status: "inProgress" },
      },
    ] as TaskEvent[];

    expect(coalesceThreadEvents(events).some((event) => event.type === "QUEUED")).toBe(false);
  });

  test("allows reasoning summaries but rejects provider reasoning text and unknown events", () => {
    expect(
      isSafeConversationEvent(delta(1, { type: "REASONING_SUMMARY_DELTA", text: "summary" })),
    ).toBe(true);
    expect(
      isSafeConversationEvent({
        taskId: "thread-1",
        threadId: "runtime-thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        sequence: 2,
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "AGENT_MESSAGE_PHASE",
        payload: { itemId: "message-1", phase: "final_answer" },
      }),
    ).toBe(true);
    expect(
      isSafeConversationEvent({
        ...delta(2, { text: "ignored" }),
        type: "PLAN_UPDATED",
        payload: {
          explanation: "Inspect, change, verify",
          plan: [{ step: "Inspect", status: "completed" }],
        },
      } as TaskEvent),
    ).toBe(true);
    expect(
      isSafeConversationEvent({
        ...delta(3, { text: "secret" }),
        type: "PROVIDER_REASONING_TEXT",
      } as never),
    ).toBe(false);
  });

  test("replaces a partial streamed command output with its final snapshot", () => {
    const events = [
      delta(1, { type: "COMMAND_OUTPUT", itemId: "command-1", text: "02\n" }),
      completed(2, { itemId: "command-1", aggregatedOutput: "01\n02\n" }),
    ];

    const projected = coalesceThreadEvents(events);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      type: "COMMAND_OUTPUT",
      payload: { itemId: "command-1", delta: "01\n02\n" },
    });
    expect(projected[1]).toMatchObject({ type: "COMMAND_COMPLETED" });
  });

  test("does not duplicate complete streamed output when the final snapshot matches", () => {
    const events = [
      delta(1, { type: "COMMAND_OUTPUT", itemId: "command-1", text: "01\n" }),
      delta(2, { type: "COMMAND_OUTPUT", itemId: "command-1", text: "02\n" }),
      completed(3, { itemId: "command-1", aggregatedOutput: "01\n02\n" }),
    ];

    expect(
      coalesceThreadEvents(events).map((event) =>
        event.type === "COMMAND_OUTPUT" ? event.payload.delta : event.type,
      ),
    ).toEqual(["01\n02\n", "COMMAND_COMPLETED"]);
  });

  test("keeps streamed command output when the final snapshot is null", () => {
    const events = [
      delta(1, { type: "COMMAND_OUTPUT", itemId: "command-1", text: "streamed\n" }),
      completed(2, { itemId: "command-1", aggregatedOutput: null }),
    ];

    expect(
      coalesceThreadEvents(events).map((event) =>
        event.type === "COMMAND_OUTPUT" ? event.payload.delta : event.type,
      ),
    ).toEqual(["streamed\n", "COMMAND_COMPLETED"]);
  });

  test("keeps historical command completion events that predate aggregatedOutput", () => {
    const historical = completed(1, {
      itemId: "command-1",
      aggregatedOutput: null,
    }) as TaskEvent & {
      payload: Record<string, unknown>;
    };
    delete historical.payload.aggregatedOutput;

    expect(coalesceThreadEvents([historical])).toEqual([historical]);
  });

  test("projects a final command output snapshot when no delta arrived", () => {
    const events = [completed(1, { itemId: "command-1", aggregatedOutput: "only snapshot\n" })];

    const projected = coalesceThreadEvents(events);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      type: "COMMAND_OUTPUT",
      payload: { itemId: "command-1", delta: "only snapshot\n" },
    });
    expect(projected[1]).toMatchObject({ type: "COMMAND_COMPLETED" });
  });

  test("reconciles a command completion that arrives after Turn interruption", () => {
    const events = [
      delta(1, { type: "COMMAND_OUTPUT", itemId: "command-1", text: "02\n" }),
      {
        taskId: "thread-1",
        threadId: "runtime-thread-1",
        turnId: "turn-1",
        itemId: "turn:turn-1",
        sequence: 2,
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "TURN_INTERRUPTED",
        payload: { status: "interrupted" },
      } satisfies TaskEvent,
      completed(3, { itemId: "command-1", aggregatedOutput: "01\n02\n" }),
    ];

    expect(
      coalesceThreadEvents(events).map((event) =>
        event.type === "COMMAND_OUTPUT" ? event.payload.delta : event.type,
      ),
    ).toEqual(["01\n02\n", "TURN_INTERRUPTED", "COMMAND_COMPLETED"]);
  });

  test("merges Tool start and completion into one owner-visible detail", () => {
    const events = [
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        sequence: 1,
        timestamp: "2026-07-25T12:00:01.000Z",
        type: "TOOL_STARTED",
        payload: {
          itemId: "tool-1",
          tool: "business_read",
          arguments: { id: "order-1" },
        },
      },
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        sequence: 2,
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-1",
          tool: "business_read",
          result: { id: "order-1", status: "PAID" },
          durationMs: 17,
        },
      },
    ] as TaskEvent[];

    expect(projectToolDetails(events)).toEqual([
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        tool: "business_read",
        status: "COMPLETED",
        arguments: { id: "order-1" },
        result: { id: "order-1", status: "PAID" },
        error: null,
        durationMs: 17,
      },
    ]);
  });

  test("merges Tool failure with its original arguments and error", () => {
    const events = [
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        sequence: 1,
        timestamp: "2026-07-25T12:00:01.000Z",
        type: "TOOL_STARTED",
        payload: {
          itemId: "tool-1",
          tool: "database_query",
          arguments: { sql: "DELETE FROM orders" },
        },
      },
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        sequence: 2,
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "TOOL_FAILED",
        payload: {
          itemId: "tool-1",
          tool: "database_query",
          error: "Only SELECT is allowed",
        },
      },
    ] as TaskEvent[];

    expect(projectToolDetails(events)).toEqual([
      expect.objectContaining({
        itemId: "tool-1",
        status: "FAILED",
        arguments: { sql: "DELETE FROM orders" },
        result: null,
        error: "Only SELECT is allowed",
        durationMs: null,
      }),
    ]);
  });

  test("does not merge equal Tool item ids across task, Thread or Turn boundaries", () => {
    const events = [
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        sequence: 1,
        timestamp: "2026-07-25T12:00:01.000Z",
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-1",
          tool: "tool-a",
          result: "A",
          durationMs: 1,
        },
      },
      {
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-2",
        itemId: "tool-1",
        sequence: 2,
        timestamp: "2026-07-25T12:00:02.000Z",
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-1",
          tool: "tool-b",
          result: "B",
          durationMs: 2,
        },
      },
    ] as TaskEvent[];

    expect(projectToolDetails(events)).toHaveLength(2);
  });

  test("restores a stable runtime Item boundary from the sanitized payload", () => {
    const item = {
      id: "subagent-item:2",
      threadId: "agent-thread",
      turnId: "turn-1",
      sequence: 2,
      type: "COMMAND_OUTPUT",
      timestamp: "2026-07-25T12:00:02.000Z",
      payload: { itemId: "runtime-command-1", delta: "output\n" },
    } as ThreadItem;

    expect(threadItemToEvent("thread-1", item)).toMatchObject({
      itemId: "runtime-command-1",
      payload: { itemId: "runtime-command-1", delta: "output\n" },
    });
  });
});
