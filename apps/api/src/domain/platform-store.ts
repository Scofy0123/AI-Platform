import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  type ComposerState,
  type DraftAttachment,
  DraftAttachmentSchema,
  type EffectiveConfigOverride,
  EffectiveConfigOverrideSchema,
  type EffectiveThreadConfigSnapshot,
  EffectiveThreadConfigSnapshotSchema,
  type EffectiveTurnInputSnapshot,
  EffectiveTurnInputSnapshotSchema,
  type SubagentStatus,
  type SubagentThread,
  type SubagentThreadDetail,
  type TaskEvent,
  type TaskEventPayloadMap,
  type TaskEventType,
  type ThreadGoalPatch,
  ThreadGoalPatchSchema,
  type ThreadGoalSnapshot,
  type ThreadGoalView,
  ThreadGoalViewSchema,
  type ThreadItem,
  type TokenUsageBreakdown,
  TokenUsageBreakdownSchema,
  type UserSettings,
  type UserSettingsPatch,
  UserSettingsSchema,
} from "@codexplatform/contracts";
import type Database from "better-sqlite3";
import {
  type RuntimePathRedactionContext,
  sanitizeEventTransport,
} from "../event-payload-safety.js";
import {
  MAX_ATTACHMENT_ROOTS,
  MAX_FOLDER_FILES,
  MAX_TURN_ATTACHMENT_BYTES,
} from "./attachments.js";
import {
  ComposerRevisionConflictError,
  GoalMutationBlockedByPendingTurnError,
  GoalMutationSupersededError,
  PlanModeMutationBlockedError,
} from "./errors.js";

export interface ProjectRecord {
  id: string;
  ownerId: string;
  name: string;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SteerInputSnapshotRecord extends EffectiveTurnInputSnapshot {
  deliveryStatus: "PENDING" | "DELIVERED" | "FAILED" | "UNKNOWN";
  deliveryError: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  unknownAt: string | null;
}

export interface AttachmentCleanupJob {
  id: string;
  threadId: string;
  attachmentId: string;
  relativePath: string;
  status: "PENDING" | "FAILED";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ThreadGoalRow {
  task_id: string;
  objective: string;
  status: ThreadGoalView["status"];
  token_budget: number;
  tokens_used: number;
  time_budget_seconds: number;
  time_used_seconds: number;
  runtime_sync_state: ThreadGoalView["runtimeSyncState"];
  runtime_thread_id: string | null;
  runtime_updated_at: number | null;
  revision: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export type StoredThreadGoalView = ThreadGoalView & { revision: number };

export interface ThreadGoalTokenUpdate {
  triggered: boolean;
  goal: StoredThreadGoalView;
}

export interface ThreadGoalBudgetTransition {
  ownerId: string;
  goal: StoredThreadGoalView;
}

export interface RecoveredPersistedGoal {
  taskId: string;
  ownerId: string;
  runtimeThreadId: string;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  ownerId: string;
  title: string;
  status: string;
  queueTicket: number | null;
  accountId: string | null;
  accountAlias: string | null;
  leaseId: string | null;
  threadId: string | null;
  currentTurnId: string | null;
  threadConfig: EffectiveConfigOverride | null;
  archivedAt: string | null;
  lifecycleState: "DRAFT" | "ACTIVE" | "EXPIRED";
  draftExpiresAt: string | null;
  planMode: boolean;
  composerRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  requestId: string;
  taskId: string;
  turnId: string;
  parentTurnId: string;
  sourceThreadId: string | null;
  itemId: string;
  approvalType: string;
  status: string;
  payload: unknown;
  decision: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

export interface PublicApprovalRecord extends Omit<ApprovalRecord, "turnId" | "parentTurnId"> {
  turnId: string | null;
  parentTurnId: string | null;
}

export interface RecoveredAccountTask {
  taskId: string;
  ownerId: string;
  runtimeThreadId: string | null;
  runtimeTurnId: string | null;
  platformTurnId: string | null;
}

export interface ApprovalTransportIdentity {
  accountId: string;
  connectionGeneration: number;
  threadId: string;
  turnId: string;
  requestId: string;
  rawRpcId: number | string;
}

export type ApprovalDeliveryClaim =
  | { kind: "CLAIMED"; approval: ApprovalRecord; transport: ApprovalTransportIdentity }
  | { kind: "ALREADY_DELIVERED"; approval: ApprovalRecord };

export interface TurnRecord {
  id: string;
  taskId: string;
  ownerId: string;
  prompt: string;
  status: string;
  codexTurnId: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  configSnapshot: EffectiveThreadConfigSnapshot;
}

export interface UserUsageRecord {
  threads: number;
  turns: number;
  toolCalls: number;
  subagents: number;
  tokenUsage:
    | ({
        scope: "OWNED_THREAD_TREES";
      } & TokenUsageBreakdown)
    | null;
  tokenUsageStatus: "KNOWN" | "UNKNOWN";
  quota: {
    scope: "SHARED_CODEX_ACCOUNT";
    attributableToUser: false;
  };
}

export interface UserConnectionRecord {
  id: "feishu";
  name: "飞书";
  managed: true;
  connected: boolean;
  scopes: string[];
  status: "CONNECTED" | "REFRESHING" | "REAUTH_REQUIRED" | "NOT_CONNECTED";
}

interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  task_count: number;
  created_at: number;
  updated_at: number;
}

interface TaskRow {
  id: string;
  project_id: string;
  owner_id: string;
  title: string;
  status: string;
  queue_ticket: number | null;
  account_id: string | null;
  account_alias: string | null;
  lease_id: string | null;
  thread_id: string | null;
  current_turn_id: string | null;
  thread_config_json: string | null;
  archived_at: number | null;
  lifecycle_state: "DRAFT" | "ACTIVE" | "EXPIRED";
  draft_expires_at: number | null;
  plan_mode: number;
  composer_revision: number;
  created_at: number;
  updated_at: number;
}

interface AttachmentRow {
  id: string;
  task_id: string;
  kind: "FILE" | "FOLDER";
  name: string;
  relative_path: string;
  mime_type: string;
  size_bytes: number;
  file_count: number;
  scan_status: DraftAttachment["scanStatus"];
  created_at: number;
}

interface EventRow {
  task_id: string;
  sequence: number;
  thread_id: string | null;
  turn_id: string | null;
  item_id: string | null;
  type: TaskEventType;
  payload_json: string;
  created_at: number;
}

interface TurnRow {
  id: string;
  task_id: string;
  owner_id: string;
  codex_turn_id: string | null;
  prompt: string;
  status: string;
  config_snapshot_json: string | null;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
}

interface UserSettingsRow {
  settings_json: string;
  updated_at: number;
}

interface SubagentRow {
  thread_id: string;
  parent_task_id: string;
  parent_thread_id: string | null;
  parent_turn_id: string | null;
  owner_id: string;
  session_id: string | null;
  name: string;
  role: string;
  model: string | null;
  effort: string | null;
  status: SubagentStatus;
  result_summary: string | null;
  started_at: number;
  completed_at: number | null;
  updated_at: number;
}

interface SubagentEventRow {
  thread_id: string;
  sequence: number;
  turn_id: string | null;
  item_id: string;
  type: TaskEventType;
  payload_json: string;
  created_at: number;
}

interface ThreadTokenUsageRow {
  runtime_thread_id: string;
  parent_task_id: string;
  owner_id: string;
  parent_runtime_thread_id: string | null;
  turn_id: string | null;
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  last_total_tokens: number;
  last_input_tokens: number;
  last_cached_input_tokens: number;
  last_output_tokens: number;
  last_reasoning_output_tokens: number;
  model_context_window: number | null;
  updated_at: number;
}

export class SQLitePlatformStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly options: { runtimeDataDir?: string } = {},
  ) {}

  createProject(input: { ownerId: string; name: string; now: Date }): ProjectRecord {
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO projects (id, owner_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.ownerId, input.name, input.now.getTime(), input.now.getTime());
    return this.getProject(id, input.ownerId) as ProjectRecord;
  }

