import type { SubagentThread, TaskEvent, TaskEventType, Turn } from "@codexplatform/contracts";
import { coalesceThreadEvents, mergeThreadEvents } from "./thread-events.js";

export type TranscriptRowKind =
  | "user"
  | "assistant"
  | "reasoning-summary"
  | "plan"
  | "command"
  | "tool"
  | "diff"
  | "approval"
  | "status"
  | "subagent";

interface TranscriptRowBase {
  id: string;
  kind: TranscriptRowKind;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
  sequence: number;
  timestamp: string;
  text: string;
}

export interface TranscriptMessageRow extends TranscriptRowBase {
  kind: "user" | "assistant" | "reasoning-summary";
}

export interface TranscriptPlanRow extends TranscriptRowBase {
  kind: "plan";
  explanation: string | null;
  steps: unknown[];
}

export interface TranscriptCommandRow extends TranscriptRowBase {
  kind: "command";
  command: string | null;
  cwd: string | null;
  status: "running" | "completed" | "failed";
  exitCode: number | null;
  durationMs: number | null;
}

export interface TranscriptToolRow extends TranscriptRowBase {
  kind: "tool";
  tool: string;
  status: "running" | "completed" | "failed";
  error: string | null;
  durationMs: number | null;
}

export interface TranscriptDiffRow extends TranscriptRowBase {
  kind: "diff";
  changedFiles: number;
}

export interface TranscriptApprovalRow extends TranscriptRowBase {
  kind: "approval";
  approvalId: string;
  approvalType: "COMMAND" | "FILE_CHANGE" | "PERMISSIONS" | null;
  status: "pending" | "accepted" | "declined" | string;
  reason: string | null;
  command: string | null;
  cwd: string | null;
}

export interface TranscriptStatusRow extends TranscriptRowBase {
  kind: "status";
  status: string;
}

export interface TranscriptSubagentRow extends TranscriptRowBase {
  kind: "subagent";
  agentThreadId: string;
  name: string | null;
  role: string | null;
  status: string;
  resultSummary: string | null;
}

export type TranscriptRow =
  | TranscriptMessageRow
  | TranscriptPlanRow
  | TranscriptCommandRow
  | TranscriptToolRow
  | TranscriptDiffRow
  | TranscriptApprovalRow
  | TranscriptStatusRow
  | TranscriptSubagentRow;

export interface TranscriptGroup {
  id: string;
  threadId: string | null;
  turnId: string | null;
  rows: TranscriptRow[];
}

export interface PlanDetail {
  id: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
  sequence: number;
  timestamp: string;
  explanation: string | null;
  steps: unknown[];
}

export interface TerminalDetail {
  id: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
  sequence: number;
  timestamp: string;
  command: string | null;
  cwd: string | null;
  status: "running" | "completed" | "failed";
  output: string;
  exitCode: number | null;
  durationMs: number | null;
}

export interface ChangeDetail {
  id: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
  sequence: number;
  timestamp: string;
  diff: string;
  changedFiles: number;
}

export interface ToolPanelDetail {
  id: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
  sequence: number;
  timestamp: string;
  tool: string;
  status: "running" | "completed" | "failed";
  arguments: unknown | null;
  result: unknown | null;
  error: string | null;
  durationMs: number | null;
}

export interface OutputResource {
  id: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
  artifactId: string | null;
  name: string;
  uri: string | null;
  mimeType: string | null;
}

export interface SourceResource {
  id: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string;
  title: string;
  uri: string | null;
  citation: unknown | null;
}

export interface PinnedExecutionSummary {
  turnId: string;
  status: Turn["status"];
  plan: PlanDetail | null;
  reasoningSummary: string;
  activityCount: number;
  subagents: SubagentThread[];
  outputs: OutputResource[];
  sources: SourceResource[];
}

