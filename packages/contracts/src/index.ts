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

export const ProductModeSchema = z.enum(["CODEX", "CHAT", "WORK"]);
export type ProductMode = z.infer<typeof ProductModeSchema>;

export const BootstrapSchema = z
  .object({
    platformVersion: z.string().min(1),
    defaultMode: z.literal("CODEX"),
    enabledModes: z.tuple([z.literal("CODEX")]),
    capabilities: z
      .object({
        threads: z.literal(true),
        settings: z.literal(true),
        subagents: z.literal(true),
        reasoningSummaries: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type Bootstrap = z.infer<typeof BootstrapSchema>;

export const ModelEffortOptionSchema = z
  .object({
    value: z.string().trim().min(1),
    description: z.string(),
  })
  .strict();
export type ModelEffortOption = z.infer<typeof ModelEffortOptionSchema>;

export const ModelOptionSchema = z
  .object({
    id: z.string().trim().min(1),
    model: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    description: z.string(),
    hidden: z.boolean(),
    isDefault: z.boolean(),
    defaultReasoningEffort: z.string().trim().min(1),
    supportedReasoningEfforts: z.array(ModelEffortOptionSchema).min(1),
    // App Server owns this vocabulary; strings preserve forward compatibility.
    inputModalities: z.array(z.string().trim().min(1)),
    supportsPersonality: z.boolean(),
  })
  .strict()
  .superRefine((model, context) => {
    const effortValues = model.supportedReasoningEfforts.map((effort) => effort.value);
    if (!effortValues.includes(model.defaultReasoningEffort)) {
      context.addIssue({
        code: "custom",
        path: ["defaultReasoningEffort"],
        message: "Default reasoning effort must be supported by the model",
      });
    }

    const seenEfforts = new Set<string>();
    for (const [index, effort] of model.supportedReasoningEfforts.entries()) {
      if (seenEfforts.has(effort.value)) {
        context.addIssue({
          code: "custom",
          path: ["supportedReasoningEfforts", index, "value"],
          message: "Reasoning effort values must be unique",
        });
      }
      seenEfforts.add(effort.value);
    }
  });
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const ModelCatalogSchema = z
  .object({
    models: z.array(ModelOptionSchema),
    scope: z.enum(["SINGLE_ACCOUNT", "ELIGIBLE_ACCOUNT_INTERSECTION"]),
    accountCount: z.number().int().positive(),
    observedAt: z.iso.datetime(),
    stale: z.boolean(),
  })
  .strict()
  .superRefine((catalog, context) => {
    if (catalog.scope === "SINGLE_ACCOUNT" && catalog.accountCount !== 1) {
      context.addIssue({
        code: "custom",
        path: ["accountCount"],
        message: "Single-account catalogs must represent exactly one account",
      });
    }
  });
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export const TASK_EVENT_TYPES = [
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
  "LEASE_ACQUIRED",
  "RECOVERY_REQUIRED",
  "SUBAGENT_ACTIVITY",
  "TOKEN_USAGE_UPDATED",
  "MODEL_REROUTED",
  "RUNTIME_WARNING",
  "CONTEXT_COMPACTED",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const AgentMessagePhaseSchema = z.enum(["commentary", "final_answer"]);
export type AgentMessagePhase = z.infer<typeof AgentMessagePhaseSchema>;

export const RuntimeModelRerouteReasonSchema = z.enum([
  "SAFETY_POLICY",
  "AVAILABILITY",
  "CAPABILITY",
  "OTHER",
]);
export type RuntimeModelRerouteReason = z.infer<typeof RuntimeModelRerouteReasonSchema>;

export const ReasoningPresentationSchema = z
  .object({
    provider: z.string().min(1),
    kind: z.enum(["SUMMARY", "PROVIDER_REASONING_TEXT"]),
    summary: z.string(),
    displayable: z.boolean(),
    auditEligible: z.literal(false),
  })
  .strict();
export type ReasoningPresentation = z.infer<typeof ReasoningPresentationSchema>;

export const EffectiveThreadConfigSnapshotSchema = z
  .object({
    model: z.string().trim().min(1).nullable(),
    reasoningEffort: z.string().min(1),
    permissionMode: z.enum(["DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"]),
    approvalMode: z.literal("ASK"),
    personality: z.enum(["NONE", "FRIENDLY", "PRAGMATIC"]),
    instructions: z.string(),
    sourceVersion: z.string().min(1),
  })
  .strict();
export type EffectiveThreadConfigSnapshot = z.infer<typeof EffectiveThreadConfigSnapshotSchema>;

export const EffectiveConfigOverrideSchema = EffectiveThreadConfigSnapshotSchema.pick({
  model: true,
  reasoningEffort: true,
  permissionMode: true,
  approvalMode: true,
  personality: true,
  instructions: true,
}).partial();
export type EffectiveConfigOverride = z.infer<typeof EffectiveConfigOverrideSchema>;

export const TokenUsageBreakdownSchema = z
  .object({
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
  })
  .strict();
export type TokenUsageBreakdown = z.infer<typeof TokenUsageBreakdownSchema>;

export const TurnStatusSchema = z.enum([
  "ALLOCATING",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "NEEDS_RECOVERY",
  "ABANDONED_FOR_RESUME",
]);

export const TurnSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    prompt: z.string(),
    status: TurnStatusSchema,
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    permissionMode: z.string().nullable(),
    configSnapshot: EffectiveThreadConfigSnapshotSchema,
  })
  .strict();
export type Turn = z.infer<typeof TurnSchema>;

export const ThreadItemSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().nullable(),
    sequence: z.number().int().positive(),
    type: z.enum(TASK_EVENT_TYPES),
    timestamp: z.iso.datetime(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ThreadItem = z.infer<typeof ThreadItemSchema>;

export const ThreadSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    title: z.string().min(1),
    status: TaskStatusSchema,
    updatedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
    currentTurn: TurnSchema.nullable(),
    turns: z.array(TurnSchema),
    queue: QueueStateSchema.nullable(),
    items: z.array(ThreadItemSchema),
  })
  .strict();
export type Thread = z.infer<typeof ThreadSchema>;

export const SubagentStatusSchema = z.enum(["ACTIVE", "DONE", "FAILED", "INTERRUPTED", "UNKNOWN"]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

export const SubagentThreadSchema = z
  .object({
    threadId: z.string().min(1),
    parentThreadId: z.string().min(1),
    parentTurnId: z.string().nullable(),
    sessionId: z.string().nullable(),
    name: z.string().min(1),
    role: z.string().min(1),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    status: SubagentStatusSchema,
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    elapsedMs: z.number().int().nonnegative(),
    resultSummary: z.string().nullable(),
    tokenUsage: TokenUsageBreakdownSchema.nullable(),
  })
  .strict();
export type SubagentThread = z.infer<typeof SubagentThreadSchema>;

export const SubagentThreadDetailSchema = SubagentThreadSchema.extend({
  items: z.array(ThreadItemSchema),
}).strict();
export type SubagentThreadDetail = z.infer<typeof SubagentThreadDetailSchema>;

export const ActorContextSchema = z
  .object({
    tenantKey: z.string().min(1),
    userId: z.string().min(1),
    role: z.enum(["ADMIN", "MEMBER"]),
    toolScopes: z.array(z.string()),
    approvalPolicy: z.string().min(1),
  })
  .strict();
export type ActorContext = z.infer<typeof ActorContextSchema>;

export const UserGeneralSettingsSchema = z
  .object({
    language: z.string().min(1).max(32),
    theme: z.enum(["SYSTEM", "LIGHT", "DARK"]),
    defaultProjectId: z.string().min(1).nullable(),
    notificationsEnabled: z.boolean(),
  })
  .strict();

export const UserExecutionSettingsSchema = z
  .object({
    model: z.string().min(1).nullable(),
    reasoningEffort: z.string().trim().min(1).max(64),
    permissionMode: z.enum(["DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"]),
    approvalPreference: z.literal("ASK"),
  })
  .strict();

export const UserPersonalizationSettingsSchema = z
  .object({
    personality: z.enum(["NONE", "FRIENDLY", "PRAGMATIC"]),
    instructions: z.string().max(20_000),
  })
  .strict();

export const UserSettingsSchema = z
  .object({
    general: UserGeneralSettingsSchema,
    execution: UserExecutionSettingsSchema,
    personalization: UserPersonalizationSettingsSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const UserSettingsPolicySchema = z
  .object({
    /** null means the runtime-provided model catalog is not yet available. */
    allowedModels: z.array(z.string().min(1)).nullable(),
    allowedReasoningEfforts: z.array(UserExecutionSettingsSchema.shape.reasoningEffort),
    allowedPermissionModes: z.array(UserExecutionSettingsSchema.shape.permissionMode),
    allowedApprovalPreferences: z.array(UserExecutionSettingsSchema.shape.approvalPreference),
    lockedFields: z.array(
      z.enum([
        "execution.model",
        "execution.reasoningEffort",
        "execution.permissionMode",
        "execution.approvalPreference",
      ]),
    ),
  })
  .strict();

export const UserSettingsViewSchema = UserSettingsSchema.extend({
  policy: UserSettingsPolicySchema,
}).strict();
export type UserSettingsView = z.infer<typeof UserSettingsViewSchema>;

export const UserSettingsPatchSchema = z
  .object({
    general: UserGeneralSettingsSchema.partial().optional(),
    execution: UserExecutionSettingsSchema.partial().optional(),
    personalization: UserPersonalizationSettingsSchema.partial().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.general !== undefined ||
      value.execution !== undefined ||
      value.personalization !== undefined,
    { message: "At least one settings field is required" },
  );
export type UserSettingsPatch = z.infer<typeof UserSettingsPatchSchema>;

export interface TaskEventPayloadMap {
  TURN_STARTED: { status: "inProgress" };
  TURN_COMPLETED: { status: "completed"; durationMs?: number | null };
  TURN_FAILED: { status: "failed"; error: string };
  TURN_INTERRUPTED: { status: "interrupted" };
  USER_MESSAGE: { itemId: string; kind: "STEER"; text: string };
  AGENT_MESSAGE_DELTA: { itemId: string; delta: string };
  AGENT_MESSAGE_PHASE: { itemId: string; phase: AgentMessagePhase | null };
  REASONING_SUMMARY_DELTA: { itemId: string; delta: string };
  PLAN_UPDATED: { explanation: string | null; plan: unknown[] };
  COMMAND_STARTED: { itemId: string; command: string; cwd: string };
  COMMAND_OUTPUT: { itemId: string; delta: string };
  COMMAND_COMPLETED: {
    itemId: string;
    command: string;
    aggregatedOutput: string | null;
    exitCode: number | null;
    durationMs: number | null;
  };
  TOOL_STARTED: { itemId: string; tool: string; arguments: unknown };
  TOOL_COMPLETED: {
    itemId: string;
    tool: string;
    result: unknown | null;
    durationMs: number | null;
  };
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
    sourceThreadId?: string | null;
    sourceSubagent?: boolean;
    sourceSubagentName?: string | null;
  };
  APPROVAL_DECIDED: { approvalId: string; decision: string };
  QUEUED: { position: number; etaMs: number; etaEstimated: boolean };
  LEASE_ACQUIRED: { accountAlias: string };
  RECOVERY_REQUIRED: { reason: string };
  SUBAGENT_ACTIVITY: {
    itemId: string;
    agentThreadId: string;
    kind: "started" | "interacted" | "interrupted" | "completed" | "failed" | "unknown";
    name: string | null;
    role: string | null;
    model: string | null;
    effort: string | null;
    status: "ACTIVE" | "DONE" | "FAILED" | "INTERRUPTED" | "UNKNOWN";
    resultSummary: string | null;
  };
  TOKEN_USAGE_UPDATED: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
  };
  MODEL_REROUTED: {
    fromModel: string;
    toModel: string;
    reason: RuntimeModelRerouteReason;
  };
  RUNTIME_WARNING: { message: string };
  CONTEXT_COMPACTED: { status: "completed" };
}

export interface TaskEventEnvelope {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  /**
   * Stable projection boundary for clients. It is optional in the type so
   * legacy in-process producers remain source-compatible; persisted and HTTP
   * events always populate it with either the protocol item id or a stable
   * derived id.
   */
  itemId?: string | null;
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
  itemId: z.string().nullable().optional(),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime(),
  type: z.enum(TASK_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});
