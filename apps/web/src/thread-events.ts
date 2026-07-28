import type { TaskEvent, ThreadItem } from "@codexplatform/contracts";

type DeltaEvent = Extract<
  TaskEvent,
  { type: "AGENT_MESSAGE_DELTA" | "REASONING_SUMMARY_DELTA" | "COMMAND_OUTPUT" }
>;

type ToolEvent = Extract<TaskEvent, { type: "TOOL_STARTED" | "TOOL_COMPLETED" | "TOOL_FAILED" }>;

export interface ToolDetail {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
  tool: string;
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
  arguments: unknown | null;
  result: unknown | null;
  error: string | null;
  durationMs: number | null;
}

const SAFE_CONVERSATION_TYPES = new Set<string>([
  "TURN_STARTED",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "TURN_INTERRUPTED",
  "USER_MESSAGE",
  "AGENT_MESSAGE_DELTA",
  "AGENT_MESSAGE_PHASE",
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
  const commandOutputIndex = new Map<string, number>();
  const diffIndex = new Map<string, number>();

  for (const event of events) {
    if (!isDeltaEvent(event)) {
      if (event.type === "DIFF_UPDATED") {
        const key = diffBoundaryKey(event);
        const existingIndex = diffIndex.get(key);
        if (existingIndex === undefined) {
          diffIndex.set(key, timeline.length);
          timeline.push(event);
        } else {
          timeline[existingIndex] = event;
        }
        continue;
      }
      if (
        event.type === "COMMAND_COMPLETED" &&
        typeof event.payload.aggregatedOutput === "string"
      ) {
        const key = commandBoundaryKey(event);
        const existingIndex = commandOutputIndex.get(key);
        if (existingIndex !== undefined) {
          const previous = timeline[existingIndex];
          if (previous?.type === "COMMAND_OUTPUT") {
            timeline[existingIndex] = {
              ...previous,
              payload: {
                ...previous.payload,
                delta: event.payload.aggregatedOutput,
              },
            };
          }
        } else if (event.payload.aggregatedOutput.length > 0) {
          const output: TaskEvent = {
            ...event,
            type: "COMMAND_OUTPUT",
            payload: {
              itemId: event.payload.itemId,
              delta: event.payload.aggregatedOutput,
            },
          };
          commandOutputIndex.set(key, timeline.length);
          deltaIndex.set(deltaBoundaryKey(output), timeline.length);
          timeline.push(output);
        }
      }
      timeline.push(event);
      continue;
    }
    const key = deltaBoundaryKey(event);
    const existingIndex = deltaIndex.get(key);
    if (existingIndex === undefined) {
      deltaIndex.set(key, timeline.length);
      if (event.type === "COMMAND_OUTPUT") {
        commandOutputIndex.set(commandBoundaryKey(event), timeline.length);
      }
      timeline.push(event);
      continue;
    }
    const previous = timeline[existingIndex];
    if (!isDeltaEvent(previous)) {
      deltaIndex.set(key, timeline.length);
      if (event.type === "COMMAND_OUTPUT") {
        commandOutputIndex.set(commandBoundaryKey(event), timeline.length);
      }
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

  return timeline.filter((event, index) => {
    if (event.type !== "QUEUED") return true;
    return !timeline
      .slice(index + 1)
      .some(
        (later) =>
          later.taskId === event.taskId &&
          (event.turnId === null
            ? later.type === "LEASE_ACQUIRED"
            : later.turnId === event.turnId && isQueueResolutionEvent(later)),
      );
  });
}

export function isSafeConversationEvent(event: TaskEvent): boolean {
  return SAFE_CONVERSATION_TYPES.has(String(event.type));
}

export function projectToolDetails(events: TaskEvent[]): ToolDetail[] {
  const details = new Map<string, ToolDetail>();

  for (const event of events) {
    if (!isToolEvent(event)) continue;
    const key = toolBoundaryKey(event);
    const existing = details.get(key);
    const base: ToolDetail =
      existing ??
      ({
        taskId: event.taskId,
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId ?? event.payload.itemId,
        tool: event.payload.tool,
        status: "IN_PROGRESS",
        arguments: null,
        result: null,
        error: null,
        durationMs: null,
      } satisfies ToolDetail);

    if (event.type === "TOOL_STARTED") {
      details.set(key, {
        ...base,
        tool: event.payload.tool,
        arguments: event.payload.arguments,
      });
      continue;
    }
    if (event.type === "TOOL_COMPLETED") {
      details.set(key, {
        ...base,
        tool: event.payload.tool,
        status: "COMPLETED",
        result: event.payload.result,
        error: null,
        durationMs: event.payload.durationMs,
      });
      continue;
    }
    details.set(key, {
      ...base,
      tool: event.payload.tool,
      status: "FAILED",
      result: null,
      error: event.payload.error,
      durationMs: null,
    });
  }

  return [...details.values()];
}

export function threadItemToEvent(taskId: string, item: ThreadItem): TaskEvent {
  const payloadItemId =
    typeof item.payload.itemId === "string" && item.payload.itemId.length > 0
      ? item.payload.itemId
      : null;
  return {
    taskId,
    threadId: item.threadId,
    turnId: item.turnId,
    itemId: payloadItemId ?? item.id,
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

function commandBoundaryKey(
  event: Extract<TaskEvent, { type: "COMMAND_OUTPUT" | "COMMAND_COMPLETED" }>,
): string {
  return [
    event.taskId,
    event.threadId ?? "no-thread",
    event.turnId ?? "no-turn",
    event.itemId ?? event.payload.itemId,
  ].join("\u0000");
}

function diffBoundaryKey(event: Extract<TaskEvent, { type: "DIFF_UPDATED" }>): string {
  return [
    event.taskId,
    event.threadId ?? "no-thread",
    event.turnId ?? "no-turn",
    event.itemId ?? "diff",
  ].join("\u0000");
}

function toolBoundaryKey(event: ToolEvent): string {
  return [
    event.taskId,
    event.threadId ?? "no-thread",
    event.turnId ?? "no-turn",
    event.itemId ?? event.payload.itemId,
  ].join("\u0000");
}

function isToolEvent(event: TaskEvent): event is ToolEvent {
  return (
    event.type === "TOOL_STARTED" || event.type === "TOOL_COMPLETED" || event.type === "TOOL_FAILED"
  );
}

function isQueueResolutionEvent(event: TaskEvent): boolean {
  return [
    "LEASE_ACQUIRED",
    "TURN_STARTED",
    "TURN_COMPLETED",
    "TURN_FAILED",
    "TURN_INTERRUPTED",
    "RECOVERY_REQUIRED",
  ].includes(event.type);
}

function isDeltaEvent(event: TaskEvent | undefined): event is DeltaEvent {
  return (
    event?.type === "AGENT_MESSAGE_DELTA" ||
    event?.type === "REASONING_SUMMARY_DELTA" ||
    event?.type === "COMMAND_OUTPUT"
  );
}