export interface ThreadPresentation {
  transcript: {
    groups: TranscriptGroup[];
    rows: TranscriptRow[];
    activities: TranscriptRow[];
  };
  pinned: PinnedExecutionSummary | null;
  side: {
    plan: PlanDetail | null;
    outputs: OutputResource[];
    sources: SourceResource[];
    subagents: SubagentThread[];
    changes: ChangeDetail[];
    tools: ToolPanelDetail[];
  };
  bottom: {
    terminals: TerminalDetail[];
  };
  visibleText: string;
}

const PRESENTABLE_EVENT_TYPES = new Set<string>([
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
  "LEASE_ACQUIRED",
  "RECOVERY_REQUIRED",
  "SUBAGENT_ACTIVITY",
  "MODEL_REROUTED",
  "RUNTIME_WARNING",
  "CONTEXT_COMPACTED",
]);

const ACTIVITY_KINDS = new Set<TranscriptRowKind>([
  "command",
  "tool",
  "diff",
  "approval",
  "status",
  "subagent",
]);

export function projectThreadPresentation(
  events: TaskEvent[],
  turns: Turn[],
  subagents: SubagentThread[],
): ThreadPresentation {
  const merged = normalizePresentationEvents(events);
  const orderedTurns = orderTurns(turns);
  const rowsById = new Map<string, TranscriptRow>();
  const approvalRows = new Map<string, string>();

  for (const turn of orderedTurns) {
    const itemId = `user:${turn.id}`;
    const row: TranscriptMessageRow = {
      ...rowIdentity(turn.threadId, turn.id, itemId, 0, turn.startedAt),
      kind: "user",
      text: turn.prompt,
    };
    rowsById.set(row.id, row);
  }

  for (const event of merged) {
    projectEventRow(event, rowsById, approvalRows);
  }

  const groupsById = new Map<string, TranscriptGroup>();
  const groupOrder: string[] = [];
  for (const turn of orderedTurns) {
    const id = groupId(turn.threadId, turn.id);
    groupsById.set(id, { id, threadId: turn.threadId, turnId: turn.id, rows: [] });
    groupOrder.push(id);
  }
  for (const row of rowsById.values()) {
    const id = groupId(row.threadId, row.turnId);
    if (!groupsById.has(id)) {
      groupsById.set(id, { id, threadId: row.threadId, turnId: row.turnId, rows: [] });
      groupOrder.push(id);
    }
    groupsById.get(id)?.rows.push(row);
  }

  const groups = groupOrder.map((id) => {
    const group = groupsById.get(id) as TranscriptGroup;
    group.rows.sort(compareRows);
    return group;
  });
  const rows = groups.flatMap((group) => group.rows);
  const currentTurn = selectCurrentOrLatestTurn(turns);
  const plan = currentTurn ? (selectPlanDetails(merged, currentTurn.id).at(-1) ?? null) : null;
  const outputs = selectOutputResources(merged);
  const sources = selectSourceResources(merged);
  const terminals = selectTerminalDetails(merged);
  const changes = selectChangeDetails(merged);
  const tools = selectToolDetails(merged);
  const currentRows = currentTurn ? rows.filter((row) => row.turnId === currentTurn.id) : [];
  const currentSubagents = currentTurn
    ? subagents.filter((subagent) => subagent.parentTurnId === currentTurn.id)
    : [];
  const currentOutputs = currentTurn
    ? outputs.filter((output) => output.turnId === currentTurn.id)
    : [];
  const currentSources = currentTurn
    ? sources.filter((source) => source.turnId === currentTurn.id)
    : [];
  return {
    transcript: {
      groups,
      rows,
      activities: rows.filter((row) => ACTIVITY_KINDS.has(row.kind)),
    },
    pinned: currentTurn
      ? {
          turnId: currentTurn.id,
          status: currentTurn.status,
          plan,
          reasoningSummary: currentRows
            .filter((row) => row.kind === "reasoning-summary")
            .map((row) => row.text)
            .join("\n"),
          activityCount: currentRows.filter((row) => ACTIVITY_KINDS.has(row.kind)).length,
          subagents: currentSubagents,
          outputs: currentOutputs,
          sources: currentSources,
        }
      : null,
    side: {
      plan,
      outputs,
      sources,
      subagents,
      changes,
      tools,
    },
    bottom: {
      terminals,
    },
    visibleText: rows.map((row) => row.text).join("\n"),
  };
}

