import {
  type TaskEvent,
  type TaskEventPayloadMap,
  type TaskEventType,
  TokenUsageBreakdownSchema,
} from "@codexplatform/contracts";
import {
  type RuntimePathRedactionContext,
  sanitizeRuntimePathTransport,
} from "../../event-payload-safety.js";

interface NormalizerContext extends RuntimePathRedactionContext {
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
        if (!stableItemId(params.itemId)) return [];
        return [
          this.event("AGENT_MESSAGE_DELTA", threadId, turnId, {
            itemId: stringOrEmpty(params.itemId),
            delta: stringOrEmpty(params.delta),
          }),
        ];
      case "item/reasoning/summaryTextDelta":
        if (!stableItemId(params.itemId)) return [];
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
        if (!stableItemId(params.itemId)) return [];
        return [
          this.event("COMMAND_OUTPUT", threadId, turnId, {
            itemId: stringOrEmpty(params.itemId),
            delta: stringOrEmpty(params.delta),
          }),
        ];
      case "turn/diff/updated":
        return [this.event("DIFF_UPDATED", threadId, turnId, { diff: stringOrEmpty(params.diff) })];
      case "thread/tokenUsage/updated": {
        const tokenUsage = asRecord(params.tokenUsage);
        const total = parseTokenUsage(tokenUsage.total);
        const last = parseTokenUsage(tokenUsage.last);
        const modelContextWindow = nullableNonnegativeInteger(tokenUsage.modelContextWindow);
        if (
          !threadId ||
          !total ||
          !last ||
          (tokenUsage.modelContextWindow !== null && modelContextWindow === null)
        ) {
          return [];
        }
        return [
          this.event("TOKEN_USAGE_UPDATED", threadId, turnId, {
            total,
            last,
            modelContextWindow,
          }),
        ];
      }
      case "model/rerouted": {
        const fromModel = nonEmptyString(params.fromModel);
        const toModel = nonEmptyString(params.toModel);
        if (!threadId || !turnId || !fromModel || !toModel) return [];
        return [
          this.event("MODEL_REROUTED", threadId, turnId, {
            fromModel,
            toModel,
            reason: normalizeModelRerouteReason(params.reason),
          }),
        ];
      }
      case "warning": {
        const message = nonEmptyString(params.message, 4_000);
        if (!message) return [];
        return [this.event("RUNTIME_WARNING", threadId, null, { message })];
      }
      case "thread/compacted":
        if (!threadId || !turnId) return [];
        return [
          this.event("CONTEXT_COMPACTED", threadId, turnId, {
            status: "completed",
          }),
        ];
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
    const itemId = stableItemId(params.itemId);
    if (!approvalType || message.id === undefined || !itemId) return null;

