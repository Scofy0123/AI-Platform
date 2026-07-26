import { z } from "zod";

export const PLATFORM_VERSION = "0.1.0" as const;

export const TaskStatusSchema = z.enum([
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "NEEDS_RECOVERY",
]);

export const TaskSummarySchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    status: TaskStatusSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const QueueStateSchema = z
  .object({
    position: z.number().int().positive(),
    etaMs: z.number().int().nonnegative(),
    etaEstimated: z.boolean(),
  })
  .strict();

export const TaskDetailSchema = TaskSummarySchema.extend({
  prompt: z.string().nullable(),
  accountAlias: z.string().nullable(),
  queue: QueueStateSchema.nullable(),
}).strict();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const TASK_EVENT_TYPES = [
  "TURN_STARTED",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "TURN_INTERRUPTED",
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
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export interface TaskEventPayloadMap {
  TURN_STARTED: { status: "inProgress" };
  TURN_COMPLETED: { status: "completed"; durationMs?: number | null };
  TURN_FAILED: { status: "failed"; error: string };
  TURN_INTERRUPTED: { status: "interrupted" };
  AGENT_MESSAGE_DELTA: { itemId: string; delta: string };
  REASONING_SUMMARY_DELTA: { itemId: string; delta: string };
  PLAN_UPDATED: { explanation: string | null; plan: unknown[] };
  COMMAND_STARTED: { itemId: string; command: string; cwd: string };
  COMMAND_OUTPUT: { itemId: string; delta: string };
  COMMAND_COMPLETED: {
    itemId: string;
    command: string;
    exitCode: number | null;
    durationMs: number | null;
  };
  TOOL_STARTED: { itemId: string; tool: string; arguments: unknown };
  TOOL_COMPLETED: { itemId: string; tool: string; durationMs: number | null };
  TOOL_FAILED: { itemId: string; tool: string; error: string | null };
  DIFF_UPDATED: { diff: string };
  APPROVAL_REQUESTED: {
    /** Platform approval UUID. UI and REST callers must use this identity. */
    approvalId: string;
    itemId: string;
    approvalType: "COMMAND" | "FILE_CHANGE" | "PERMISSIONS";
    reason: string | null;
    command?: string | null;
    cwd?: string | null;
  };
  APPROVAL_DECIDED: { approvalId: string; decision: string };
  QUEUED: { position: number; etaMs: number; etaEstimated: boolean };
  LEASE_ACQUIRED: { accountAlias: string };
  RECOVERY_REQUIRED: { reason: string };
}

export interface TaskEventEnvelope {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  sequence: number;
  timestamp: string;
}

export type TaskEvent = {
  [Type in TaskEventType]: TaskEventEnvelope & {
    type: Type;
    payload: TaskEventPayloadMap[Type];
  };
}[TaskEventType];

export const TaskEventSchema = z.object({
  taskId: z.string().min(1),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  type: z.enum(TASK_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});