export function selectCurrentOrLatestTurn(turns: Turn[]): Turn | null {
  const ordered = orderTurns(turns);
  const active = ordered.filter((turn) =>
    ["ALLOCATING", "QUEUED", "RUNNING", "WAITING_APPROVAL"].includes(turn.status),
  );
  return active.at(-1) ?? ordered.at(-1) ?? null;
}

function orderTurns(turns: Turn[]): Turn[] {
  return [...turns].sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
  );
}

export function selectPlanDetails(events: TaskEvent[], turnId?: string | null): PlanDetail[] {
  const plans = new Map<string, PlanDetail>();
  for (const event of normalizePresentationEvents(events)) {
    if (event.type !== "PLAN_UPDATED" || (turnId !== undefined && event.turnId !== turnId)) {
      continue;
    }
    const itemId = eventItemId(event);
    const id = rowId(event.threadId, event.turnId, itemId);
    plans.set(id, {
      id,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      explanation: event.payload.explanation,
      steps: sanitizePlanSteps(event.payload.plan),
    });
  }
  return [...plans.values()].sort(compareDetails);
}

export function selectTerminalDetails(events: TaskEvent[]): TerminalDetail[] {
  const terminals = new Map<string, TerminalDetail>();
  for (const event of normalizePresentationEvents(events)) {
    if (
      event.type !== "COMMAND_STARTED" &&
      event.type !== "COMMAND_OUTPUT" &&
      event.type !== "COMMAND_COMPLETED"
    ) {
      continue;
    }
    const itemId = eventItemId(event);
    const id = rowId(event.threadId, event.turnId, itemId);
    const existing = terminals.get(id);
    const base: TerminalDetail = existing ?? {
      id,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      command: null,
      cwd: null,
      status: "running",
      output: "",
      exitCode: null,
      durationMs: null,
    };
    if (event.type === "COMMAND_STARTED") {
      terminals.set(id, {
        ...base,
        command: event.payload.command,
        cwd: event.payload.cwd,
      });
    } else if (event.type === "COMMAND_OUTPUT") {
      terminals.set(id, { ...base, output: event.payload.delta });
    } else {
      terminals.set(id, {
        ...base,
        command: event.payload.command,
        status: event.payload.exitCode === 0 ? "completed" : "failed",
        output: event.payload.aggregatedOutput ?? base.output,
        exitCode: event.payload.exitCode,
        durationMs: event.payload.durationMs,
      });
    }
  }
  return [...terminals.values()].sort(compareDetails);
}

export function selectChangeDetails(events: TaskEvent[]): ChangeDetail[] {
  const changes = new Map<string, ChangeDetail>();
  for (const event of normalizePresentationEvents(events)) {
    if (event.type !== "DIFF_UPDATED") continue;
    const itemId = eventItemId(event);
    const id = rowId(event.threadId, event.turnId, itemId);
    changes.set(id, {
      id,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      diff: event.payload.diff,
      changedFiles: countChangedFiles(event.payload.diff),
    });
  }
  return [...changes.values()].sort(compareDetails);
}