    this.sequence += 1;
    const payload = sanitizeRuntimePathTransport(
      {
        itemId,
        approvalType,
        reason: stringOrNull(params.reason),
        ...(approvalType === "COMMAND"
          ? { command: stringOrNull(params.command), cwd: stringOrNull(params.cwd) }
          : {}),
      },
      this.context,
    ) as Omit<TaskEventPayloadMap["APPROVAL_REQUESTED"], "approvalId">;
    return {
      taskId: this.context.taskId,
      threadId: stringOrNull(params.threadId),
      turnId: stringOrNull(params.turnId),
      sequence: this.sequence,
      timestamp: this.now().toISOString(),
      type: "APPROVAL_REQUESTED",
      payload,
    };
  }

  private normalizeItemStarted(
    item: Record<string, unknown>,
    threadId: string | null,
    turnId: string | null,
  ): TaskEvent[] {
    if (!stableItemId(item.id)) return [];
    if (item.type === "agentMessage") {
      return [
        this.event("AGENT_MESSAGE_PHASE", threadId, turnId, {
          itemId: stringOrEmpty(item.id),
          phase: normalizeAgentMessagePhase(item.phase),
        }),
      ];
    }
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
    if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") {
      return this.normalizeSubagentItem(item, threadId, turnId);
    }
    return [];
  }

  private normalizeItemCompleted(
    item: Record<string, unknown>,
    threadId: string | null,
    turnId: string | null,
  ): TaskEvent[] {
    if (!stableItemId(item.id)) return [];
    if (item.type === "agentMessage") {
      return [
        this.event("AGENT_MESSAGE_PHASE", threadId, turnId, {
          itemId: stringOrEmpty(item.id),
          phase: normalizeAgentMessagePhase(item.phase),
        }),
      ];
    }
    if (item.type === "commandExecution") {
      return [
        this.event("COMMAND_COMPLETED", threadId, turnId, {
          itemId: stringOrEmpty(item.id),
          command: stringOrEmpty(item.command),
          aggregatedOutput: stringOrNull(item.aggregatedOutput),
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
              result:
                item.type === "dynamicToolCall"
                  ? Array.isArray(item.contentItems)
                    ? item.contentItems
                    : null
                  : item.result === undefined
                    ? null
                    : item.result,
              durationMs: numberOrNull(item.durationMs),
            })
          : this.event("TOOL_FAILED", threadId, turnId, {
              itemId: stringOrEmpty(item.id),
              tool: stringOrEmpty(item.tool),
              error: extractError(item.error),
            }),
      ];
    }
    if (item.type === "subAgentActivity" || item.type === "collabAgentToolCall") {
      return this.normalizeSubagentItem(item, threadId, turnId);
    }
    return [];
  }

  private normalizeSubagentItem(
    item: Record<string, unknown>,
    threadId: string | null,
    turnId: string | null,
  ): TaskEvent[] {
    if (item.type === "subAgentActivity") {
      const agentThreadId = stringOrNull(item.agentThreadId);
      const itemId = stringOrNull(item.id);
      if (!agentThreadId || !itemId) return [];
      const kind = stringOrNull(item.kind);
      const status = kind === "interrupted" ? "INTERRUPTED" : "ACTIVE";
      const agentPath = stringOrNull(item.agentPath);
      return [
        this.event("SUBAGENT_ACTIVITY", threadId, turnId, {
          itemId,
          agentThreadId,
          kind:
            kind === "started" || kind === "interacted" || kind === "interrupted"
              ? kind
              : "unknown",
          name: agentPath ? lastPathSegment(agentPath) : null,
          role: "subagent",
          model: null,
          effort: null,
          status,
          resultSummary: null,
        }),
      ];
    }

    const itemId = stringOrNull(item.id);
    const receiverThreadIds = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((value): value is string => typeof value === "string")
      : [];
    if (!itemId || receiverThreadIds.length === 0) return [];
    const agentStates = asRecord(item.agentsStates);
    const prompt = stringOrNull(item.prompt);
    return receiverThreadIds.map((agentThreadId) => {
      const state = asRecord(agentStates[agentThreadId]);
      const status = normalizeSubagentStatus(state.status, item.status);
      return this.event("SUBAGENT_ACTIVITY", threadId, turnId, {
        itemId: `${itemId}:${agentThreadId}`,
        agentThreadId,
        kind:
          status === "DONE"
            ? "completed"
            : status === "FAILED"
              ? "failed"
              : status === "INTERRUPTED"
                ? "interrupted"
                : status === "ACTIVE"
                  ? "interacted"
                  : "unknown",
        name: prompt ? prompt.slice(0, 120) : null,
        role: "subagent",
        model: stringOrNull(item.model),
        effort: stringOrNull(item.reasoningEffort),
        status,
        resultSummary: stringOrNull(state.message),
      });
    });
  }

  private event<Type extends TaskEventType>(
    type: Type,
    threadId: string | null,
    turnId: string | null,
    payload: TaskEventPayloadMap[Type],
  ): Extract<TaskEvent, { type: Type }> {
    this.sequence += 1;
    const safePayload = sanitizeRuntimePathTransport(
      payload,
      this.context,
    ) as TaskEventPayloadMap[Type];
    const record = safePayload as Record<string, unknown>;
    const itemId =
      typeof record.itemId === "string" && record.itemId.length > 0
        ? record.itemId
        : type === "TOKEN_USAGE_UPDATED" && threadId
          ? `token-usage:${threadId}`
          : `${type.toLowerCase()}:${turnId ?? threadId ?? this.context.taskId}`;
    return {
      taskId: this.context.taskId,
      threadId,
      turnId,
      itemId,
      sequence: this.sequence,
      timestamp: this.now().toISOString(),
      type,
      payload: safePayload,
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

function nonEmptyString(value: unknown, maxLength = 256): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableItemId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseTokenUsage(
  value: unknown,
): TaskEventPayloadMap["TOKEN_USAGE_UPDATED"]["total"] | null {
  const parsed = TokenUsageBreakdownSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractError(value: unknown): string | null {
  if (typeof value === "string") return value;
  const error = asRecord(value);
  return stringOrNull(error.message);
}

function lastPathSegment(value: string): string {
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? value;
}

function normalizeSubagentStatus(
  stateStatus: unknown,
  toolStatus: unknown,
): "ACTIVE" | "DONE" | "FAILED" | "INTERRUPTED" | "UNKNOWN" {
  if (stateStatus === "pendingInit" || stateStatus === "running") return "ACTIVE";
  if (stateStatus === "completed" || stateStatus === "shutdown") return "DONE";
  if (stateStatus === "errored") return "FAILED";
  if (stateStatus === "interrupted") return "INTERRUPTED";
  if (stateStatus === "notFound") return "UNKNOWN";
  if (toolStatus === "inProgress") return "ACTIVE";
  if (toolStatus === "completed") return "DONE";
  if (toolStatus === "failed") return "FAILED";
  return "UNKNOWN";
}

function normalizeAgentMessagePhase(
  value: unknown,
): TaskEventPayloadMap["AGENT_MESSAGE_PHASE"]["phase"] {
  return value === "commentary" || value === "final_answer" ? value : null;
}

function normalizeModelRerouteReason(
  value: unknown,
): TaskEventPayloadMap["MODEL_REROUTED"]["reason"] {
  if (value === "highRiskCyberActivity") return "SAFETY_POLICY";
  if (value === "availability" || value === "capacity" || value === "rateLimit") {
    return "AVAILABILITY";
  }
  if (value === "capability") return "CAPABILITY";
  return "OTHER";
}
