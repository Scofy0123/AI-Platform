import type { TaskEvent, TaskEventPayloadMap, TaskEventType } from "@codexplatform/contracts";

interface NormalizerContext {
  taskId: string;
  now?: () => Date;
}

interface ProtocolMessage {
  id?: number | string;
  method: string;
  params?: unknown;
}

export interface NormalizedApprovalRequest {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  sequence: number;
  timestamp: string;
  type: "APPROVAL_REQUESTED";
  payload: Omit<TaskEventPayloadMap["APPROVAL_REQUESTED"], "approvalId">;
}

export class CodexEventNormalizer {
  private sequence = 0;
  private readonly now: () => Date;

  constructor(private readonly context: NormalizerContext) {
    this.now = context.now ?? (() => new Date());
  }

  normalizeNotification(message: ProtocolMessage): TaskEvent[] {
    const params = asRecord(message.params);
    const threadId = stringOrNull(params.threadId);
    const turn = asRecord(params.turn);
    const turnId = stringOrNull(params.turnId) ?? stringOrNull(turn.id);
    const item = asRecord(params.item);

    switch (message.method) {
      case "turn/started":
        return [this.event("TURN_STARTED", threadId, turnId, { status: "inProgress" })];
      case "turn/completed": {
        if (turn.status === "failed") {
          const error = asRecord(turn.error);
          return [
            this.event("TURN_FAILED", threadId, turnId, {
              status: "failed",
              error: typeof error.message === "string" ? error.message : "Codex turn failed",
            }),
          ];
        }
        if (turn.status === "interrupted") {
          return [this.event("TURN_INTERRUPTED", threadId, turnId, { status: "interrupted" })];
        }
        return [
          this.event("TURN_COMPLETED", threadId, turnId, {
            status: "completed",
            durationMs: numberOrNull(turn.durationMs),
          }),
        ];
      }
      case "item/agentMessage/delta":
        return [
          this.event("AGENT_MESSAGE_DELTA", threadId, turnId, {
            itemId: stringOrEmpty(params.itemId),
            delta: stringOrEmpty(params.delta),
          }),
        ];
      case "item/reasoning/summaryTextDelta":
        return [
          this.event("REASONING_SUMMARY_DELTA", threadId, turnId, {
            itemId: stringOrEmpty(params.itemId),
            delta: stringOrEmpty(params.delta),
          }),
        ];
      case "turn/plan/updated":
        return [
          this.event("PLAN_UPDATED", threadId, turnId, {
            explanation: stringOrNull(params.explanation),
            plan: Array.isArray(params.plan) ? params.plan : [],
          }),
        ];
      case "item/commandExecution/outputDelta":
        return [
          this.event("COMMAND_OUTPUT", threadId, turnId, {
            itemId: stringOrEmpty(params.itemId),
            delta: stringOrEmpty(params.delta),
          }),
        ];
      case "turn/diff/updated":
        return [this.event("DIFF_UPDATED", threadId, turnId, { diff: stringOrEmpty(params.diff) })];
      case "item/started":
        return this.normalizeItemStarted(item, threadId, turnId);
      case "item/completed":
        return this.normalizeItemCompleted(item, threadId, turnId);
      default:
        return [];
    }
  }

  normalizeServerRequest(message: ProtocolMessage): NormalizedApprovalRequest | null {
    const params = asRecord(message.params);
    const approvalTypeByMethod = {
      "item/commandExecution/requestApproval": "COMMAND",
      "item/fileChange/requestApproval": "FILE_CHANGE",
      "item/permissions/requestApproval": "PERMISSIONS",
    } as const;
    const approvalType = approvalTypeByMethod[message.method as keyof typeof approvalTypeByMethod];
    if (!approvalType || message.id === undefined) return null;

    this.sequence += 1;
    return {
      taskId: this.context.taskId,
      threadId: stringOrNull(params.threadId),
      turnId: stringOrNull(params.turnId),
      sequence: this.sequence,
      timestamp: this.now().toISOString(),
      type: "APPROVAL_REQUESTED",
      payload: {
        itemId: stringOrEmpty(params.itemId),
        approvalType,
        reason: stringOrNull(params.reason),
        ...(approvalType === "COMMAND"
          ? { command: stringOrNull(params.command), cwd: stringOrNull(params.cwd) }
          : {}),
      },
    };
  }

  private normalizeItemStarted(
    item: Record<string, unknown>,
    threadId: string | null,
    turnId: string | null,
  ): TaskEvent[] {
    if (item.type === "commandExecution") {
      return [
        this.event("COMMAND_STARTED", threadId, turnId, {
          itemId: stringOrEmpty(item.id),
          command: stringOrEmpty(item.command),
          cwd: stringOrEmpty(item.cwd),
        }),
      ];
    }
    if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") {
      return [
        this.event("TOOL_STARTED", threadId, turnId, {
          itemId: stringOrEmpty(item.id),
          tool: stringOrEmpty(item.tool),
          arguments: item.arguments,
        }),
      ];
    }
    return [];
  }

  private normalizeItemCompleted(
    item: Record<string, unknown>,
    threadId: string | null,
    turnId: string | null,
  ): TaskEvent[] {
    if (item.type === "commandExecution") {
      return [
        this.event("COMMAND_COMPLETED", threadId, turnId, {
          itemId: stringOrEmpty(item.id),
          command: stringOrEmpty(item.command),
          exitCode: numberOrNull(item.exitCode),
          durationMs: numberOrNull(item.durationMs),
        }),
      ];
    }
    if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") {
      const success = item.success === true || item.status === "completed";
      return [
        success
          ? this.event("TOOL_COMPLETED", threadId, turnId, {
              itemId: stringOrEmpty(item.id),
              tool: stringOrEmpty(item.tool),
              durationMs: numberOrNull(item.durationMs),
            })
          : this.event("TOOL_FAILED", threadId, turnId, {
              itemId: stringOrEmpty(item.id),
              tool: stringOrEmpty(item.tool),
              error: extractError(item.error),
            }),
      ];
    }
    return [];
  }

  private event<Type extends TaskEventType>(
    type: Type,
    threadId: string | null,
    turnId: string | null,
    payload: TaskEventPayloadMap[Type],
  ): Extract<TaskEvent, { type: Type }> {
    this.sequence += 1;
    return {
      taskId: this.context.taskId,
      threadId,
      turnId,
      sequence: this.sequence,
      timestamp: this.now().toISOString(),
      type,
      payload,
    } as Extract<TaskEvent, { type: Type }>;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOrEmpty(value: unknown): string {
  return stringOrNull(value) ?? "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractError(value: unknown): string | null {
  if (typeof value === "string") return value;
  const error = asRecord(value);
  return stringOrNull(error.message);
}