export function selectToolDetails(events: TaskEvent[]): ToolPanelDetail[] {
  const tools = new Map<string, ToolPanelDetail>();
  for (const event of normalizePresentationEvents(events)) {
    if (
      event.type !== "TOOL_STARTED" &&
      event.type !== "TOOL_COMPLETED" &&
      event.type !== "TOOL_FAILED"
    ) {
      continue;
    }
    const itemId = eventItemId(event);
    const id = rowId(event.threadId, event.turnId, itemId);
    const existing = tools.get(id);
    const base: ToolPanelDetail = existing ?? {
      id,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      tool: event.payload.tool,
      status: "running",
      arguments: null,
      result: null,
      error: null,
      durationMs: null,
    };
    if (event.type === "TOOL_STARTED") {
      tools.set(id, {
        ...base,
        tool: event.payload.tool,
        arguments: sanitizeProjectionValue(event.payload.arguments) ?? null,
      });
    } else if (event.type === "TOOL_COMPLETED") {
      tools.set(id, {
        ...base,
        tool: event.payload.tool,
        status: "completed",
        result: sanitizeProjectionValue(event.payload.result) ?? null,
        error: null,
        durationMs: event.payload.durationMs,
      });
    } else {
      tools.set(id, {
        ...base,
        tool: event.payload.tool,
        status: "failed",
        result: null,
        error: event.payload.error,
        durationMs: null,
      });
    }
  }
  return [...tools.values()].sort(compareDetails);
}

export function selectOutputResources(events: TaskEvent[]): OutputResource[] {
  const outputs = new Map<string, OutputResource>();
  for (const tool of selectToolDetails(events)) {
    visitRecords(tool.result, (value) => {
      if (!isArtifactRecord(value)) return;
      const artifactId = firstString(value, ["artifactId", "artifact_id"]);
      const uri = safeArtifactUri(firstString(value, ["downloadUrl", "url", "uri", "resourceUri"]));
      const locator = artifactId ?? uri;
      if (!locator) return;
      const id = `${tool.id}\u0000artifact:${locator}`;
      outputs.set(id, {
        id,
        threadId: tool.threadId,
        turnId: tool.turnId,
        itemId: tool.itemId,
        artifactId,
        name:
          safeResourceLabel(firstString(value, ["name", "fileName", "filename", "title"])) ??
          artifactId ??
          uri ??
          "Artifact",
        uri,
        mimeType: firstString(value, ["mimeType", "mime_type", "contentType"]),
      });
    });
  }
  return [...outputs.values()];
}

export function selectSourceResources(events: TaskEvent[]): SourceResource[] {
  const sources = new Map<string, SourceResource>();
  for (const tool of selectToolDetails(events)) {
    visitRecords(tool.result, (value) => {
      if (isArtifactRecord(value)) return;
      const uri = safeSourceUri(firstString(value, ["url", "uri", "resourceUri", "resource_uri"]));
      const rawCitation =
        value.citation !== undefined
          ? value.citation
          : value.citations !== undefined
            ? value.citations
            : null;
      const citation = sanitizeCitationValue(rawCitation);
      if (!uri && citation === null) return;
      const locator = uri ?? `citation-${sources.size + 1}`;
      const id = `${tool.id}\u0000source:${locator}`;
      sources.set(id, {
        id,
        threadId: tool.threadId,
        turnId: tool.turnId,
        itemId: tool.itemId,
        title:
          safeResourceLabel(firstString(value, ["title", "name", "label"])) ?? uri ?? "Citation",
        uri,
        citation,
      });
    });
  }
  return [...sources.values()];
}

