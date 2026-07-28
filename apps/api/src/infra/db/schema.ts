import { integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const codexAccounts = sqliteTable("codex_accounts", {
  id: text("id").primaryKey(),
  alias: text("alias").notNull(),
  codexHome: text("codex_home"),
  status: text("status").notNull(),
  authStatus: text("auth_status").notNull(),
  maxActiveUsers: integer("max_active_users").notNull().default(4),
  weeklyRemaining: real("weekly_remaining"),
  quotaUpdatedAt: integer("quota_updated_at", { mode: "timestamp_ms" }),
  quotaResetsAt: integer("quota_resets_at", { mode: "timestamp_ms" }),
  allowUnknownQuota: integer("allow_unknown_quota", { mode: "boolean" }).notNull().default(false),
  healthScore: integer("health_score").notNull().default(100),
  lastAssignedAt: integer("last_assigned_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const accountSlots = sqliteTable(
  "account_slots",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => codexAccounts.id, { onDelete: "cascade" }),
    slotIndex: integer("slot_index").notNull(),
    userId: text("user_id"),
    leaseId: text("lease_id"),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.slotIndex] }),
    uniqueIndex("account_slots_account_user_unique").on(table.accountId, table.userId),
  ],
);

export const accountLeases = sqliteTable("account_leases", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => codexAccounts.id),
  userId: text("user_id").notNull(),
  slotIndex: integer("slot_index").notNull(),
  status: text("status").notNull(),
  acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull(),
  lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp_ms" }).notNull(),
  releasedAt: integer("released_at", { mode: "timestamp_ms" }),
  releaseReason: text("release_reason"),
});

export const userTurnSlots = sqliteTable(
  "user_turn_slots",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => codexAccounts.id),
    userId: text("user_id").notNull(),
    slotIndex: integer("slot_index").notNull(),
    taskId: text("task_id").notNull(),
    turnId: text("turn_id").notNull(),
    status: text("status").notNull(),
    acquiredAt: integer("acquired_at", { mode: "timestamp_ms" }).notNull(),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.userId, table.slotIndex] }),
    uniqueIndex("user_turn_slots_turn_unique").on(table.turnId),
  ],
);

export const queueEntries = sqliteTable("queue_entries", {
  ticket: integer("ticket").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  taskId: text("task_id").notNull(),
  turnId: text("turn_id").notNull(),
  requiredAccountId: text("required_account_id"),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  enqueuedAt: integer("enqueued_at", { mode: "timestamp_ms" }).notNull(),
  assignedAt: integer("assigned_at", { mode: "timestamp_ms" }),
  accountId: text("account_id"),
  leaseId: text("lease_id"),
});