  listProjects(ownerId: string): ProjectRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM tasks t
            WHERE t.project_id = p.id AND t.lifecycle_state = 'ACTIVE') AS task_count
         FROM projects p WHERE p.owner_id = ? ORDER BY p.updated_at DESC, p.id`,
      )
      .all(ownerId) as ProjectRow[];
    return rows.map(mapProject);
  }

  createTask(input: {
    ownerId: string;
    projectId: string;
    title: string;
    threadConfig?: EffectiveConfigOverride | null;
    now: Date;
  }): TaskRecord {
    const ownsProject = this.getProject(input.projectId, input.ownerId);
    if (!ownsProject) throw new Error("Project not found");
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO tasks (
          id, project_id, owner_id, title, status, thread_config_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'READY', ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.ownerId,
        input.title,
        input.threadConfig
          ? JSON.stringify(EffectiveConfigOverrideSchema.parse(input.threadConfig))
          : null,
        input.now.getTime(),
        input.now.getTime(),
      );
    return this.getTaskForUser(id, input.ownerId) as TaskRecord;
  }

  createDraft(input: {
    ownerId: string;
    projectId: string;
    now: Date;
    expiresAt: Date;
  }): TaskRecord {
    if (!this.getProject(input.projectId, input.ownerId)) throw new Error("Project not found");
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO tasks (
          id, project_id, owner_id, title, status, lifecycle_state, draft_expires_at,
          created_at, updated_at
         ) VALUES (?, ?, ?, 'Untitled', 'DRAFT', 'DRAFT', ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.ownerId,
        input.expiresAt.getTime(),
        input.now.getTime(),
        input.now.getTime(),
      );
    return this.getTaskForUser(id, input.ownerId) as TaskRecord;
  }

  listTasks(ownerId: string, projectId?: string): TaskRecord[] {
    const rows = projectId
      ? (this.sqlite
          .prepare(
            `SELECT * FROM tasks
             WHERE owner_id = ? AND project_id = ? AND archived_at IS NULL
               AND lifecycle_state = 'ACTIVE'
             ORDER BY updated_at DESC`,
          )
          .all(ownerId, projectId) as TaskRow[])
      : (this.sqlite
          .prepare(
            `SELECT * FROM tasks
             WHERE owner_id = ? AND archived_at IS NULL AND lifecycle_state = 'ACTIVE'
             ORDER BY updated_at DESC`,
          )
          .all(ownerId) as TaskRow[]);
    return rows.map(mapTask);
  }

  listArchivedTasks(ownerId: string): TaskRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM tasks
         WHERE owner_id = ? AND archived_at IS NOT NULL AND lifecycle_state = 'ACTIVE'
         ORDER BY archived_at DESC, id`,
      )
      .all(ownerId) as TaskRow[];
    return rows.map(mapTask);
  }

  getTaskForUser(taskId: string, ownerId: string): TaskRecord | null {
    const row = this.sqlite
      .prepare("SELECT * FROM tasks WHERE id = ? AND owner_id = ?")
      .get(taskId, ownerId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  getComposerState(threadId: string, ownerId: string): ComposerState | null {
    const row = this.sqlite
      .prepare(
        `SELECT plan_mode, composer_revision
         FROM tasks
         WHERE id = ? AND owner_id = ? AND lifecycle_state IN ('DRAFT', 'ACTIVE')
           AND archived_at IS NULL`,
      )
      .get(threadId, ownerId) as { plan_mode: number; composer_revision: number } | undefined;
    return row ? { planMode: row.plan_mode === 1, revision: row.composer_revision } : null;
  }

  patchComposerState(input: {
    threadId: string;
    ownerId: string;
    planMode: boolean;
    expectedRevision: number;
    now: Date;
  }): ComposerState {
    return this.immediateTransaction(() => {
      const task = this.sqlite
        .prepare(
          `SELECT plan_mode, composer_revision
           FROM tasks
           WHERE id = ? AND owner_id = ? AND lifecycle_state IN ('DRAFT', 'ACTIVE')
             AND archived_at IS NULL`,
        )
        .get(input.threadId, input.ownerId) as
        | { plan_mode: number; composer_revision: number }
        | undefined;
      if (!task) throw new Error("Thread not found");
      if (task.composer_revision !== input.expectedRevision) {
        throw new ComposerRevisionConflictError();
      }
      const pending = this.sqlite
        .prepare(
          `SELECT status FROM turns
           WHERE task_id = ?
             AND status IN ('ALLOCATING', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL')
           ORDER BY started_at DESC, rowid DESC LIMIT 1`,
        )
        .get(input.threadId) as
        | {
            status: "ALLOCATING" | "QUEUED" | "RUNNING" | "WAITING_APPROVAL";
          }
        | undefined;
      if (pending) throw new PlanModeMutationBlockedError(pending.status);
      const nextRevision = task.composer_revision + 1;
      const updated = this.sqlite
        .prepare(
          `UPDATE tasks
           SET plan_mode = ?, composer_revision = ?, updated_at = ?
           WHERE id = ? AND owner_id = ? AND composer_revision = ?`,
        )
        .run(
          input.planMode ? 1 : 0,
          nextRevision,
          input.now.getTime(),
          input.threadId,
          input.ownerId,
          input.expectedRevision,
        );
      if (updated.changes !== 1) throw new ComposerRevisionConflictError();
      return { planMode: input.planMode, revision: nextRevision };
    });
  }

  activateDraft(threadId: string, ownerId: string, now: Date): TaskRecord {
    const result = this.sqlite
      .prepare(
        `UPDATE tasks
         SET lifecycle_state = 'ACTIVE', status = 'READY', draft_expires_at = NULL, updated_at = ?
         WHERE id = ? AND owner_id = ? AND lifecycle_state = 'DRAFT'`,
      )
      .run(now.getTime(), threadId, ownerId);
    if (result.changes !== 1) throw new Error("Thread not found");
    return this.getTaskForUser(threadId, ownerId) as TaskRecord;
  }

  deleteDraft(threadId: string, ownerId: string, now = new Date()): { attachmentRefs: string[] } {
    return this.immediateTransaction(() => {
      const draft = this.sqlite
        .prepare("SELECT id FROM tasks WHERE id = ? AND owner_id = ? AND lifecycle_state = 'DRAFT'")
        .get(threadId, ownerId);
      if (!draft) throw new Error("Thread not found");
      const attachments = this.attachmentRefs(threadId);
      this.enqueueAttachmentCleanupJobs(threadId, attachments, now);
      this.sqlite.prepare("DELETE FROM tasks WHERE id = ?").run(threadId);
      return { attachmentRefs: attachments.map((attachment) => attachment.relativePath) };
    });
  }

  expireDrafts(now: Date): Array<{ threadId: string; attachmentRefs: string[] }> {
    return this.immediateTransaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT id FROM tasks
           WHERE lifecycle_state = 'DRAFT' AND draft_expires_at IS NOT NULL AND draft_expires_at <= ?`,
        )
        .all(now.getTime()) as Array<{ id: string }>;
      const expired = rows.map(({ id }) => {
        const attachments = this.attachmentRefs(id);
        this.enqueueAttachmentCleanupJobs(id, attachments, now);
        return {
          threadId: id,
          attachmentRefs: attachments.map((attachment) => attachment.relativePath),
        };
      });
      for (const { id } of rows) {
        this.sqlite.prepare("UPDATE tasks SET lifecycle_state = 'EXPIRED' WHERE id = ?").run(id);
        this.sqlite.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      }
      return expired;
    });
  }

  createAttachment(input: {
    id: string;
    threadId: string;
    ownerId: string;
    kind: "FILE" | "FOLDER";
    name: string;
    relativePath: string;
    mimeType: string;
    sizeBytes: number;
    fileCount: number;
    scanStatus: DraftAttachment["scanStatus"];
    blockedReason?: string | null;
    now: Date;
  }): DraftAttachment {
    return this.immediateTransaction(() => {
      const task = this.sqlite
        .prepare(
          "SELECT 1 FROM tasks WHERE id = ? AND owner_id = ? AND lifecycle_state != 'EXPIRED'",
        )
        .get(input.threadId, input.ownerId);
      if (!task) throw new Error("Thread not found");
      if (input.fileCount > MAX_FOLDER_FILES) throw new Error("Folder exceeds the 500 file limit");
      const aggregate = this.sqlite
        .prepare(
          `SELECT COUNT(*) AS roots, COALESCE(SUM(size_bytes), 0) AS bytes
           FROM draft_attachments WHERE task_id = ? AND claimed_turn_id IS NULL`,
        )
        .get(input.threadId) as { roots: number; bytes: number };
      if (aggregate.roots >= MAX_ATTACHMENT_ROOTS)
        throw new Error("Attachment root limit exceeded");
      if (aggregate.bytes + input.sizeBytes > MAX_TURN_ATTACHMENT_BYTES) {
        throw new Error("Attachments exceed the 200 MiB Turn limit");
      }
      this.sqlite
        .prepare(
          `INSERT INTO draft_attachments (
            id, task_id, owner_id, kind, name, relative_path, mime_type, size_bytes, file_count,
            scan_status, blocked_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.threadId,
          input.ownerId,
          input.kind,
          input.name,
          input.relativePath,
          input.mimeType,
          input.sizeBytes,
          input.fileCount,
          input.scanStatus,
          input.blockedReason ?? null,
          input.now.getTime(),
          input.now.getTime(),
        );
      return this.getAttachment(input.id, input.threadId, input.ownerId) as DraftAttachment;
    });
  }

  getAttachment(attachmentId: string, threadId: string, ownerId: string): DraftAttachment | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM draft_attachments
         WHERE id = ? AND task_id = ? AND owner_id = ?`,
      )
      .get(attachmentId, threadId, ownerId) as AttachmentRow | undefined;
    return row ? mapAttachment(row) : null;
  }

  getReadyAttachments(
    threadId: string,
    ownerId: string,
    attachmentIds: string[],
  ): DraftAttachment[] {
    if (attachmentIds.length === 0) return [];
    const placeholders = attachmentIds.map(() => "?").join(",");
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM draft_attachments
         WHERE task_id = ? AND owner_id = ? AND scan_status = 'READY'
           AND id IN (${placeholders})`,
      )
      .all(threadId, ownerId, ...attachmentIds) as AttachmentRow[];
    const byId = new Map(rows.map((row) => [row.id, mapAttachment(row)]));
    return attachmentIds.flatMap((id) => {
      const attachment = byId.get(id);
      return attachment ? [attachment] : [];
    });
  }

  deleteAttachment(
    attachmentId: string,
    threadId: string,
    ownerId: string,
    now = new Date(),
  ): string {
    return this.immediateTransaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT relative_path, claimed_turn_id FROM draft_attachments
           WHERE id = ? AND task_id = ? AND owner_id = ?`,
        )
        .get(attachmentId, threadId, ownerId) as
        | { relative_path: string; claimed_turn_id: string | null }
        | undefined;
      if (!row) throw new Error("Attachment not found");
      if (row.claimed_turn_id) throw new Error("Attachment is already claimed by a Turn");
      this.enqueueAttachmentCleanupJobs(
        threadId,
        [{ id: attachmentId, relativePath: row.relative_path }],
        now,
      );
      this.sqlite.prepare("DELETE FROM draft_attachments WHERE id = ?").run(attachmentId);
      return row.relative_path;
    });
  }

  archiveThread(input: { threadId: string; ownerId: string; now: Date }): TaskRecord {
    return this.immediateTransaction(() => {
      const row = this.sqlite
        .prepare("SELECT * FROM tasks WHERE id = ? AND owner_id = ?")
        .get(input.threadId, input.ownerId) as TaskRow | undefined;
      if (row?.lifecycle_state !== "ACTIVE") throw new Error("Thread not found");
      if (row.archived_at !== null) return mapTask(row);

      const activeTurn = this.sqlite
        .prepare(
          `SELECT 1 FROM turns
           WHERE task_id = ?
             AND status IN ('ALLOCATING', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL')
           LIMIT 1`,
        )
        .get(input.threadId);
      if (activeTurn || ["QUEUED", "RUNNING", "WAITING_APPROVAL"].includes(row.status)) {
        throw new Error("Thread has active work and cannot be archived");
      }

      this.sqlite
        .prepare("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
        .run(input.now.getTime(), input.now.getTime(), input.threadId);
      this.insertAudit({
        actorUserId: input.ownerId,
        taskId: input.threadId,
        threadId: row.thread_id,
        action: "THREAD_ARCHIVED",
        outcome: "SUCCESS",
        summary: "Thread archived in CodexPlatform",
        now: input.now,
      });
      return this.getTaskForUser(input.threadId, input.ownerId) as TaskRecord;
    });
  }

  unarchiveThread(input: { threadId: string; ownerId: string; now: Date }): TaskRecord {
    return this.immediateTransaction(() => {
      const row = this.sqlite
        .prepare("SELECT * FROM tasks WHERE id = ? AND owner_id = ?")
        .get(input.threadId, input.ownerId) as TaskRow | undefined;
      if (row?.lifecycle_state !== "ACTIVE") throw new Error("Thread not found");
      if (row.archived_at === null) return mapTask(row);

      this.sqlite
        .prepare("UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?")
        .run(input.now.getTime(), input.threadId);
      this.insertAudit({
        actorUserId: input.ownerId,
        taskId: input.threadId,
        threadId: row.thread_id,
        action: "THREAD_UNARCHIVED",
        outcome: "SUCCESS",
        summary: "Thread unarchived in CodexPlatform",
        now: input.now,
      });
      return this.getTaskForUser(input.threadId, input.ownerId) as TaskRecord;
    });
  }

  getTaskOwnerId(taskId: string): string | null {
    const row = this.sqlite.prepare("SELECT owner_id FROM tasks WHERE id = ?").get(taskId) as
      | { owner_id: string }
      | undefined;
    return row?.owner_id ?? null;
  }

  getUserIdentity(userId: string): { tenantKey: string; userId: string; role: "ADMIN" | "MEMBER" } {
    const row = this.sqlite
      .prepare("SELECT tenant_key, role FROM users WHERE id = ?")
      .get(userId) as { tenant_key: string; role: "ADMIN" | "MEMBER" } | undefined;
    if (!row) throw new Error("User not found");
    return { tenantKey: row.tenant_key, userId, role: row.role };
  }

  createTurn(input: {
    id: string;
    taskId: string;
    ownerId: string;
    prompt: string;
    status: "ALLOCATING" | "QUEUED";
    configSnapshot?: EffectiveThreadConfigSnapshot;
    attachmentIds?: string[];
    now: Date;
  }): TurnRecord {
    this.immediateTransaction(() => {
      const task = this.sqlite
        .prepare("SELECT owner_id, lifecycle_state, plan_mode FROM tasks WHERE id = ?")
        .get(input.taskId) as
        | {
            owner_id: string;
            lifecycle_state: "DRAFT" | "ACTIVE" | "EXPIRED";
            plan_mode: number;
          }
        | undefined;
      if (!task || task.owner_id !== input.ownerId) throw new Error("Task not found");
      const attachmentIds = [...new Set(input.attachmentIds ?? [])];
      if (input.prompt.trim().length === 0 && attachmentIds.length === 0) {
        throw new Error("Invalid Turn input");
      }
      if (attachmentIds.length > MAX_ATTACHMENT_ROOTS)
        throw new Error("Attachment root limit exceeded");
      const attachments = this.getReadyAttachments(input.taskId, input.ownerId, attachmentIds);
      if (attachments.length !== attachmentIds.length) {
        throw new Error("Attachments must exist, be owned, unclaimed, and READY");
      }
      const claimedCount =
        attachmentIds.length === 0
          ? 0
          : (
              this.sqlite
                .prepare(
                  `SELECT COUNT(*) AS count FROM draft_attachments
                 WHERE task_id = ? AND owner_id = ? AND claimed_turn_id IS NULL
                   AND id IN (${attachmentIds.map(() => "?").join(",")})`,
                )
                .get(input.taskId, input.ownerId, ...attachmentIds) as { count: number }
            ).count;
      if (claimedCount !== attachmentIds.length) {
        throw new Error("Attachments must exist, be owned, unclaimed, and READY");
      }
      const active = this.sqlite
        .prepare(
          `SELECT 1 FROM turns
           WHERE task_id = ? AND status IN ('ALLOCATING', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL')
           LIMIT 1`,
        )
        .get(input.taskId);
      if (active) throw new Error("Task already has an active Turn");
      const goal = this.readThreadGoalSnapshot(input.taskId, input.ownerId);
      if (goal && goal.status !== "ACTIVE") {
        throw new Error(`Goal status ${goal.status} does not accept new Turns`);
      }
      this.sqlite
        .prepare(
          `INSERT INTO turns (
            id, task_id, prompt, status, config_snapshot_json, started_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.taskId,
          input.prompt,
          input.status,
          JSON.stringify(
            EffectiveThreadConfigSnapshotSchema.parse(
              input.configSnapshot ?? DEFAULT_EFFECTIVE_CONFIG_SNAPSHOT,
            ),
          ),
          input.now.getTime(),
        );
      this.sqlite
        .prepare(
          `INSERT INTO turn_input_snapshots (
            turn_id, prompt, attachments_json, goal_json, plan_mode, captured_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.prompt,
          JSON.stringify(attachments),
          goal ? JSON.stringify(goal) : null,
          task.plan_mode,
          input.now.getTime(),
        );
      if (attachmentIds.length > 0) {
        this.sqlite
          .prepare(
            `UPDATE draft_attachments SET claimed_turn_id = ?, updated_at = ?
             WHERE id IN (${attachmentIds.map(() => "?").join(",")})`,
          )
          .run(input.id, input.now.getTime(), ...attachmentIds);
      }
      if (task.lifecycle_state === "DRAFT") {
        this.sqlite
          .prepare(
            `UPDATE tasks SET lifecycle_state = 'ACTIVE', status = 'READY',
             draft_expires_at = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(input.now.getTime(), input.taskId);
      }
    });
    return this.getTurn(input.id) as TurnRecord;
  }

  getTurnInputSnapshot(turnId: string): EffectiveTurnInputSnapshot | null {
    const row = this.sqlite
      .prepare("SELECT * FROM turn_input_snapshots WHERE turn_id = ?")
      .get(turnId) as
      | {
          prompt: string;
          attachments_json: string;
          goal_json: string | null;
          plan_mode: number;
          captured_at: number;
        }
      | undefined;
    return row
      ? EffectiveTurnInputSnapshotSchema.parse({
          prompt: row.prompt,
          attachments: JSON.parse(row.attachments_json),
          goal: row.goal_json ? JSON.parse(row.goal_json) : null,
          planMode: row.plan_mode === 1,
          capturedAt: new Date(row.captured_at).toISOString(),
        })
      : null;
  }

  claimSteerInput(input: {
    id: string;
    taskId: string;
    turnId: string;
    ownerId: string;
    prompt: string;
    attachmentIds: string[];
    now: Date;
  }): EffectiveTurnInputSnapshot {
    return this.immediateTransaction(() => {
      const task = this.sqlite
        .prepare(
          `SELECT owner_id, lifecycle_state, status FROM tasks
           WHERE id = ? AND owner_id = ?`,
        )
        .get(input.taskId, input.ownerId) as
        | {
            owner_id: string;
            lifecycle_state: "DRAFT" | "ACTIVE" | "EXPIRED";
            status: string;
          }
        | undefined;
      if (task?.lifecycle_state !== "ACTIVE") throw new Error("Task not found");
      if (!["RUNNING", "WAITING_APPROVAL"].includes(task.status)) {
        throw new Error(`Task status ${task.status} does not accept Steer`);
      }
      const activeTurn = this.sqlite
        .prepare(
          `SELECT 1 FROM turns
           WHERE id = ? AND task_id = ? AND status IN ('RUNNING', 'WAITING_APPROVAL')`,
        )
        .get(input.turnId, input.taskId);
      if (!activeTurn) throw new Error("Active Turn projection is unavailable");

      const attachmentIds = [...new Set(input.attachmentIds)];
      if (input.prompt.trim().length === 0 && attachmentIds.length === 0) {
        throw new Error("Invalid Steer input");
      }
      if (attachmentIds.length > MAX_ATTACHMENT_ROOTS) {
        throw new Error("Attachment root limit exceeded");
      }
      const attachments = this.getReadyAttachments(input.taskId, input.ownerId, attachmentIds);
      const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
      if (totalBytes > MAX_TURN_ATTACHMENT_BYTES) {
        throw new Error("Attachments exceed the 200 MiB Turn limit");
      }
      const claimableCount =
        attachmentIds.length === 0
          ? 0
          : (
              this.sqlite
                .prepare(
                  `SELECT COUNT(*) AS count FROM draft_attachments
                   WHERE task_id = ? AND owner_id = ? AND scan_status = 'READY'
                     AND claimed_turn_id IS NULL
                     AND id IN (${attachmentIds.map(() => "?").join(",")})`,
                )
                .get(input.taskId, input.ownerId, ...attachmentIds) as { count: number }
            ).count;
      if (attachments.length !== attachmentIds.length || claimableCount !== attachmentIds.length) {
        throw new Error("Attachments must exist, be owned, unclaimed, and READY");
      }

      this.sqlite
        .prepare(
          `INSERT INTO steer_input_snapshots (
            id, turn_id, prompt, attachments_json, delivery_status, captured_at
           ) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
        )
        .run(
          input.id,
          input.turnId,
          input.prompt,
          JSON.stringify(attachments),
          input.now.getTime(),
        );
      if (attachmentIds.length > 0) {
        const claimed = this.sqlite
          .prepare(
            `UPDATE draft_attachments SET claimed_turn_id = ?, updated_at = ?
             WHERE claimed_turn_id IS NULL
               AND id IN (${attachmentIds.map(() => "?").join(",")})`,
          )
          .run(input.turnId, input.now.getTime(), ...attachmentIds);
        if (claimed.changes !== attachmentIds.length) {
          throw new Error("Attachments must exist, be owned, unclaimed, and READY");
        }
      }
      return EffectiveTurnInputSnapshotSchema.parse({
        prompt: input.prompt,
        attachments,
        goal: this.readThreadGoalSnapshot(input.taskId, input.ownerId),
        planMode: this.getTurnInputSnapshot(input.turnId)?.planMode ?? false,
        capturedAt: input.now.toISOString(),
      });
    });
  }

  getThreadGoal(threadId: string, ownerId: string): StoredThreadGoalView | null {
    this.requireOwnedGoalThread(threadId, ownerId);
    const row = this.sqlite
      .prepare("SELECT * FROM thread_goals WHERE task_id = ? AND owner_id = ?")
      .get(threadId, ownerId) as ThreadGoalRow | undefined;
    return row && row.deleted_at === null ? mapThreadGoal(row) : null;
  }

  putThreadGoal(input: {
    threadId: string;
    ownerId: string;
    objective: string;
    tokenBudget: number;
    timeBudgetSeconds: number;
    now: Date;
  }): StoredThreadGoalView {
    return this.immediateTransaction(() => {
      this.requireOwnedGoalThread(input.threadId, input.ownerId);
      this.assertNoPendingGoalTurn(input.threadId, input.ownerId);
      this.sqlite
        .prepare(
          `INSERT INTO thread_goals (
            task_id, owner_id, objective, status, token_budget, tokens_used,
            time_budget_seconds, time_used_seconds, runtime_sync_state,
            activated_at, revision, deleted_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'ACTIVE', ?, 0, ?, 0, 'PENDING', ?, 1, NULL, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             objective = excluded.objective,
             status = 'ACTIVE',
             token_budget = excluded.token_budget,
             tokens_used = 0,
             time_budget_seconds = excluded.time_budget_seconds,
             time_used_seconds = 0,
             runtime_sync_state = 'PENDING',
             runtime_thread_id = NULL,
             runtime_updated_at = NULL,
             activated_at = excluded.activated_at,
             revision = thread_goals.revision + 1,
             deleted_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.threadId,
          input.ownerId,
          input.objective,
          input.tokenBudget,
          input.timeBudgetSeconds,
          input.now.getTime(),
          input.now.getTime(),
          input.now.getTime(),
        );
      return this.getThreadGoal(input.threadId, input.ownerId) as StoredThreadGoalView;
    });
  }

  patchThreadGoal(input: {
    threadId: string;
    ownerId: string;
    patch: ThreadGoalPatch;
    now: Date;
  }): StoredThreadGoalView {
    const patch = ThreadGoalPatchSchema.parse(input.patch);
    return this.immediateTransaction(() => {
      const current = this.getThreadGoal(input.threadId, input.ownerId);
      if (!current) throw new Error("Goal not found");
      this.assertNoPendingGoalTurn(input.threadId, input.ownerId);
      const status =
        patch.action === "PAUSE"
          ? "PAUSED"
          : patch.action === "RESUME"
            ? "ACTIVE"
            : patch.action === "COMPLETE"
              ? "COMPLETE"
              : current.status;
      this.sqlite
        .prepare(
          `UPDATE thread_goals SET
             objective = ?, status = ?, token_budget = ?, time_budget_seconds = ?,
             time_used_seconds = MIN(time_budget_seconds,
               time_used_seconds + CASE
                 WHEN status = 'ACTIVE' AND activated_at IS NOT NULL
                   THEN MAX(0, CAST((? - activated_at) / 1000 AS INTEGER))
                 ELSE 0
               END),
             runtime_sync_state = 'PENDING', activated_at = ?,
             revision = revision + 1, updated_at = ?
           WHERE task_id = ? AND owner_id = ?`,
        )
        .run(
          patch.objective ?? current.objective,
          status,
          patch.tokenBudget ?? current.tokenBudget,
          patch.timeBudgetSeconds ?? current.timeBudgetSeconds,
          input.now.getTime(),
          status === "ACTIVE" ? input.now.getTime() : null,
          input.now.getTime(),
          input.threadId,
          input.ownerId,
        );
      return this.getThreadGoal(input.threadId, input.ownerId) as StoredThreadGoalView;
    });
  }

  deleteThreadGoal(threadId: string, ownerId: string): boolean {
    return this.deleteThreadGoalMutation(threadId, ownerId, new Date()).deleted;
  }

  deleteThreadGoalMutation(
    threadId: string,
    ownerId: string,
    now: Date,
  ): { deleted: boolean; revision: number } {
    return this.immediateTransaction(() => {
      this.requireOwnedGoalThread(threadId, ownerId);
      this.assertNoPendingGoalTurn(threadId, ownerId);
      const result = this.sqlite
        .prepare(
          `UPDATE thread_goals
           SET deleted_at = ?, runtime_sync_state = 'PENDING',
               revision = revision + 1, updated_at = ?
           WHERE task_id = ? AND owner_id = ? AND deleted_at IS NULL
           RETURNING revision`,
        )
        .get(now.getTime(), now.getTime(), threadId, ownerId) as { revision: number } | undefined;
      return { deleted: Boolean(result), revision: result?.revision ?? 0 };
    });
  }

  finalizeThreadGoalDelete(input: {
    threadId: string;
    ownerId: string;
    expectedRevision: number;
    runtimeSyncState: "PENDING" | "SYNCED";
    now: Date;
  }): void {
    const result = this.sqlite
      .prepare(
        `UPDATE thread_goals SET runtime_sync_state = ?, updated_at = ?
         WHERE task_id = ? AND owner_id = ? AND revision = ? AND deleted_at IS NOT NULL`,
      )
      .run(
        input.runtimeSyncState,
        input.now.getTime(),
        input.threadId,
        input.ownerId,
        input.expectedRevision,
      );
    if (result.changes !== 1) throw new GoalMutationSupersededError();
  }

  syncThreadGoal(input: {
    threadId: string;
    ownerId: string;
    runtimeThreadId: string;
    status: ThreadGoalView["status"];
    tokensUsed: number;
    timeUsedSeconds: number;
    runtimeUpdatedAt?: number;
    expectedRevision?: number;
    source?: "COMMAND" | "NOTIFICATION";
    now: Date;
  }): StoredThreadGoalView {
    const current = this.getThreadGoal(input.threadId, input.ownerId);
    if (!current) throw new Error("Goal not found");
    const runtimeUpdatedAt = input.runtimeUpdatedAt ?? input.now.getTime();
    const result = this.sqlite
      .prepare(
        `UPDATE thread_goals SET
         status = CASE
           WHEN status IN ('COMPLETE', 'BUDGET_LIMITED', 'NEEDS_RECOVERY') THEN status
           ELSE ?
         END,
         tokens_used = MAX(tokens_used, ?),
         time_used_seconds = MAX(time_used_seconds, ?),
         runtime_sync_state = CASE
           WHEN runtime_sync_state = 'NEEDS_RECOVERY' THEN 'NEEDS_RECOVERY'
           ELSE 'SYNCED'
         END,
         runtime_thread_id = ?,
         runtime_updated_at = ?,
         activated_at = CASE
           WHEN status IN ('COMPLETE', 'BUDGET_LIMITED', 'NEEDS_RECOVERY') THEN NULL
           WHEN ? = 'ACTIVE' THEN ?
           ELSE NULL
         END,
         updated_at = ?
         WHERE task_id = ? AND owner_id = ? AND deleted_at IS NULL
           AND (? IS NULL OR revision = ?)
           AND (
             runtime_updated_at IS NULL OR
             ? > runtime_updated_at OR
             (? = 'COMMAND' AND runtime_sync_state = 'PENDING' AND ? >= runtime_updated_at)
           )`,
      )
      .run(
        input.status,
        input.tokensUsed,
        input.timeUsedSeconds,
        input.runtimeThreadId,
        runtimeUpdatedAt,
        input.status,
        input.now.getTime(),
        input.now.getTime(),
        input.threadId,
        input.ownerId,
        input.expectedRevision ?? null,
        input.expectedRevision ?? null,
        runtimeUpdatedAt,
        input.source ?? "NOTIFICATION",
        runtimeUpdatedAt,
      );
    if (result.changes === 0) {
      if (input.expectedRevision !== undefined) throw new GoalMutationSupersededError();
      return current;
    }
    return this.getThreadGoal(input.threadId, input.ownerId) as StoredThreadGoalView;
  }

  updateThreadGoalTokens(
    threadId: string,
    ownerId: string,
    tokensUsed: number,
    now: Date,
  ): ThreadGoalTokenUpdate | null {
    return this.immediateTransaction(() => {
      const before = this.getThreadGoal(threadId, ownerId);
      if (!before) return null;
      this.sqlite
        .prepare(
          `UPDATE thread_goals SET
           tokens_used = MAX(tokens_used, ?),
           status = CASE
             WHEN status = 'ACTIVE' AND MAX(tokens_used, ?) >= token_budget
               THEN 'BUDGET_LIMITED'
             ELSE status
           END,
           activated_at = CASE
             WHEN status = 'ACTIVE' AND MAX(tokens_used, ?) >= token_budget THEN NULL
             ELSE activated_at
           END,
           runtime_sync_state = CASE
             WHEN status = 'ACTIVE' AND MAX(tokens_used, ?) >= token_budget THEN 'PENDING'
             ELSE runtime_sync_state
           END,
           updated_at = ?
         WHERE task_id = ? AND owner_id = ? AND deleted_at IS NULL`,
        )
        .run(tokensUsed, tokensUsed, tokensUsed, tokensUsed, now.getTime(), threadId, ownerId);
      const goal = this.getThreadGoal(threadId, ownerId);
      if (!goal) return null;
      return {
        triggered: before.status === "ACTIVE" && goal.status === "BUDGET_LIMITED",
        goal,
      };
    });
  }

  markThreadGoalRecovery(threadId: string, ownerId: string, now: Date): void {
    this.sqlite
      .prepare(
        `UPDATE thread_goals SET status = 'NEEDS_RECOVERY',
         runtime_sync_state = 'NEEDS_RECOVERY', activated_at = NULL,
         deleted_at = NULL, updated_at = ?
         WHERE task_id = ? AND owner_id = ?`,
      )
      .run(now.getTime(), threadId, ownerId);
  }

  applyGoalWatchdog(now: Date): ThreadGoalBudgetTransition[] {
    return this.immediateTransaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT task_id, owner_id FROM thread_goals
           WHERE deleted_at IS NULL AND status = 'ACTIVE' AND (
             tokens_used >= token_budget OR
             (activated_at IS NOT NULL AND time_used_seconds + CAST((? - activated_at) / 1000 AS INTEGER) >= time_budget_seconds)
           )`,
        )
        .all(now.getTime()) as Array<{ task_id: string; owner_id: string }>;
      const transitioned: ThreadGoalBudgetTransition[] = [];
      for (const row of rows) {
        const result = this.sqlite
          .prepare(
            `UPDATE thread_goals SET status = 'BUDGET_LIMITED',
             runtime_sync_state = 'PENDING',
             time_used_seconds = MIN(time_budget_seconds,
               time_used_seconds + CASE WHEN activated_at IS NULL THEN 0
               ELSE CAST((? - activated_at) / 1000 AS INTEGER) END),
             activated_at = NULL, updated_at = ?
             WHERE task_id = ? AND owner_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'`,
          )
          .run(now.getTime(), now.getTime(), row.task_id, row.owner_id);
        if (result.changes !== 1) continue;
        const goal = this.getThreadGoal(row.task_id, row.owner_id);
        if (goal) transitioned.push({ ownerId: row.owner_id, goal });
      }
      return transitioned;
    });
  }

  recoverPersistedRuntimeGoals(now: Date): RecoveredPersistedGoal[] {
    return this.immediateTransaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT tg.task_id, tg.owner_id, tg.runtime_thread_id
           FROM thread_goals tg
           JOIN tasks t ON t.id = tg.task_id AND t.owner_id = tg.owner_id
           WHERE tg.deleted_at IS NULL
             AND tg.runtime_thread_id IS NOT NULL
             AND tg.status IN ('ACTIVE', 'PAUSED', 'BUDGET_LIMITED')
             AND t.lifecycle_state = 'ACTIVE'
           ORDER BY tg.updated_at, tg.task_id`,
        )
        .all() as Array<{
        task_id: string;
        owner_id: string;
        runtime_thread_id: string;
      }>;
      const recovered: RecoveredPersistedGoal[] = [];
      const recoverGoal = this.sqlite.prepare(
        `UPDATE thread_goals
         SET status = 'NEEDS_RECOVERY', runtime_sync_state = 'NEEDS_RECOVERY',
             activated_at = NULL, updated_at = ?
         WHERE task_id = ? AND owner_id = ? AND deleted_at IS NULL
           AND status IN ('ACTIVE', 'PAUSED', 'BUDGET_LIMITED')`,
      );
      const recoverTask = this.sqlite.prepare(
        `UPDATE tasks
         SET status = 'NEEDS_RECOVERY', current_turn_id = NULL,
             queue_ticket = NULL, updated_at = ?
         WHERE id = ? AND owner_id = ? AND lifecycle_state = 'ACTIVE'`,
      );
      for (const row of rows) {
        if (recoverGoal.run(now.getTime(), row.task_id, row.owner_id).changes !== 1) continue;
        recoverTask.run(now.getTime(), row.task_id, row.owner_id);
        recovered.push({
          taskId: row.task_id,
          ownerId: row.owner_id,
          runtimeThreadId: row.runtime_thread_id,
        });
      }
      return recovered;
    });
  }

  private requireOwnedGoalThread(threadId: string, ownerId: string): void {
    const row = this.sqlite
      .prepare(
        `SELECT 1 FROM tasks
         WHERE id = ? AND owner_id = ? AND lifecycle_state != 'EXPIRED' AND archived_at IS NULL`,
      )
      .get(threadId, ownerId);
    if (!row) throw new Error("Thread not found");
  }

  private assertNoPendingGoalTurn(threadId: string, ownerId: string): void {
    const row = this.sqlite
      .prepare(
        `SELECT tr.status
         FROM turns tr
         JOIN tasks t ON t.id = tr.task_id
         WHERE tr.task_id = ? AND t.owner_id = ?
           AND tr.status IN ('ALLOCATING', 'QUEUED')
         ORDER BY tr.started_at DESC, tr.rowid DESC
         LIMIT 1`,
      )
      .get(threadId, ownerId) as { status: "ALLOCATING" | "QUEUED" } | undefined;
    if (row) throw new GoalMutationBlockedByPendingTurnError(row.status);
  }

  private readThreadGoalSnapshot(threadId: string, ownerId: string): ThreadGoalSnapshot | null {
    const row = this.sqlite
      .prepare("SELECT * FROM thread_goals WHERE task_id = ? AND owner_id = ?")
      .get(threadId, ownerId) as ThreadGoalRow | undefined;
    if (!row || row.deleted_at !== null) return null;
    const goal = mapThreadGoal(row);
    return {
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget,
      tokensUsed: goal.tokensUsed,
      timeBudgetSeconds: goal.timeBudgetSeconds,
      timeUsedSeconds: goal.timeUsedSeconds,
    };
  }

  completeSteerInputDelivery(id: string, now: Date): void {
    const result = this.sqlite
      .prepare(
        `UPDATE steer_input_snapshots
         SET delivery_status = 'DELIVERED', delivery_error = NULL,
             delivered_at = ?, failed_at = NULL, unknown_at = NULL
         WHERE id = ? AND delivery_status = 'PENDING'`,
      )
      .run(now.getTime(), id);
    if (result.changes !== 1) throw new Error("Steer input is not pending");
  }

  failSteerInputDelivery(id: string, error: string, now: Date): void {
    this.immediateTransaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT turn_id, attachments_json FROM steer_input_snapshots
           WHERE id = ? AND delivery_status = 'PENDING'`,
        )
        .get(id) as { turn_id: string; attachments_json: string } | undefined;
      if (!row) throw new Error("Steer input is not pending");
      const attachments = EffectiveTurnInputSnapshotSchema.parse({
        prompt: "",
        attachments: JSON.parse(row.attachments_json),
        capturedAt: now.toISOString(),
      }).attachments;
      this.sqlite
        .prepare(
          `UPDATE steer_input_snapshots
           SET delivery_status = 'FAILED', delivery_error = ?,
               delivered_at = NULL, failed_at = ?, unknown_at = NULL
           WHERE id = ?`,
        )
        .run(error, now.getTime(), id);
      if (attachments.length > 0) {
        this.sqlite
          .prepare(
            `UPDATE draft_attachments SET claimed_turn_id = NULL, updated_at = ?
             WHERE claimed_turn_id = ?
               AND id IN (${attachments.map(() => "?").join(",")})`,
          )
          .run(now.getTime(), row.turn_id, ...attachments.map((attachment) => attachment.id));
      }
    });
  }

  markSteerInputDeliveryUnknown(id: string, error: string, now: Date): void {
    const result = this.sqlite
      .prepare(
        `UPDATE steer_input_snapshots
         SET delivery_status = 'UNKNOWN', delivery_error = ?,
             delivered_at = NULL, failed_at = NULL, unknown_at = ?
         WHERE id = ? AND delivery_status = 'PENDING'`,
      )
      .run(error, now.getTime(), id);
    if (result.changes !== 1) throw new Error("Steer input is not pending");
  }

  listSteerInputSnapshots(turnId: string): SteerInputSnapshotRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT prompt, attachments_json, delivery_status, delivery_error,
                delivered_at, failed_at, unknown_at, captured_at
         FROM steer_input_snapshots WHERE turn_id = ? ORDER BY captured_at, rowid`,
      )
      .all(turnId) as Array<{
      prompt: string;
      attachments_json: string;
      delivery_status: "PENDING" | "DELIVERED" | "FAILED" | "UNKNOWN";
      delivery_error: string | null;
      delivered_at: number | null;
      failed_at: number | null;
      unknown_at: number | null;
      captured_at: number;
    }>;
    return rows.map((row) => ({
      ...EffectiveTurnInputSnapshotSchema.parse({
        prompt: row.prompt,
        attachments: JSON.parse(row.attachments_json),
        capturedAt: new Date(row.captured_at).toISOString(),
      }),
      deliveryStatus: row.delivery_status,
      deliveryError: row.delivery_error,
      deliveredAt: row.delivered_at === null ? null : new Date(row.delivered_at).toISOString(),
      failedAt: row.failed_at === null ? null : new Date(row.failed_at).toISOString(),
      unknownAt: row.unknown_at === null ? null : new Date(row.unknown_at).toISOString(),
    }));
  }

  listAttachmentCleanupJobs(limit = 100): AttachmentCleanupJob[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM attachment_cleanup_jobs
         WHERE status IN ('PENDING', 'FAILED')
         ORDER BY created_at, rowid
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      thread_id: string;
      attachment_id: string;
      relative_path: string;
      status: "PENDING" | "FAILED";
      attempts: number;
      last_error: string | null;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      attachmentId: row.attachment_id,
      relativePath: row.relative_path,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  completeAttachmentCleanupJob(id: string): void {
    this.sqlite.prepare("DELETE FROM attachment_cleanup_jobs WHERE id = ?").run(id);
  }

  failAttachmentCleanupJob(id: string, error: string, now: Date): void {
    this.sqlite
      .prepare(
        `UPDATE attachment_cleanup_jobs
         SET status = 'FAILED', attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(error, now.getTime(), id);
  }

  getLatestTurnPrompt(taskId: string, ownerId: string): string | null {
    const row = this.sqlite
      .prepare(
        `SELECT tr.prompt
         FROM turns tr JOIN tasks t ON t.id = tr.task_id
         WHERE tr.task_id = ? AND t.owner_id = ?
         ORDER BY tr.started_at DESC, tr.rowid DESC
         LIMIT 1`,
      )
      .get(taskId, ownerId) as { prompt: string } | undefined;
    return row?.prompt ?? null;
  }

  getTurn(id: string): TurnRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT tr.*, t.owner_id
         FROM turns tr JOIN tasks t ON t.id = tr.task_id
         WHERE tr.id = ?`,
      )
      .get(id) as TurnRow | undefined;
    return row ? mapTurn(row) : null;
  }

  getActiveTurnForTask(taskId: string, ownerId: string): TurnRecord | null {
    if (!this.getTaskForUser(taskId, ownerId)) return null;
    const row = this.sqlite
      .prepare(
        `SELECT tr.*, t.owner_id
         FROM turns tr JOIN tasks t ON t.id = tr.task_id
         WHERE tr.task_id = ?
           AND tr.status IN ('ALLOCATING', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL')
         ORDER BY tr.started_at DESC, tr.rowid DESC
         LIMIT 1`,
      )
      .get(taskId) as TurnRow | undefined;
    return row ? mapTurn(row) : null;
  }

  findPlatformTurnIdForRuntimeTurn(taskId: string, runtimeTurnId: string | null): string | null {
    if (!runtimeTurnId) return null;
    const row = this.sqlite
      .prepare(
        `SELECT id FROM turns
         WHERE task_id = ? AND codex_turn_id = ?
         ORDER BY started_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(taskId, runtimeTurnId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  resolvePlatformTurnId(taskId: string, candidateTurnId: string | null): string | null {
    if (!candidateTurnId) return null;
    const row = this.sqlite
      .prepare(
        `SELECT id FROM turns
         WHERE task_id = ? AND (id = ? OR codex_turn_id = ?)
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, started_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(taskId, candidateTurnId, candidateTurnId, candidateTurnId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  recoverAccountRuntimeState(accountId: string, now: Date): RecoveredAccountTask[] {
    return this.immediateTransaction(() => {
      const account = this.sqlite
        .prepare("SELECT id FROM codex_accounts WHERE id = ?")
        .get(accountId);
      if (!account) throw new Error(`Unknown Codex account: ${accountId}`);
      const rows = this.sqlite
        .prepare(
          `SELECT t.id AS task_id, t.owner_id, t.thread_id, t.current_turn_id,
                  COALESCE(
                    (
                      SELECT tr.id
                      FROM turns tr
                      WHERE tr.task_id = t.id
                        AND tr.codex_turn_id = t.current_turn_id
                      ORDER BY tr.started_at DESC, tr.rowid DESC
                      LIMIT 1
                    ),
                    (
                      SELECT uts.turn_id
                      FROM user_turn_slots uts
                      WHERE uts.account_id = ? AND uts.task_id = t.id
                      ORDER BY uts.slot_index
                      LIMIT 1
                    )
                  ) AS platform_turn_id
           FROM tasks t
           WHERE t.account_id = ?
             AND (
               t.status IN ('RUNNING', 'WAITING_APPROVAL')
               OR EXISTS (
                 SELECT 1 FROM user_turn_slots uts
                 WHERE uts.account_id = ? AND uts.task_id = t.id
               )
               OR EXISTS (
                 SELECT 1 FROM thread_goals tg
                 WHERE tg.task_id = t.id AND tg.deleted_at IS NULL
                   AND tg.status IN ('ACTIVE', 'PAUSED')
               )
             )
           ORDER BY t.created_at, t.id`,
        )
        .all(accountId, accountId, accountId) as Array<{
        task_id: string;
        owner_id: string;
        thread_id: string | null;
        current_turn_id: string | null;
        platform_turn_id: string | null;
      }>;

      this.sqlite
        .prepare("UPDATE codex_accounts SET status = 'QUARANTINED' WHERE id = ?")
        .run(accountId);
      this.sqlite
        .prepare(
          `UPDATE approvals
           SET status = 'RECOVERY_REQUIRED'
           WHERE transport_account_id = ?
             AND status IN ('PENDING', 'DELIVERY_PENDING')`,
        )
        .run(accountId);
      this.sqlite
        .prepare(
          `UPDATE turns
           SET status = 'NEEDS_RECOVERY', completed_at = ?,
               duration_ms = MAX(0, ? - started_at)
           WHERE id IN (
             SELECT uts.turn_id FROM user_turn_slots uts WHERE uts.account_id = ?
           )
              OR (
                task_id IN (
                  SELECT id FROM tasks
                  WHERE account_id = ? AND status IN ('RUNNING', 'WAITING_APPROVAL')
                )
                AND status IN ('ALLOCATING', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL')
              )`,
        )
        .run(now.getTime(), now.getTime(), accountId, accountId);
      const recoverGoal = this.sqlite.prepare(
        `UPDATE thread_goals
         SET status = 'NEEDS_RECOVERY', runtime_sync_state = 'NEEDS_RECOVERY',
             activated_at = NULL, deleted_at = NULL, updated_at = ?
         WHERE task_id = ? AND owner_id = ? AND status IN ('ACTIVE', 'PAUSED')`,
      );
      for (const row of rows) {
        recoverGoal.run(now.getTime(), row.task_id, row.owner_id);
      }
      this.sqlite
        .prepare(
          `UPDATE tasks
           SET status = 'NEEDS_RECOVERY', current_turn_id = NULL,
               queue_ticket = NULL, updated_at = ?
           WHERE account_id = ?
             AND (
               status IN ('RUNNING', 'WAITING_APPROVAL')
               OR id IN (
                 SELECT task_id FROM user_turn_slots WHERE account_id = ?
               )
               OR id IN (
                 SELECT tg.task_id
                 FROM thread_goals tg
                 WHERE tg.deleted_at IS NULL AND tg.status = 'NEEDS_RECOVERY'
               )
             )`,
        )
        .run(now.getTime(), accountId, accountId);
      this.sqlite.prepare("DELETE FROM user_turn_slots WHERE account_id = ?").run(accountId);
      this.sqlite
        .prepare(
          `UPDATE account_leases SET last_heartbeat_at = ?
           WHERE account_id = ? AND status = 'ACTIVE'`,
        )
        .run(now.getTime(), accountId);
      this.sqlite
        .prepare(
          `UPDATE account_slots SET last_activity_at = ?
           WHERE account_id = ? AND user_id IS NOT NULL`,
        )
        .run(now.getTime(), accountId);

      return rows.map((row) => ({
        taskId: row.task_id,
        ownerId: row.owner_id,
        runtimeThreadId: row.thread_id,
        runtimeTurnId: row.current_turn_id,
        platformTurnId: row.platform_turn_id,
      }));
    });
  }

  listActiveTasksForAccount(accountId: string): TaskRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM tasks
         WHERE account_id = ? AND status IN ('RUNNING', 'WAITING_APPROVAL')
         ORDER BY updated_at, id`,
      )
      .all(accountId) as TaskRow[];
    return rows.map(mapTask);
  }

  listTurnsForTask(taskId: string, ownerId: string): TurnRecord[] | null {
    if (!this.getTaskForUser(taskId, ownerId)) return null;
    const rows = this.sqlite
      .prepare(
        `SELECT tr.*, t.owner_id
         FROM turns tr JOIN tasks t ON t.id = tr.task_id
         WHERE tr.task_id = ?
         ORDER BY tr.started_at, tr.rowid`,
      )
      .all(taskId) as TurnRow[];
    return rows.map(mapTurn);
  }

  listRecoverableTurnIds(taskId: string, ownerId: string): string[] {
    if (!this.getTaskForUser(taskId, ownerId)) return [];
    const rows = this.sqlite
      .prepare(
        `SELECT id FROM turns
         WHERE task_id = ? AND status = 'NEEDS_RECOVERY'
         ORDER BY started_at, id`,
      )
      .all(taskId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  setTurnStatus(id: string, status: string): void {
    const result = this.sqlite.prepare("UPDATE turns SET status = ? WHERE id = ?").run(status, id);
    if (result.changes !== 1) throw new Error("Turn not found");
  }

  updateTurnConfigSnapshot(id: string, config: EffectiveThreadConfigSnapshot): void {
    const result = this.sqlite
      .prepare(
        `UPDATE turns
         SET config_snapshot_json = ?
         WHERE id = ? AND status IN ('ALLOCATING', 'QUEUED')`,
      )
      .run(JSON.stringify(EffectiveThreadConfigSnapshotSchema.parse(config)), id);
    if (result.changes !== 1) {
      throw new Error("Turn config can only be finalized before Runtime start");
    }
  }

  bindTurnRuntime(id: string, codexTurnId: string, now: Date): void {
    const result = this.sqlite
      .prepare(
        `UPDATE turns
         SET codex_turn_id = ?, status = 'RUNNING', started_at = ?
         WHERE id = ?`,
      )
      .run(codexTurnId, now.getTime(), id);
    if (result.changes !== 1) throw new Error("Turn not found");
  }

  completeTurn(id: string, status: string, now: Date): number | null {
    const turn = this.getTurn(id);
    if (!turn) return null;
    const durationMs = Math.max(0, now.getTime() - new Date(turn.startedAt).getTime());
    this.sqlite
      .prepare(
        `UPDATE turns
         SET status = ?, completed_at = ?, duration_ms = ?
         WHERE id = ?`,
      )
      .run(status, now.getTime(), durationMs, id);
    return durationMs;
  }

  bindTaskRuntime(
    taskId: string,
    input: {
      accountId: string;
      accountAlias: string;
      leaseId: string;
      threadId: string;
      now: Date;
    },
  ): void {
    this.immediateTransaction(() => {
      const task = this.getTaskRow(taskId);
      this.sqlite
        .prepare(
          `UPDATE tasks SET account_id = ?, account_alias = ?, lease_id = ?, thread_id = ?,
             status = 'RUNNING', updated_at = ? WHERE id = ?`,
        )
        .run(
          input.accountId,
          input.accountAlias,
          input.leaseId,
          input.threadId,
          input.now.getTime(),
          taskId,
        );
      this.insertAudit({
        actorUserId: task.owner_id,
        accountId: input.accountId,
        accountAlias: input.accountAlias,
        leaseId: input.leaseId,
        taskId,
        threadId: input.threadId,
        action: "LEASE_ACQUIRED",
        outcome: "SUCCESS",
        summary: "Codex account lease acquired",
        now: input.now,
      });
    });
  }

  setTaskQueued(taskId: string, ticket: number, now: Date): void {
    this.sqlite
      .prepare("UPDATE tasks SET status = 'QUEUED', queue_ticket = ?, updated_at = ? WHERE id = ?")
      .run(ticket, now.getTime(), taskId);
  }

  setCurrentTurn(taskId: string, turnId: string, status: string, now: Date): void {
    this.sqlite
      .prepare("UPDATE tasks SET current_turn_id = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(turnId, status, now.getTime(), taskId);
  }

  setTaskInactive(
    taskId: string,
    status: "COMPLETED" | "FAILED" | "INTERRUPTED" | "NEEDS_RECOVERY",
    now: Date,
  ): void {
    const result = this.sqlite
      .prepare(
        `UPDATE tasks
         SET current_turn_id = NULL, queue_ticket = NULL, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, now.getTime(), taskId);
    if (result.changes !== 1) throw new Error("Task not found");
  }

  setTaskInactiveIfCurrent(
    taskId: string,
    turnId: string,
    status: "COMPLETED" | "FAILED" | "INTERRUPTED" | "NEEDS_RECOVERY",
    now: Date,
  ): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE tasks
         SET current_turn_id = NULL, queue_ticket = NULL, status = ?, updated_at = ?
         WHERE id = ? AND current_turn_id = ?`,
      )
      .run(status, now.getTime(), taskId, turnId);
    return result.changes === 1;
  }

  setTaskWaitingApprovalIfCurrent(taskId: string, turnId: string, now: Date): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE tasks
         SET status = 'WAITING_APPROVAL', updated_at = ?
         WHERE id = ? AND current_turn_id = ?
           AND status IN ('RUNNING', 'WAITING_APPROVAL')`,
      )
      .run(now.getTime(), taskId, turnId);
    return result.changes === 1;
  }

  setTaskRunningIfCurrentAndUnblocked(taskId: string, turnId: string, now: Date): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE tasks
         SET status = 'RUNNING', updated_at = ?
         WHERE id = ? AND current_turn_id = ?
           AND status = 'WAITING_APPROVAL'
           AND NOT EXISTS (
             SELECT 1 FROM approvals a
             WHERE a.task_id = ?
               AND (a.turn_id = ? OR a.parent_turn_id = ?)
               AND a.status IN ('PENDING', 'DELIVERY_PENDING')
           )`,
      )
      .run(now.getTime(), taskId, turnId, taskId, turnId, turnId);
    return result.changes === 1;
  }

  listStartupInterruptedTurnIds(): string[] {
    const rows = this.sqlite
      .prepare(
        `SELECT tr.id
         FROM turns tr
         JOIN tasks t ON t.id = tr.task_id
         LEFT JOIN user_turn_slots uts
           ON uts.turn_id = tr.id AND uts.status = 'RUNNING'
         LEFT JOIN queue_entries q
           ON q.turn_id = tr.id AND q.status = 'WAITING'
         WHERE (
           uts.turn_id IS NULL
           AND (
               tr.status = 'ALLOCATING'
               OR (
                 t.current_turn_id = tr.codex_turn_id
                 AND t.status IN ('RUNNING', 'WAITING_APPROVAL')
               )
             )
         ) OR (
           tr.status = 'NEEDS_RECOVERY'
           AND q.turn_id IS NOT NULL
         )
         ORDER BY tr.started_at, tr.id`,
      )
      .all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  appendTaskEvent<Type extends TaskEventType>(input: {
    taskId: string;
    threadId: string | null;
    turnId: string | null;
    type: Type;
    payload: TaskEventPayloadMap[Type];
    now: Date;
  }): TaskEvent {
    return this.immediateTransaction(() => {
      const pathContext = this.runtimePathContextForTask(input.taskId);
      const payload = sanitizeTaskEventPayload(input.type, input.payload, pathContext);
      const itemId = deriveEventItemId(input.taskId, input.turnId, input.type, payload);
      const sequenceRow = this.sqlite
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?",
        )
        .get(input.taskId) as { sequence: number };
      this.sqlite
        .prepare(
          `INSERT INTO task_events (
            task_id, sequence, thread_id, turn_id, item_id, type, payload_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.taskId,
          sequenceRow.sequence,
          input.threadId,
          input.turnId,
          itemId,
          input.type,
          JSON.stringify(payload),
          input.now.getTime(),
        );
      if (input.type === "TURN_FAILED") {
        const task = this.getTaskRow(input.taskId);
        const failurePayload = payload as Record<string, unknown>;
        const code = stringValue(failurePayload.code) ?? "TURN_FAILED";
        const message = stringValue(failurePayload.error) ?? "Turn failed";
        this.insertAudit({
          actorUserId: task.owner_id,
          accountId: task.account_id,
          accountAlias: task.account_alias,
          leaseId: task.lease_id,
          taskId: input.taskId,
          threadId: input.threadId,
          turnId: input.turnId,
          action: "TURN_FAILED",
          outcome: "FAILED",
          summary: `${code}: ${message}`,
          now: input.now,
        });
      }
      return {
        taskId: input.taskId,
        threadId: input.threadId,
        turnId: input.turnId,
        itemId,
        sequence: sequenceRow.sequence,
        timestamp: input.now.toISOString(),
        type: input.type,
        payload,
      } as TaskEvent;
    });
  }

  listTaskEvents(taskId: string, ownerId: string, afterSequence = 0): TaskEvent[] | null {
    const task = this.getTaskForUser(taskId, ownerId);
    if (task?.lifecycleState !== "ACTIVE") return null;
    const pathContext = this.runtimePathContextForTask(taskId);
    const rows = this.sqlite
      .prepare("SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence")
      .all(taskId, afterSequence) as EventRow[];
    return rows.map((row) =>
      mapEvent(row, this.resolvePlatformTurnId(row.task_id, row.turn_id), pathContext),
    );
  }

  getUserSettings(userId: string, now: Date): UserSettings {
    this.requireUser(userId);
    const row = this.sqlite
      .prepare("SELECT settings_json, updated_at FROM user_settings WHERE user_id = ?")
      .get(userId) as UserSettingsRow | undefined;
    if (!row) return defaultUserSettings(now);
    return UserSettingsSchema.parse({
      ...JSON.parse(row.settings_json),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }

  getUserUsage(userId: string): UserUsageRecord {
    this.requireUser(userId);
    const row = this.sqlite
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM tasks WHERE owner_id = ? AND lifecycle_state = 'ACTIVE') AS threads,
          (SELECT COUNT(*) FROM turns tr JOIN tasks t ON t.id = tr.task_id
            WHERE t.owner_id = ? AND t.lifecycle_state = 'ACTIVE') AS turns,
          (SELECT COUNT(*) FROM tool_calls WHERE user_id = ?) AS tool_calls,
          (SELECT COUNT(*) FROM subagent_threads WHERE owner_id = ?) AS subagents,
          (SELECT COUNT(*) FROM thread_token_usage WHERE owner_id = ?) AS token_rows,
          (SELECT COALESCE(SUM(total_tokens), 0) FROM thread_token_usage
            WHERE owner_id = ?) AS total_tokens,
          (SELECT COALESCE(SUM(input_tokens), 0) FROM thread_token_usage
            WHERE owner_id = ?) AS input_tokens,
          (SELECT COALESCE(SUM(cached_input_tokens), 0) FROM thread_token_usage
            WHERE owner_id = ?) AS cached_input_tokens,
          (SELECT COALESCE(SUM(output_tokens), 0) FROM thread_token_usage
            WHERE owner_id = ?) AS output_tokens,
          (SELECT COALESCE(SUM(reasoning_output_tokens), 0) FROM thread_token_usage
            WHERE owner_id = ?) AS reasoning_output_tokens`,
      )
      .get(userId, userId, userId, userId, userId, userId, userId, userId, userId, userId) as {
      threads: number;
      turns: number;
      tool_calls: number;
      subagents: number;
      token_rows: number;
      total_tokens: number;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
    };
    return {
      threads: row.threads,
      turns: row.turns,
      toolCalls: row.tool_calls,
      subagents: row.subagents,
      tokenUsage:
        row.token_rows === 0
          ? null
          : {
              scope: "OWNED_THREAD_TREES",
              totalTokens: row.total_tokens,
              inputTokens: row.input_tokens,
              cachedInputTokens: row.cached_input_tokens,
              outputTokens: row.output_tokens,
              reasoningOutputTokens: row.reasoning_output_tokens,
            },
      tokenUsageStatus: row.token_rows === 0 ? "UNKNOWN" : "KNOWN",
      quota: {
        scope: "SHARED_CODEX_ACCOUNT",
        attributableToUser: false,
      },
    };
  }

  getUserConnections(userId: string): UserConnectionRecord[] {
    this.requireUser(userId);
    const row = this.sqlite
      .prepare("SELECT scopes, status FROM feishu_credentials WHERE user_id = ?")
      .get(userId) as
      | {
          scopes: string;
          status: "CONNECTED" | "REFRESHING" | "REAUTH_REQUIRED";
        }
      | undefined;
    return [
      {
        id: "feishu",
        name: "飞书",
        managed: true,
        connected: Boolean(row && row.status !== "REAUTH_REQUIRED"),
        scopes: row ? safeStringArray(row.scopes) : [],
        status: row?.status ?? "NOT_CONNECTED",
      },
    ];
  }

  getGlobalUsage(): {
    users: number;
    threads: number;
    turns: number;
    toolCalls: number;
    subagents: number;
    tokenUsage:
      | ({
          scope: "OWNED_THREAD_TREES";
        } & TokenUsageBreakdown)
      | null;
    tokenUsageStatus: "KNOWN" | "UNKNOWN";
    quota: {
      scope: "SHARED_CODEX_ACCOUNT";
      attributableToUser: false;
    };
  } {
    const row = this.sqlite
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM tasks WHERE lifecycle_state = 'ACTIVE') AS threads,
          (SELECT COUNT(*) FROM turns tr JOIN tasks t ON t.id = tr.task_id
            WHERE t.lifecycle_state = 'ACTIVE') AS turns,
          (SELECT COUNT(*) FROM tool_calls) AS tool_calls,
          (SELECT COUNT(*) FROM subagent_threads) AS subagents,
          (SELECT COUNT(*) FROM thread_token_usage) AS token_rows,
          (SELECT COALESCE(SUM(total_tokens), 0) FROM thread_token_usage) AS total_tokens,
          (SELECT COALESCE(SUM(input_tokens), 0) FROM thread_token_usage) AS input_tokens,
          (SELECT COALESCE(SUM(cached_input_tokens), 0) FROM thread_token_usage)
            AS cached_input_tokens,
          (SELECT COALESCE(SUM(output_tokens), 0) FROM thread_token_usage) AS output_tokens,
          (SELECT COALESCE(SUM(reasoning_output_tokens), 0) FROM thread_token_usage)
            AS reasoning_output_tokens`,
      )
      .get() as {
      users: number;
      threads: number;
      turns: number;
      tool_calls: number;
      subagents: number;
      token_rows: number;
      total_tokens: number;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
    };
    return {
      users: row.users,
      threads: row.threads,
      turns: row.turns,
      toolCalls: row.tool_calls,
      subagents: row.subagents,
      tokenUsage:
        row.token_rows === 0
          ? null
          : {
              scope: "OWNED_THREAD_TREES",
              totalTokens: row.total_tokens,
              inputTokens: row.input_tokens,
              cachedInputTokens: row.cached_input_tokens,
              outputTokens: row.output_tokens,
              reasoningOutputTokens: row.reasoning_output_tokens,
            },
      tokenUsageStatus: row.token_rows === 0 ? "UNKNOWN" : "KNOWN",
      quota: {
        scope: "SHARED_CODEX_ACCOUNT",
        attributableToUser: false,
      },
    };
  }

  patchUserSettings(userId: string, patch: UserSettingsPatch, now: Date): UserSettings {
    return this.immediateTransaction(() => {
      const current = this.getUserSettings(userId, now);
      const next = UserSettingsSchema.parse({
        general: { ...current.general, ...patch.general },
        execution: { ...current.execution, ...patch.execution },
        personalization: { ...current.personalization, ...patch.personalization },
        updatedAt: now.toISOString(),
      });
      const persisted = {
        general: next.general,
        execution: next.execution,
        personalization: next.personalization,
      };
      this.sqlite
        .prepare(
          `INSERT INTO user_settings (user_id, settings_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             settings_json = excluded.settings_json,
             updated_at = excluded.updated_at`,
        )
        .run(userId, JSON.stringify(persisted), now.getTime());
      return next;
    });
  }

  upsertSubagent(input: {
    threadId: string;
    parentTaskId: string;
    parentRuntimeThreadId: string | null;
    parentTurnId: string | null;
    ownerId: string;
    sessionId: string | null;
    name: string;
    role: string;
    model: string | null;
    effort: string | null;
    status: SubagentStatus;
    resultSummary: string | null;
    now: Date;
  }): void {
    const existing = this.sqlite
      .prepare("SELECT * FROM subagent_threads WHERE thread_id = ?")
      .get(input.threadId) as SubagentRow | undefined;
    if (existing) {
      if (
        existing.owner_id !== input.ownerId ||
        existing.parent_task_id !== input.parentTaskId ||
        (existing.parent_thread_id !== null &&
          input.parentRuntimeThreadId !== null &&
          existing.parent_thread_id !== input.parentRuntimeThreadId) ||
        (existing.parent_turn_id !== null &&
          input.parentTurnId !== null &&
          existing.parent_turn_id !== input.parentTurnId)
      ) {
        throw new Error("Subagent owner or parent chain conflict");
      }
      const existingTerminal = isTerminalSubagentStatus(existing.status);
      const status = existingTerminal ? existing.status : input.status;
      const terminal = isTerminalSubagentStatus(status);
      this.sqlite
        .prepare(
          `UPDATE subagent_threads
           SET parent_thread_id = COALESCE(parent_thread_id, ?),
               parent_turn_id = COALESCE(parent_turn_id, ?),
               session_id = COALESCE(?, session_id),
               name = ?,
               role = ?,
               model = COALESCE(?, model),
               effort = COALESCE(?, effort),
               status = ?,
               result_summary = COALESCE(?, result_summary),
               completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END,
               updated_at = ?
           WHERE thread_id = ?`,
        )
        .run(
          input.parentRuntimeThreadId,
          input.parentTurnId,
          input.sessionId,
          input.name,
          input.role,
          input.model,
          input.effort,
          status,
          input.resultSummary,
          terminal ? 1 : 0,
          input.now.getTime(),
          input.now.getTime(),
          input.threadId,
        );
      return;
    }
    const task = this.getTaskForUser(input.parentTaskId, input.ownerId);
    if (!task) throw new Error("Task not found");
    const terminal = ["DONE", "FAILED", "INTERRUPTED"].includes(input.status);
    this.sqlite
      .prepare(
        `INSERT INTO subagent_threads (
          thread_id, parent_task_id, parent_thread_id, parent_turn_id, owner_id,
          session_id, name, role, model, effort, status, result_summary,
          started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.threadId,
        input.parentTaskId,
        input.parentRuntimeThreadId,
        input.parentTurnId,
        input.ownerId,
        input.sessionId,
        input.name,
        input.role,
        input.model,
        input.effort,
        input.status,
        input.resultSummary,
        input.now.getTime(),
        terminal ? input.now.getTime() : null,
        input.now.getTime(),
      );
  }

  listSubagents(taskId: string, ownerId: string, now: Date): SubagentThread[] | null {
    if (!this.getTaskForUser(taskId, ownerId)) return null;
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM subagent_threads
         WHERE parent_task_id = ? AND owner_id = ?
         ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, updated_at DESC, thread_id`,
      )
      .all(taskId, ownerId) as SubagentRow[];
    return rows.map((row) =>
      mapSubagent(
        row,
        now,
        this.getThreadTokenUsage(row.thread_id),
        this.resolvePlatformTurnId(row.parent_task_id, row.parent_turn_id),
      ),
    );
  }

  getSubagent(threadId: string, ownerId: string, now: Date): SubagentThread | null {
    const row = this.sqlite
      .prepare("SELECT * FROM subagent_threads WHERE thread_id = ? AND owner_id = ?")
      .get(threadId, ownerId) as SubagentRow | undefined;
    return row
      ? mapSubagent(
          row,
          now,
          this.getThreadTokenUsage(threadId),
          this.resolvePlatformTurnId(row.parent_task_id, row.parent_turn_id),
        )
      : null;
  }

  appendSubagentEvent<Type extends TaskEventType>(input: {
    threadId: string;
    turnId: string | null;
    type: Type;
    payload: TaskEventPayloadMap[Type];
    now: Date;
  }): ThreadItem {
    return this.immediateTransaction(() => {
      const subagent = this.sqlite
        .prepare("SELECT parent_task_id FROM subagent_threads WHERE thread_id = ?")
        .get(input.threadId) as { parent_task_id: string } | undefined;
      if (!subagent) throw new Error("Subagent not found");
      const pathContext = this.runtimePathContextForTask(subagent.parent_task_id);
      const payload = sanitizeTaskEventPayload(input.type, input.payload, pathContext);
      const itemId = deriveEventItemId(subagent.parent_task_id, input.turnId, input.type, payload);
      const sequenceRow = this.sqlite
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
           FROM subagent_events WHERE thread_id = ?`,
        )
        .get(input.threadId) as { sequence: number };
      this.sqlite
        .prepare(
          `INSERT INTO subagent_events (
            thread_id, sequence, turn_id, item_id, type, payload_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.threadId,
          sequenceRow.sequence,
          input.turnId,
          itemId,
          input.type,
          JSON.stringify(payload),
          input.now.getTime(),
        );
      return {
        id: itemId,
        threadId: input.threadId,
        turnId: input.turnId,
        sequence: sequenceRow.sequence,
        type: input.type,
        timestamp: input.now.toISOString(),
        payload,
      };
    });
  }

  getSubagentDetail(threadId: string, ownerId: string, now: Date): SubagentThreadDetail | null {
    const summary = this.getSubagent(threadId, ownerId, now);
    if (!summary) return null;
    const rows = this.sqlite
      .prepare("SELECT * FROM subagent_events WHERE thread_id = ? ORDER BY sequence")
      .all(threadId) as SubagentEventRow[];
    return {
      ...summary,
      items: rows.map((row) =>
        mapSubagentEvent(
          row,
          this.resolvePlatformTurnId(summary.parentThreadId, row.turn_id),
          this.runtimePathContextForTask(summary.parentThreadId),
        ),
      ),
    };
  }

  private runtimePathContextForTask(taskId: string): RuntimePathRedactionContext {
    const row = this.sqlite
      .prepare(
        `SELECT a.codex_home
         FROM tasks t
         LEFT JOIN codex_accounts a ON a.id = t.account_id
         WHERE t.id = ?`,
      )
      .get(taskId) as { codex_home: string | null } | undefined;
    const codexHome = row?.codex_home ?? null;
    const inferredRuntimeDir =
      codexHome && basename(dirname(codexHome)) === "codex-accounts"
        ? dirname(dirname(codexHome))
        : null;
    const runtimeDataDir = this.options.runtimeDataDir ?? inferredRuntimeDir;
    return {
      runtimeDataDir,
      codexHome,
      workspaceDir: runtimeDataDir ? join(runtimeDataDir, "workspaces", taskId) : null,
    };
  }

  setSubagentStatus(
    threadId: string,
    status: SubagentStatus,
    now: Date,
    resultSummary?: string | null,
  ): void {
    const existing = this.sqlite
      .prepare("SELECT status FROM subagent_threads WHERE thread_id = ?")
      .get(threadId) as { status: SubagentStatus } | undefined;
    if (!existing) throw new Error("Subagent not found");
    if (isTerminalSubagentStatus(existing.status)) return;
    const terminal = isTerminalSubagentStatus(status);
    const result = this.sqlite
      .prepare(
        `UPDATE subagent_threads
         SET status = ?,
             result_summary = COALESCE(?, result_summary),
             completed_at = CASE WHEN ? THEN COALESCE(completed_at, ?) ELSE completed_at END,
             updated_at = ?
         WHERE thread_id = ?`,
      )
      .run(status, resultSummary ?? null, terminal ? 1 : 0, now.getTime(), now.getTime(), threadId);
    if (result.changes !== 1) throw new Error("Subagent not found");
  }

  upsertThreadTokenUsage(input: {
    taskId: string;
    ownerId: string;
    runtimeThreadId: string;
    turnId: string | null;
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
    now: Date;
  }): void {
    const total = TokenUsageBreakdownSchema.parse(input.total);
    const last = TokenUsageBreakdownSchema.parse(input.last);
    const task = this.getTaskForUser(input.taskId, input.ownerId);
    if (!task) throw new Error("Task not found");
    const subagent = this.sqlite
      .prepare(
        `SELECT parent_task_id, parent_thread_id, owner_id
         FROM subagent_threads WHERE thread_id = ?`,
      )
      .get(input.runtimeThreadId) as
      | { parent_task_id: string; parent_thread_id: string | null; owner_id: string }
      | undefined;
    if (
      subagent &&
      (subagent.parent_task_id !== input.taskId || subagent.owner_id !== input.ownerId)
    ) {
      throw new Error("Thread token usage owner or parent conflict");
    }
    if (!subagent && task.threadId !== input.runtimeThreadId) {
      throw new Error("Thread token usage is not bound to the owned Thread tree");
    }
    const parentRuntimeThreadId = subagent?.parent_thread_id ?? null;
    const existing = this.sqlite
      .prepare(
        `SELECT parent_task_id, owner_id, parent_runtime_thread_id
         FROM thread_token_usage WHERE runtime_thread_id = ?`,
      )
      .get(input.runtimeThreadId) as
      | {
          parent_task_id: string;
          owner_id: string;
          parent_runtime_thread_id: string | null;
        }
      | undefined;
    if (
      existing &&
      (existing.parent_task_id !== input.taskId ||
        existing.owner_id !== input.ownerId ||
        existing.parent_runtime_thread_id !== parentRuntimeThreadId)
    ) {
      throw new Error("Thread token usage owner or parent conflict");
    }
    this.sqlite
      .prepare(
        `INSERT INTO thread_token_usage (
          runtime_thread_id, parent_task_id, owner_id, parent_runtime_thread_id, turn_id,
          total_tokens, input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, last_total_tokens, last_input_tokens,
          last_cached_input_tokens, last_output_tokens, last_reasoning_output_tokens,
          model_context_window, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runtime_thread_id) DO UPDATE SET
           turn_id = excluded.turn_id,
           total_tokens = excluded.total_tokens,
           input_tokens = excluded.input_tokens,
           cached_input_tokens = excluded.cached_input_tokens,
           output_tokens = excluded.output_tokens,
           reasoning_output_tokens = excluded.reasoning_output_tokens,
           last_total_tokens = excluded.last_total_tokens,
           last_input_tokens = excluded.last_input_tokens,
           last_cached_input_tokens = excluded.last_cached_input_tokens,
           last_output_tokens = excluded.last_output_tokens,
           last_reasoning_output_tokens = excluded.last_reasoning_output_tokens,
           model_context_window = excluded.model_context_window,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.runtimeThreadId,
        input.taskId,
        input.ownerId,
        parentRuntimeThreadId,
        input.turnId,
        total.totalTokens,
        total.inputTokens,
        total.cachedInputTokens,
        total.outputTokens,
        total.reasoningOutputTokens,
        last.totalTokens,
        last.inputTokens,
        last.cachedInputTokens,
        last.outputTokens,
        last.reasoningOutputTokens,
        input.modelContextWindow,
        input.now.getTime(),
      );
  }

  private getThreadTokenUsage(runtimeThreadId: string): TokenUsageBreakdown | null {
    const row = this.sqlite
      .prepare("SELECT * FROM thread_token_usage WHERE runtime_thread_id = ?")
      .get(runtimeThreadId) as ThreadTokenUsageRow | undefined;
    return row
      ? {
          totalTokens: row.total_tokens,
          inputTokens: row.input_tokens,
          cachedInputTokens: row.cached_input_tokens,
          outputTokens: row.output_tokens,
          reasoningOutputTokens: row.reasoning_output_tokens,
        }
      : null;
  }

  createApproval(input: {
    requestId: string;
    rawRpcId: number | string;
    accountId: string;
    connectionGeneration: number;
    threadId: string;
    taskId: string;
    turnId: string;
    parentTurnId?: string;
    itemId: string;
    approvalType: string;
    payload: unknown;
    now: Date;
  }): ApprovalRecord {
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO approvals (
          id, request_id, raw_request_id_json, transport_account_id,
          connection_generation, thread_id, task_id, turn_id, parent_turn_id, item_id, approval_type,
          status, payload_json, requested_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(
        id,
        input.requestId,
        JSON.stringify(input.rawRpcId),
        input.accountId,
        input.connectionGeneration,
        input.threadId,
        input.taskId,
        input.turnId,
        input.parentTurnId ?? input.turnId,
        input.itemId,
        input.approvalType,
        JSON.stringify(input.payload),
        input.now.getTime(),
      );
    return this.getApproval(id);
  }

  markTurnApprovalsForRecovery(taskId: string, turnId: string): number {
    const result = this.sqlite
      .prepare(
        `UPDATE approvals
         SET status = 'RECOVERY_REQUIRED'
         WHERE task_id = ? AND (turn_id = ? OR parent_turn_id = ?)
           AND status IN ('PENDING', 'DELIVERY_PENDING')`,
      )
      .run(taskId, turnId, turnId);
    return result.changes;
  }

  markAccountApprovalsForRecovery(accountId: string): number {
    return this.sqlite
      .prepare(
        `UPDATE approvals
         SET status = 'RECOVERY_REQUIRED'
         WHERE transport_account_id = ?
           AND status IN ('PENDING', 'DELIVERY_PENDING', 'DECIDED')`,
      )
      .run(accountId).changes;
  }

  markUndeliverableApprovalsForRecovery(): number {
    return this.sqlite
      .prepare(
        `UPDATE approvals SET status = 'RECOVERY_REQUIRED'
         WHERE status IN ('PENDING', 'DELIVERY_PENDING', 'DECIDED')`,
      )
      .run().changes;
  }

  claimApprovalDelivery(input: {
    approvalId: string;
    userId: string;
    decision: string;
  }): ApprovalDeliveryClaim {
    return this.immediateTransaction(() => {
      const approval = this.sqlite
        .prepare(
          `SELECT a.*, t.owner_id, t.account_id, t.account_alias, t.lease_id
           FROM approvals a JOIN tasks t ON t.id = a.task_id
           WHERE a.id = ? AND t.owner_id = ?`,
        )
        .get(input.approvalId, input.userId) as Record<string, string | number | null> | undefined;
      if (!approval) throw new Error("Approval not found");
      if (approval.status === "DELIVERED") {
        if (approval.decision !== input.decision) {
          throw new Error("Approval was already delivered with a different decision");
        }
        return { kind: "ALREADY_DELIVERED", approval: mapApproval(approval) };
      }
      if (approval.status === "RECOVERY_REQUIRED" || approval.status === "DECIDED") {
        throw new Error("Approval transport requires recovery and cannot be delivered");
      }
      if (approval.status !== "PENDING")
        throw new Error("Approval delivery is already in progress");

      const transport = mapApprovalTransport(approval);
      this.sqlite
        .prepare(
          `UPDATE approvals SET status = 'DELIVERY_PENDING', decision = ?, decided_by = ?
           WHERE id = ? AND status = 'PENDING'`,
        )
        .run(input.decision, input.userId, input.approvalId);
      return {
        kind: "CLAIMED",
        approval: this.getApproval(input.approvalId),
        transport,
      };
    });
  }

  releaseApprovalDelivery(input: { approvalId: string; userId: string; decision: string }): void {
    const result = this.sqlite
      .prepare(
        `UPDATE approvals
         SET status = 'PENDING', decision = NULL, decided_by = NULL
         WHERE id = ? AND status = 'DELIVERY_PENDING' AND decision = ?
           AND EXISTS (
             SELECT 1 FROM tasks t WHERE t.id = approvals.task_id AND t.owner_id = ?
           )`,
      )
      .run(input.approvalId, input.decision, input.userId);
    if (result.changes !== 1) throw new Error("Approval delivery claim was lost");
  }

  markApprovalDeliveryRecoveryRequired(input: {
    approvalId: string;
    userId: string;
    decision: string;
  }): void {
    const result = this.sqlite
      .prepare(
        `UPDATE approvals SET status = 'RECOVERY_REQUIRED'
         WHERE id = ? AND status = 'DELIVERY_PENDING' AND decision = ?
           AND EXISTS (
             SELECT 1 FROM tasks t WHERE t.id = approvals.task_id AND t.owner_id = ?
           )`,
      )
      .run(input.approvalId, input.decision, input.userId);
    if (result.changes !== 1) throw new Error("Approval delivery claim was lost");
  }

  completeApprovalDelivery(input: {
    approvalId: string;
    userId: string;
    decision: string;
    now: Date;
  }): ApprovalRecord {
    return this.immediateTransaction(() => {
      const approval = this.sqlite
        .prepare(
          `SELECT a.*, t.owner_id, t.account_id, t.account_alias, t.lease_id
           FROM approvals a JOIN tasks t ON t.id = a.task_id
           WHERE a.id = ? AND t.owner_id = ?`,
        )
        .get(input.approvalId, input.userId) as Record<string, string | number | null> | undefined;
      if (!approval) throw new Error("Approval not found");
      if (approval.status === "DELIVERED" && approval.decision === input.decision) {
        return mapApproval(approval);
      }
      if (approval.status !== "DELIVERY_PENDING" || approval.decision !== input.decision) {
        throw new Error("Approval delivery claim was lost");
      }
      this.sqlite
        .prepare(
          `UPDATE approvals SET status = 'DELIVERED', decided_at = ?, decided_by = ?
           WHERE id = ?`,
        )
        .run(input.now.getTime(), input.userId, input.approvalId);
      this.insertAudit({
        actorUserId: input.userId,
        accountId: stringValue(approval.transport_account_id) ?? stringValue(approval.account_id),
        accountAlias: stringValue(approval.account_alias),
        leaseId: stringValue(approval.lease_id),
        taskId: stringValue(approval.task_id),
        threadId: stringValue(approval.thread_id),
        turnId: stringValue(approval.turn_id),
        approvalId: input.approvalId,
        action: "APPROVAL_DECIDED",
        outcome: "SUCCESS",
        summary: `Approval decision: ${input.decision}`,
        now: input.now,
      });
      return this.getApproval(input.approvalId);
    });
  }

  listApprovals(taskId: string, ownerId: string) {
    if (!this.getTaskForUser(taskId, ownerId)) return null;
    const rows = this.sqlite
      .prepare("SELECT * FROM approvals WHERE task_id = ? ORDER BY requested_at")
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(mapApproval);
  }

  projectApproval(record: ApprovalRecord): PublicApprovalRecord {
    return {
      ...record,
      turnId: this.resolvePlatformTurnId(record.taskId, record.turnId),
      parentTurnId: this.resolvePlatformTurnId(record.taskId, record.parentTurnId),
    };
  }

  listAudit(filter: { actorUserId?: string } = {}) {
    const rows = filter.actorUserId
      ? (this.sqlite
          .prepare(
            `SELECT ae.*, u.name AS actor_name
             FROM audit_events ae
             LEFT JOIN users u ON u.id = ae.actor_user_id
             WHERE ae.actor_user_id = ?
             ORDER BY ae.created_at DESC`,
          )
          .all(filter.actorUserId) as Array<Record<string, unknown>>)
      : (this.sqlite
          .prepare(
            `SELECT ae.*, u.name AS actor_name
             FROM audit_events ae
             LEFT JOIN users u ON u.id = ae.actor_user_id
             ORDER BY ae.created_at DESC`,
          )
          .all() as Array<Record<string, unknown>>);
    return rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      actorName: row.actor_name ?? row.actor_user_id,
      accountAlias: row.account_alias,
      leaseId: row.lease_id,
      taskId: row.task_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      toolCallId: row.tool_call_id,
      approvalId: row.approval_id,
      action: row.action,
      outcome: row.outcome,
      summary: row.summary,
      createdAt: new Date(row.created_at as number).toISOString(),
    }));
  }

  recordToolInvocation(input: {
    callId: string;
    taskId: string;
    turnId: string;
    userId: string;
    tool: string;
    arguments: unknown;
    response: unknown;
    success: boolean;
    startedAt: Date;
    completedAt: Date;
  }): void {
    this.immediateTransaction(() => {
      const task = this.getTaskRow(input.taskId);
      if (task.owner_id !== input.userId) throw new Error("Task not found");
      const id = randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO tool_calls (
            id, call_id, task_id, turn_id, user_id, tool, status, input_digest,
            output_digest, started_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.callId,
          input.taskId,
          input.turnId,
          input.userId,
          input.tool,
          input.success ? "SUCCEEDED" : "FAILED",
          digestJson({ tool: input.tool, arguments: input.arguments }),
          digestJson(input.response),
          input.startedAt.getTime(),
          input.completedAt.getTime(),
        );
      this.insertAudit({
        actorUserId: input.userId,
        accountId: task.account_id,
        accountAlias: task.account_alias,
        leaseId: task.lease_id,
        taskId: input.taskId,
        threadId: task.thread_id,
        turnId: input.turnId,
        toolCallId: id,
        action: "TOOL_INVOKED",
        outcome: input.success ? "SUCCESS" : "FAILED",
        summary: `Enterprise tool invoked: ${input.tool}`,
        now: input.completedAt,
      });
    });
  }

  private requireUser(userId: string): void {
    const user = this.sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(userId);
    if (!user) throw new Error("User not found");
  }

  private getProject(id: string, ownerId: string): ProjectRecord | null {
    const row = this.sqlite
      .prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM tasks t
            WHERE t.project_id = p.id AND t.lifecycle_state = 'ACTIVE') AS task_count
         FROM projects p WHERE p.id = ? AND p.owner_id = ?`,
      )
      .get(id, ownerId) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  private attachmentRefs(taskId: string): Array<{ id: string; relativePath: string }> {
    return (
      this.sqlite
        .prepare("SELECT id, relative_path FROM draft_attachments WHERE task_id = ?")
        .all(taskId) as Array<{ id: string; relative_path: string }>
    ).map((row) => ({ id: row.id, relativePath: row.relative_path }));
  }

  private enqueueAttachmentCleanupJobs(
    threadId: string,
    attachments: Array<{ id: string; relativePath: string }>,
    now: Date,
  ): void {
    const statement = this.sqlite.prepare(
      `INSERT INTO attachment_cleanup_jobs (
        id, thread_id, attachment_id, relative_path, status,
        attempts, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'PENDING', 0, NULL, ?, ?)
       ON CONFLICT(thread_id, attachment_id) DO NOTHING`,
    );
    for (const attachment of attachments) {
      statement.run(
        randomUUID(),
        threadId,
        attachment.id,
        attachment.relativePath,
        now.getTime(),
        now.getTime(),
      );
    }
  }

  private getTaskRow(taskId: string): TaskRow {
    const row = this.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (!row) throw new Error("Task not found");
    return row;
  }

  private getApproval(id: string): ApprovalRecord {
    const row = this.sqlite.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error("Approval not found");
    return mapApproval(row);
  }

  private insertAudit(input: {
    actorUserId: string;
    accountId?: string | null;
    accountAlias?: string | null;
    leaseId?: string | null;
    taskId?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    toolCallId?: string | null;
    approvalId?: string | null;
    action: string;
    outcome: string;
    summary: string;
    now: Date;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO audit_events (
          id, actor_user_id, account_id, account_alias, lease_id, task_id, thread_id,
          turn_id, tool_call_id, approval_id, action, outcome, summary, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.actorUserId,
        input.accountId ?? null,
        input.accountAlias ?? null,
        input.leaseId ?? null,
        input.taskId ?? null,
        input.threadId ?? null,
        input.turnId ?? null,
        input.toolCallId ?? null,
        input.approvalId ?? null,
        input.action,
        input.outcome,
        input.summary,
        input.now.getTime(),
      );
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    taskCount: row.task_count,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    title: row.title,
    status: row.status,
    queueTicket: row.queue_ticket,
    accountId: row.account_id,
    accountAlias: row.account_alias,
    leaseId: row.lease_id,
    threadId: row.thread_id,
    currentTurnId: row.current_turn_id,
    threadConfig: row.thread_config_json
      ? EffectiveConfigOverrideSchema.parse(JSON.parse(row.thread_config_json))
      : null,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at).toISOString(),
    lifecycleState: row.lifecycle_state,
    draftExpiresAt:
      row.draft_expires_at === null ? null : new Date(row.draft_expires_at).toISOString(),
    planMode: row.plan_mode === 1,
    composerRevision: row.composer_revision,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapThreadGoal(row: ThreadGoalRow): StoredThreadGoalView {
  const view = ThreadGoalViewSchema.parse({
    threadId: row.task_id,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeBudgetSeconds: row.time_budget_seconds,
    timeUsedSeconds: row.time_used_seconds,
    runtimeSyncState: row.runtime_sync_state,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
  return { ...view, revision: row.revision };
}

function mapAttachment(row: AttachmentRow): DraftAttachment {
  return DraftAttachmentSchema.parse({
    id: row.id,
    threadId: row.task_id,
    kind: row.kind,
    name: row.name,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    fileCount: row.file_count,
    scanStatus: row.scan_status,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function mapTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    ownerId: row.owner_id,
    prompt: row.prompt,
    status: row.status,
    codexTurnId: row.codex_turn_id,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    durationMs: row.duration_ms,
    configSnapshot: row.config_snapshot_json
      ? EffectiveThreadConfigSnapshotSchema.parse(JSON.parse(row.config_snapshot_json))
      : DEFAULT_EFFECTIVE_CONFIG_SNAPSHOT,
  };
}

function mapEvent(
  row: EventRow,
  platformTurnId: string | null,
  pathContext: RuntimePathRedactionContext,
): TaskEvent {
  const payload = sanitizeRuntimeTurnIdentifier(
    sanitizeTaskEventPayload(
      row.type,
      JSON.parse(row.payload_json) as TaskEventPayloadMap[TaskEventType],
      pathContext,
    ),
    row.turn_id,
    platformTurnId,
  );
  const persistedItemId =
    row.item_id && row.turn_id && row.item_id.includes(row.turn_id) ? null : row.item_id;
  return {
    taskId: row.task_id,
    threadId: row.thread_id,
    turnId: platformTurnId,
    itemId: persistedItemId ?? deriveEventItemId(row.task_id, platformTurnId, row.type, payload),
    sequence: row.sequence,
    timestamp: new Date(row.created_at).toISOString(),
    type: row.type,
    payload,
  } as TaskEvent;
}

function defaultUserSettings(now: Date): UserSettings {
  return {
    general: {
      language: "zh-CN",
      theme: "SYSTEM",
      defaultProjectId: null,
      notificationsEnabled: true,
    },
    execution: {
      model: null,
      reasoningEffort: "MEDIUM",
      permissionMode: "DEFAULT",
      approvalPreference: "ASK",
    },
    personalization: {
      personality: "PRAGMATIC",
      instructions: "",
    },
    updatedAt: now.toISOString(),
  };
}

function mapSubagent(
  row: SubagentRow,
  now: Date,
  tokenUsage: TokenUsageBreakdown | null,
  parentPlatformTurnId: string | null,
): SubagentThread {
  const elapsedUntil = row.completed_at ?? now.getTime();
  return {
    threadId: row.thread_id,
    parentThreadId: row.parent_task_id,
    parentTurnId: parentPlatformTurnId,
    sessionId: row.session_id,
    name: row.name,
    role: row.role,
    model: row.model,
    effort: row.effort,
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    elapsedMs: Math.max(0, elapsedUntil - row.started_at),
    resultSummary: row.result_summary,
    tokenUsage,
  };
}

function mapSubagentEvent(
  row: SubagentEventRow,
  platformTurnId: string | null,
  pathContext: RuntimePathRedactionContext,
): ThreadItem {
  const rawPayload = sanitizeEventTransport(
    JSON.parse(row.payload_json) as Record<string, unknown>,
    pathContext,
  ) as Record<string, unknown>;
  const payload = sanitizeRuntimeTurnIdentifier(rawPayload, row.turn_id, platformTurnId);
  const itemId =
    row.turn_id && row.item_id.includes(row.turn_id)
      ? `subagent-item:${row.sequence}`
      : row.item_id;
  return {
    id: itemId,
    threadId: row.thread_id,
    turnId: platformTurnId,
    sequence: row.sequence,
    type: row.type,
    timestamp: new Date(row.created_at).toISOString(),
    payload,
  };
}

function sanitizeRuntimeTurnIdentifier(
  value: unknown,
  runtimeTurnId: string | null,
  platformTurnId: string | null,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const replace = (nested: unknown): unknown => {
    if (Array.isArray(nested)) return nested.map(replace);
    if (typeof nested === "string" && runtimeTurnId && nested.includes(runtimeTurnId)) {
      return nested.replaceAll(runtimeTurnId, platformTurnId ?? "[runtime-turn-redacted]");
    }
    if (!nested || typeof nested !== "object") return nested;
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>).map(([key, item]) => [key, replace(item)]),
    );
  };
  return replace(value) as Record<string, unknown>;
}

function deriveEventItemId(
  taskId: string,
  turnId: string | null,
  type: TaskEventType,
  payload: Record<string, unknown>,
): string {
  if (typeof payload.itemId === "string" && payload.itemId.length > 0) return payload.itemId;
  if (type === "PLAN_UPDATED") return `plan:${turnId ?? taskId}`;
  if (type === "DIFF_UPDATED") return `diff:${turnId ?? taskId}`;
  if (type === "QUEUED") return `queue:${taskId}`;
  if (type === "APPROVAL_DECIDED" && typeof payload.approvalId === "string") {
    return `approval:${payload.approvalId}`;
  }
  if (type.startsWith("TURN_")) return `turn:${turnId ?? taskId}`;
  return `${type.toLowerCase()}:${turnId ?? taskId}`;
}

const PUBLIC_EVENT_PAYLOAD_KEYS = {
  TURN_STARTED: ["status"],
  TURN_COMPLETED: ["status", "durationMs"],
  TURN_FAILED: ["status", "code", "error"],
  TURN_INTERRUPTED: ["status"],
  USER_MESSAGE: ["itemId", "kind", "text"],
  AGENT_MESSAGE_DELTA: ["itemId", "delta"],
  AGENT_MESSAGE_PHASE: ["itemId", "phase"],
  REASONING_SUMMARY_DELTA: ["itemId", "delta"],
  PLAN_UPDATED: ["explanation", "plan"],
  COMMAND_STARTED: ["itemId", "command", "cwd"],
  COMMAND_OUTPUT: ["itemId", "delta"],
  COMMAND_COMPLETED: ["itemId", "command", "aggregatedOutput", "exitCode", "durationMs"],
  TOOL_STARTED: ["itemId", "tool", "arguments"],
  TOOL_COMPLETED: ["itemId", "tool", "result", "durationMs"],
  TOOL_FAILED: ["itemId", "tool", "error"],
  DIFF_UPDATED: ["diff"],
  APPROVAL_REQUESTED: [
    "approvalId",
    "itemId",
    "approvalType",
    "reason",
    "command",
    "cwd",
    "sourceThreadId",
    "sourceSubagent",
    "sourceSubagentName",
  ],
  APPROVAL_DECIDED: ["approvalId", "decision"],
  QUEUED: ["position", "etaMs", "etaEstimated"],
  LEASE_ACQUIRED: ["accountAlias"],
  RECOVERY_REQUIRED: ["reason"],
  SUBAGENT_ACTIVITY: [
    "itemId",
    "agentThreadId",
    "kind",
    "name",
    "role",
    "model",
    "effort",
    "status",
    "resultSummary",
  ],
  TOKEN_USAGE_UPDATED: ["total", "last", "modelContextWindow"],
  MODEL_REROUTED: ["fromModel", "toModel", "reason"],
  RUNTIME_WARNING: ["message"],
  CONTEXT_COMPACTED: ["status"],
} as const satisfies Record<TaskEventType, readonly string[]>;

function sanitizeTaskEventPayload<Type extends TaskEventType>(
  type: Type,
  payload: TaskEventPayloadMap[Type],
  pathContext: RuntimePathRedactionContext = {},
): TaskEventPayloadMap[Type] {
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  if (EVENT_TYPES_REQUIRING_STABLE_ITEM_ID.has(type)) {
    const itemId = source.itemId;
    if (typeof itemId !== "string" || itemId.trim().length === 0) {
      throw new Error(`${type} requires a stable itemId`);
    }
  }
  const projected: Record<string, unknown> = {};
  for (const key of PUBLIC_EVENT_PAYLOAD_KEYS[type]) {
    if (!(key in source)) continue;
    projected[key] = sanitizeEventTransport(source[key], pathContext);
  }
  return projected as TaskEventPayloadMap[Type];
}

const EVENT_TYPES_REQUIRING_STABLE_ITEM_ID = new Set<TaskEventType>([
  "USER_MESSAGE",
  "AGENT_MESSAGE_DELTA",
  "AGENT_MESSAGE_PHASE",
  "REASONING_SUMMARY_DELTA",
  "COMMAND_STARTED",
  "COMMAND_OUTPUT",
  "COMMAND_COMPLETED",
  "TOOL_STARTED",
  "TOOL_COMPLETED",
  "TOOL_FAILED",
  "APPROVAL_REQUESTED",
  "SUBAGENT_ACTIVITY",
]);

const DEFAULT_EFFECTIVE_CONFIG_SNAPSHOT: EffectiveThreadConfigSnapshot =
  EffectiveThreadConfigSnapshotSchema.parse({
    model: null,
    reasoningEffort: "MEDIUM",
    permissionMode: "DEFAULT",
    approvalMode: "ASK",
    personality: "PRAGMATIC",
    instructions: "",
    sourceVersion: "legacy-default-v1",
  });

function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return status === "DONE" || status === "FAILED" || status === "INTERRUPTED";
}

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    taskId: String(row.task_id),
    turnId: String(row.turn_id),
    parentTurnId: typeof row.parent_turn_id === "string" ? row.parent_turn_id : String(row.turn_id),
    sourceThreadId: typeof row.thread_id === "string" ? row.thread_id : null,
    itemId: String(row.item_id),
    approvalType: String(row.approval_type),
    status: String(row.status),
    payload: JSON.parse(String(row.payload_json)),
    decision: typeof row.decision === "string" ? row.decision : null,
    requestedAt: new Date(row.requested_at as number).toISOString(),
    decidedAt: typeof row.decided_at === "number" ? new Date(row.decided_at).toISOString() : null,
  };
}

function mapApprovalTransport(row: Record<string, unknown>): ApprovalTransportIdentity {
  const accountId = stringValue(row.transport_account_id);
  const threadId = stringValue(row.thread_id);
  const connectionGeneration = row.connection_generation;
  const rawRequestIdJson = stringValue(row.raw_request_id_json);
  if (!accountId || !threadId || typeof connectionGeneration !== "number" || !rawRequestIdJson) {
    throw new Error("Approval transport requires recovery and cannot be delivered");
  }
  const rawRpcId: unknown = JSON.parse(rawRequestIdJson);
  if (typeof rawRpcId !== "string" && typeof rawRpcId !== "number") {
    throw new Error("Approval transport request id is invalid");
  }
  return {
    accountId,
    connectionGeneration,
    threadId,
    turnId: String(row.turn_id),
    requestId: String(row.request_id),
    rawRpcId,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function safeStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