function projectEventRow(
  event: TaskEvent,
  rows: Map<string, TranscriptRow>,
  approvalRows: Map<string, string>,
): void {
  const sourceItemId = eventItemId(event);
  const itemId = preservesEveryRuntimeNotice(event.type)
    ? `${sourceItemId}:${event.sequence}`
    : sourceItemId;
  const id = rowId(event.threadId, event.turnId, itemId);
  const identity = rowIdentity(
    event.threadId,
    event.turnId,
    itemId,
    event.sequence,
    event.timestamp,
  );

  switch (event.type) {
    case "USER_MESSAGE":
      rows.set(id, { ...identity, kind: "user", text: event.payload.text });
      return;
    case "AGENT_MESSAGE_DELTA":
      rows.set(id, { ...identity, kind: "assistant", text: event.payload.delta });
      return;
    case "REASONING_SUMMARY_DELTA":
      rows.set(id, { ...identity, kind: "reasoning-summary", text: event.payload.delta });
      return;
    case "PLAN_UPDATED":
      rows.set(id, {
        ...identity,
        kind: "plan",
        text: event.payload.explanation ?? "Plan updated",
        explanation: event.payload.explanation,
        steps: sanitizePlanSteps(event.payload.plan),
      });
      return;
    case "COMMAND_STARTED":
      rows.set(id, {
        ...identity,
        kind: "command",
        text: event.payload.command,
        command: event.payload.command,
        cwd: event.payload.cwd,
        status: "running",
        exitCode: null,
        durationMs: null,
      });
      return;
    case "COMMAND_OUTPUT":
      if (!rows.has(id)) {
        rows.set(id, {
          ...identity,
          kind: "command",
          text: "Command running",
          command: null,
          cwd: null,
          status: "running",
          exitCode: null,
          durationMs: null,
        });
      }
      return;
    case "COMMAND_COMPLETED": {
      const previous = rows.get(id);
      rows.set(id, {
        ...(previous?.kind === "command" ? previous : identity),
        kind: "command",
        text: event.payload.command,
        command: event.payload.command,
        cwd: previous?.kind === "command" ? previous.cwd : null,
        status: event.payload.exitCode === 0 ? "completed" : "failed",
        exitCode: event.payload.exitCode,
        durationMs: event.payload.durationMs,
      });
      return;
    }
    case "TOOL_STARTED":
      rows.set(id, {
        ...identity,
        kind: "tool",
        text: event.payload.tool,
        tool: event.payload.tool,
        status: "running",
        error: null,
        durationMs: null,
      });
      return;
    case "TOOL_COMPLETED": {
      const previous = rows.get(id);
      rows.set(id, {
        ...(previous?.kind === "tool" ? previous : identity),
        kind: "tool",
        text: event.payload.tool,
        tool: event.payload.tool,
        status: "completed",
        error: null,
        durationMs: event.payload.durationMs,
      });
      return;
    }
    case "TOOL_FAILED": {
      const previous = rows.get(id);
      rows.set(id, {
        ...(previous?.kind === "tool" ? previous : identity),
        kind: "tool",
        text: event.payload.tool,
        tool: event.payload.tool,
        status: "failed",
        error: event.payload.error,
        durationMs: null,
      });
      return;
    }
    case "DIFF_UPDATED": {
      const changedFiles = countChangedFiles(event.payload.diff);
      rows.set(id, {
        ...identity,
        kind: "diff",
        text: changedFiles === 1 ? "1 file changed" : `${changedFiles} files changed`,
        changedFiles,
      });
      return;
    }
    case "APPROVAL_REQUESTED": {
      const approvalId = event.payload.approvalId;
      approvalRows.set(approvalId, id);
      rows.set(id, {
        ...identity,
        kind: "approval",
        text: event.payload.reason ?? `${event.payload.approvalType} approval requested`,
        approvalId,
        approvalType: event.payload.approvalType,
        status: "pending",
        reason: event.payload.reason,
        command: event.payload.command ?? null,
        cwd: event.payload.cwd ?? null,
      });
      return;
    }
    case "APPROVAL_DECIDED": {
      const approvalId = event.payload.approvalId;
      const approvalRowId = approvalRows.get(approvalId) ?? id;
      const previous = rows.get(approvalRowId);
      const status =
        event.payload.decision === "accept"
          ? "accepted"
          : event.payload.decision === "decline"
            ? "declined"
            : event.payload.decision;
      rows.set(approvalRowId, {
        ...(previous?.kind === "approval" ? previous : identity),
        kind: "approval",
        text: previous?.kind === "approval" ? previous.text : `Approval ${status}`,
        approvalId,
        approvalType: previous?.kind === "approval" ? previous.approvalType : null,
        status,
        reason: previous?.kind === "approval" ? previous.reason : null,
        command: previous?.kind === "approval" ? previous.command : null,
        cwd: previous?.kind === "approval" ? previous.cwd : null,
      });
      return;
    }
    case "SUBAGENT_ACTIVITY":
      rows.set(id, {
        ...identity,
        kind: "subagent",
        text:
          event.payload.resultSummary ??
          event.payload.name ??
          `Subagent ${event.payload.kind.toLowerCase()}`,
        agentThreadId: event.payload.agentThreadId,
        name: event.payload.name,
        role: event.payload.role,
        status: event.payload.status,
        resultSummary: event.payload.resultSummary,
      });
      return;
    case "MODEL_REROUTED":
      rows.set(id, {
        ...identity,
        kind: "status",
        status: "model-rerouted",
        text: `模型已从 ${event.payload.fromModel} 切换至 ${event.payload.toModel}（${event.payload.reason}）`,
      });
      return;
    case "RUNTIME_WARNING":
      rows.set(id, {
        ...identity,
        kind: "status",
        status: "runtime-warning",
        text: event.payload.message,
      });
      return;
    case "CONTEXT_COMPACTED":
      rows.set(id, {
        ...identity,
        kind: "status",
        status: "context-compacted",
        text: "上下文已自动压缩",
      });
      return;
    case "TURN_STARTED":
    case "TURN_COMPLETED":
    case "TURN_FAILED":
    case "TURN_INTERRUPTED":
    case "QUEUED":
    case "LEASE_ACQUIRED":
    case "RECOVERY_REQUIRED": {
      const status = statusForEvent(event);
      rows.set(id, { ...identity, kind: "status", text: status.text, status: status.status });
      return;
    }
  }
}