export const turnDurationSamples = sqliteTable("turn_duration_samples", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  durationMs: integer("duration_ms").notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    tenantKey: text("tenant_key").notNull(),
    openId: text("open_id").notNull(),
    unionId: text("union_id"),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    role: text("role").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("users_tenant_open_id_unique").on(table.tenantKey, table.openId)],
);

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  settingsJson: text("settings_json").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const feishuCredentials = sqliteTable("feishu_credentials", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
  accessExpiresAt: integer("access_expires_at", { mode: "timestamp_ms" }).notNull(),
  refreshExpiresAt: integer("refresh_expires_at", { mode: "timestamp_ms" }).notNull(),
  scopes: text("scopes").notNull(),
  tokenType: text("token_type").notNull(),
  status: text("status").notNull().default("CONNECTED"),
  lastRefreshErrorCode: text("last_refresh_error_code"),
  reauthRequiredAt: integer("reauth_required_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const oauthStates = sqliteTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  csrfHash: text("csrf_hash").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  persistentAt: integer("persistent_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: text("status").notNull(),
  queueTicket: integer("queue_ticket"),
  accountId: text("account_id"),
  accountAlias: text("account_alias"),
  leaseId: text("lease_id"),
  threadId: text("thread_id"),
  currentTurnId: text("current_turn_id"),
  threadConfigJson: text("thread_config_json"),
  archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  lifecycleState: text("lifecycle_state").notNull().default("ACTIVE"),
  draftExpiresAt: integer("draft_expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const turns = sqliteTable("turns", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  codexTurnId: text("codex_turn_id"),
  prompt: text("prompt").notNull(),
  status: text("status").notNull(),
  configSnapshotJson: text("config_snapshot_json"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  durationMs: integer("duration_ms"),
});

export const draftAttachments = sqliteTable("draft_attachments", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  relativePath: text("relative_path").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  fileCount: integer("file_count").notNull(),
  scanStatus: text("scan_status").notNull(),
  blockedReason: text("blocked_reason"),
  claimedTurnId: text("claimed_turn_id").references(() => turns.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const turnInputSnapshots = sqliteTable("turn_input_snapshots", {
  turnId: text("turn_id")
    .primaryKey()
    .references(() => turns.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  attachmentsJson: text("attachments_json").notNull(),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
});

export const steerInputSnapshots = sqliteTable("steer_input_snapshots", {
  id: text("id").primaryKey(),
  turnId: text("turn_id")
    .notNull()
    .references(() => turns.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  attachmentsJson: text("attachments_json").notNull(),
  deliveryStatus: text("delivery_status").notNull().default("PENDING"),
  deliveryError: text("delivery_error"),
  deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  failedAt: integer("failed_at", { mode: "timestamp_ms" }),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
});

export const attachmentCleanupJobs = sqliteTable(
  "attachment_cleanup_jobs",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull(),
    attachmentId: text("attachment_id").notNull(),
    relativePath: text("relative_path").notNull(),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("attachment_cleanup_jobs_target_idx").on(table.threadId, table.attachmentId),
  ],
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    threadId: text("thread_id"),
    turnId: text("turn_id"),
    itemId: text("item_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("task_events_task_sequence_unique").on(table.taskId, table.sequence)],
);

export const subagentThreads = sqliteTable("subagent_threads", {
  threadId: text("thread_id").primaryKey(),
  parentTaskId: text("parent_task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  parentThreadId: text("parent_thread_id"),
  parentTurnId: text("parent_turn_id"),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id"),
  name: text("name").notNull(),
  role: text("role").notNull(),
  model: text("model"),
  effort: text("effort"),
  status: text("status").notNull(),
  resultSummary: text("result_summary"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const subagentEvents = sqliteTable(
  "subagent_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: text("thread_id")
      .notNull()
      .references(() => subagentThreads.threadId, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    turnId: text("turn_id"),
    itemId: text("item_id").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("subagent_events_thread_sequence_unique").on(table.threadId, table.sequence),
  ],
);

export const threadTokenUsage = sqliteTable("thread_token_usage", {
  runtimeThreadId: text("runtime_thread_id").primaryKey(),
  parentTaskId: text("parent_task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  parentRuntimeThreadId: text("parent_runtime_thread_id"),
  turnId: text("turn_id"),
  totalTokens: integer("total_tokens").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  cachedInputTokens: integer("cached_input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  reasoningOutputTokens: integer("reasoning_output_tokens").notNull(),
  lastTotalTokens: integer("last_total_tokens").notNull(),
  lastInputTokens: integer("last_input_tokens").notNull(),
  lastCachedInputTokens: integer("last_cached_input_tokens").notNull(),
  lastOutputTokens: integer("last_output_tokens").notNull(),
  lastReasoningOutputTokens: integer("last_reasoning_output_tokens").notNull(),
  modelContextWindow: integer("model_context_window"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  rawRequestIdJson: text("raw_request_id_json"),
  transportAccountId: text("transport_account_id"),
  connectionGeneration: integer("connection_generation"),
  threadId: text("thread_id"),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  parentTurnId: text("parent_turn_id"),
  itemId: text("item_id").notNull(),
  approvalType: text("approval_type").notNull(),
  status: text("status").notNull(),
  payloadJson: text("payload_json").notNull(),
  decision: text("decision"),
  requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  decidedBy: text("decided_by").references(() => users.id),
});

export const toolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(),
  callId: text("call_id").notNull().unique(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tool: text("tool").notNull(),
  status: text("status").notNull(),
  inputDigest: text("input_digest").notNull(),
  outputDigest: text("output_digest"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id")
    .notNull()
    .references(() => users.id),
  accountId: text("account_id"),
  accountAlias: text("account_alias"),
  leaseId: text("lease_id"),
  taskId: text("task_id"),
  threadId: text("thread_id"),
  turnId: text("turn_id"),
  toolCallId: text("tool_call_id"),
  approvalId: text("approval_id"),
  action: text("action").notNull(),
  outcome: text("outcome").notNull(),
  summary: text("summary").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const schema = {
  codexAccounts,
  accountSlots,
  accountLeases,
  userTurnSlots,
  queueEntries,
  turnDurationSamples,
  users,
  userSettings,
  feishuCredentials,
  oauthStates,
  sessions,
  projects,
  tasks,
  turns,
  taskEvents,
  subagentThreads,
  subagentEvents,
  approvals,
  toolCalls,
  auditEvents,
};
