import type { TaskEvent, ThreadItem } from "@codexplatform/contracts";

type DeltaEvent = Extract<
  TaskEvent,
  { type: "AGENT_MESSAGE_DELTA" | "REASONING_SUMMARY_DELTA" | "COMMAND_OUTPUT" }
>;

const SAFE_CONVERSATION_TYPES = new Set<string>([
  "TURN_STARTED",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "TURN_INTERRUPTED",
  "USER_MESSAGE",
  "AGENT_MESSAGE_DELTA",
  "REASONING_SUMMARY_DELTA",
  "PLAN_UPDATED",
  "COMMAND_STARTED",
  "COMMAND_OUTPUT",
  "COMMAND_COMPLETED",
  "TOOL_STARTED",
  "TOOL_COMPLETED",
  "TOOL_FAILED",
  "DIFF_UPDATED",
  "APPROVAL_REQUESTED",
  "APPROVAL_DECIDED",
  "QUEUED",
  "RECOVERY_REQUIRED",
]);

export function mergeThreadEvents(current: TaskEvent[], incoming: TaskEvent[]): TaskEvent[] {
  const events = new Map<string, TaskEvent>();
  for (const event of [...current, ...incoming]) {
    events.set(eventEnvelopeKey(event), event);
  }
  return [...events.values()].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.timestamp.localeCompare(right.timestamp) ||
      eventEnvelopeKey(left).localeCompare(eventEnvelopeKey(right)),
  );
}

export function coalesceThreadEvents(events: TaskEvent[]): TaskEvent[] {
  const timeline: TaskEvent[] = [];
  const deltaIndex = new Map<string, number>();

  for (const event of events) {
    if (!isDeltaEvent(event)) {
      timeline.push(event);
      continue;
    }
    const key = deltaBoundaryKey(event);
    const existingIndex = deltaIndex.get(key);
    if (existingIndex === undefined) {
      deltaIndex.set(key, timeline.length);
      timeline.push(event);
      continue;
    }
    const previous = timeline[existingIndex];
    if (!isDeltaEvent(previous)) {
      deltaIndex.set(key, timeline.length);
      timeline.push(event);
      continue;
    }
    timeline[existingIndex] = {
      ...previous,
      payload: {
        ...previous.payload,
        delta: previous.payload.delta + event.payload.delta,
      },
    };
  }

  return timeline;
}

export function isSafeConversationEvent(event: TaskEvent): boolean {
  return SAFE_CONVERSATION_TYPES.has(String(event.type));
}

export function threadItemToEvent(taskId: string, item: ThreadItem): TaskEvent {
  return {
    taskId,
    threadId: item.threadId,
    turnId: item.turnId,
    itemId: item.id,
    sequence: item.sequence,
    timestamp: item.timestamp,
    type: item.type,
    payload: item.payload,
  } as TaskEvent;
}

function eventEnvelopeKey(event: TaskEvent): string {
  return [
    event.taskId,
    event.threadId ?? "no-thread",
    event.turnId ?? "no-turn",
    String(event.sequence),
  ].join("\u0000");
}

function deltaBoundaryKey(event: DeltaEvent): string {
  return [
    event.taskId,
    event.threadId ?? "no-thread",
    event.turnId ?? "no-turn",
    event.itemId ?? event.payload.itemId,
    event.type,
  ].join("\u0000");
}

function isDeltaEvent(event: TaskEvent | undefined): event is DeltaEvent {
  return (
    event?.type === "AGENT_MESSAGE_DELTA" ||
    event?.type === "REASONING_SUMMARY_DELTA" ||
    event?.type === "COMMAND_OUTPUT"
  );
}