function preservesEveryRuntimeNotice(type: TaskEventType): boolean {
  return type === "MODEL_REROUTED" || type === "RUNTIME_WARNING" || type === "CONTEXT_COMPACTED";
}

function statusForEvent(
  event: Extract<
    TaskEvent,
    {
      type:
        | "TURN_STARTED"
        | "TURN_COMPLETED"
        | "TURN_FAILED"
        | "TURN_INTERRUPTED"
        | "QUEUED"
        | "LEASE_ACQUIRED"
        | "RECOVERY_REQUIRED";
    }
  >,
): { status: string; text: string } {
  switch (event.type) {
    case "TURN_STARTED":
      return { status: "running", text: "Turn started" };
    case "TURN_COMPLETED":
      return { status: "completed", text: "Turn completed" };
    case "TURN_FAILED":
      return { status: "failed", text: event.payload.error };
    case "TURN_INTERRUPTED":
      return { status: "interrupted", text: "Turn interrupted" };
    case "QUEUED":
      return { status: "queued", text: `Queued at position ${event.payload.position}` };
    case "LEASE_ACQUIRED":
      return { status: "allocated", text: "Runtime allocated" };
    case "RECOVERY_REQUIRED":
      return { status: "recovery-required", text: event.payload.reason };
  }
}

function rowIdentity(
  threadId: string | null,
  turnId: string | null,
  itemId: string,
  sequence: number,
  timestamp: string,
): Omit<TranscriptRowBase, "kind" | "text"> {
  return {
    id: rowId(threadId, turnId, itemId),
    threadId,
    turnId,
    itemId,
    sequence,
    timestamp,
  };
}

function eventItemId(event: TaskEvent): string {
  const payload = event.payload as Record<string, unknown>;
  return (
    event.itemId ??
    (typeof payload.itemId === "string" ? payload.itemId : null) ??
    `${event.type.toLowerCase()}:${event.turnId ?? event.threadId ?? event.taskId}`
  );
}

function rowId(threadId: string | null, turnId: string | null, itemId: string): string {
  return `${threadId ?? "no-thread"}\u0000${turnId ?? "no-turn"}\u0000${itemId}`;
}

