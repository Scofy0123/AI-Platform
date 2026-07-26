import type { TaskEvent } from "@codexplatform/contracts";
import { describe, expect, test } from "vitest";
import {
  coalesceThreadEvents,
  isSafeConversationEvent,
  mergeThreadEvents,
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

  test("allows reasoning summaries but rejects provider reasoning text and unknown events", () => {
    expect(
      isSafeConversationEvent(delta(1, { type: "REASONING_SUMMARY_DELTA", text: "summary" })),
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
});