function groupId(threadId: string | null, turnId: string | null): string {
  return `${threadId ?? "no-thread"}\u0000${turnId ?? "no-turn"}`;
}

function compareRows(left: TranscriptRow, right: TranscriptRow): number {
  return (
    left.sequence - right.sequence ||
    left.timestamp.localeCompare(right.timestamp) ||
    left.id.localeCompare(right.id)
  );
}

function compareDetails(
  left: { sequence: number; timestamp: string; id: string },
  right: { sequence: number; timestamp: string; id: string },
): number {
  return (
    left.sequence - right.sequence ||
    left.timestamp.localeCompare(right.timestamp) ||
    left.id.localeCompare(right.id)
  );
}

function normalizePresentationEvents(events: TaskEvent[]): TaskEvent[] {
  const safeEvents = events.filter((event) => PRESENTABLE_EVENT_TYPES.has(String(event.type)));
  return coalesceThreadEvents(mergeThreadEvents([], safeEvents));
}

function sanitizeProjectionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const clean = sanitizeProjectionValue(item);
      return clean === undefined ? [] : [clean];
    });
  }
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const marker = String(source.kind ?? source.type ?? "").toUpperCase();
  if (marker === "PROVIDER_REASONING_TEXT" || marker === "REASONING") return undefined;
  const forbidden = new Set([
    "reasoningTextDelta",
    "reasoning_text_delta",
    "encrypted_content",
    "encryptedContent",
  ]);
  const containsReasoningTransport = Object.keys(source).some((key) => forbidden.has(key));
  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(source)) {
    if (forbidden.has(key) || (containsReasoningTransport && key === "content")) continue;
    const value = sanitizeProjectionValue(nested);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

function sanitizePlanSteps(value: unknown[]): unknown[] {
  const clean = sanitizeProjectionValue(value);
  return Array.isArray(clean) ? clean : [];
}

function visitRecords(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitRecords(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const nested of Object.values(record)) visitRecords(nested, visit);
}

function isArtifactRecord(value: Record<string, unknown>): boolean {
  if (firstString(value, ["artifactId", "artifact_id"])) return true;
  const marker = firstString(value, ["kind", "type"])?.toLowerCase();
  return marker === "artifact" || marker?.endsWith("_artifact") === true;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function safeArtifactUri(value: string | null): string | null {
  if (!value) return null;
  return safeHttpsUri(value);
}

function safeSourceUri(value: string | null): string | null {
  return value ? safeHttpsUri(value) : null;
}

function safeHttpsUri(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function sanitizeCitationValue(value: unknown): unknown | null {
  if (typeof value === "string") {
    if (looksLikeUnsafeLocator(value)) return null;
    return value;
  }
  if (Array.isArray(value)) {
    const clean = value.flatMap((item) => {
      const nested = sanitizeCitationValue(item);
      return nested === null ? [] : [nested];
    });
    return clean.length > 0 ? clean : null;
  }
  if (!value || typeof value !== "object") return value ?? null;
  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/^(?:path|file_?path|cwd)$/i.test(key)) continue;
    if (/^(?:url|uri|resource_?uri)$/i.test(key) && typeof nested === "string") {
      const uri = safeSourceUri(nested);
      if (uri) clean[key] = uri;
      continue;
    }
    const nestedClean = sanitizeCitationValue(nested);
    if (nestedClean !== null) clean[key] = nestedClean;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

function looksLikeUnsafeLocator(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^(?:file|javascript|data):/i.test(value)
  );
}

function safeResourceLabel(value: string | null): string | null {
  if (!value || looksLikeUnsafeLocator(value)) return null;
  return value;
}

function countChangedFiles(diff: string): number {
  return new Set(
    diff
      .split("\n")
      .flatMap((line) => (line.startsWith("+++ b/") ? [line.slice("+++ b/".length)] : [])),
  ).size;
}
