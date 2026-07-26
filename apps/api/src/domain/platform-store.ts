import { createHash, randomUUID } from "node:crypto";
import {
  type EffectiveConfigOverride,
  EffectiveConfigOverrideSchema,
  type EffectiveThreadConfigSnapshot,
  EffectiveThreadConfigSnapshotSchema,
  type SubagentStatus,
  type SubagentThread,
  type SubagentThreadDetail,
  type TaskEvent,
  type TaskEventPayloadMap,
  type TaskEventType,
  type ThreadItem,
  type TokenUsageBreakdown,
  TokenUsageBreakdownSchema,
  type UserSettings,
  type UserSettingsPatch,
  UserSettingsSchema,
} from "@codexplatform/contracts";
import type Database from "better-sqlite3";

export interface ProjectRecord {
  id: string;
  ownerId: string;
  name: string;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
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
  status: "CONNECTED" | "NOT_CONNECTED";
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
  created_at: number;
  updated_at: number;
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
  constructor(private readonly sqlite: Database.Database) {}

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
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
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

  listTasks(ownerId: string, projectId?: string): TaskRecord[] {
    const rows = projectId
      ? (this.sqlite
          .prepare(
            "SELECT * FROM tasks WHERE owner_id = ? AND project_id = ? ORDER BY updated_at DESC",
          )
          .all(ownerId, projectId) as TaskRow[])
      : (this.sqlite
          .prepare("SELECT * FROM tasks WHERE owner_id = ? ORDER BY updated_at DESC")
          .all(ownerId) as TaskRow[]);
    return rows.map(mapTask);
  }

  getTaskForUser(taskId: string, ownerId: string): TaskRecord | null {
    const row = this.sqlite
      .prepare("SELECT * FROM tasks WHERE id = ? AND owner_id = ?")
      .get(taskId, ownerId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
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
    now: Date;
  }): TurnRecord {
    this.immediateTransaction(() => {
      const task = this.sqlite
        .prepare("SELECT owner_id FROM tasks WHERE id = ?")
        .get(input.taskId) as { owner_id: string } | undefined;
      if (!task || task.owner_id !== input.ownerId) throw new Error("Task not found");
      const active = this.sqlite
        .prepare(
          `SELECT 1 FROM turns
           WHERE task_id = ? AND status IN ('ALLOCATING', 'QUEUED', 'RUNNING')
           LIMIT 1`,
        )
        .get(input.taskId);
      if (active) throw new Error("Task already has an active Turn");
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
    });
    return this.getTurn(input.id) as TurnRecord;
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
      const payload = sanitizeTaskEventPayload(input.type, input.payload);
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
    if (!this.getTaskForUser(taskId, ownerId)) return null;
    const rows = this.sqlite
      .prepare("SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence")
      .all(taskId, afterSequence) as EventRow[];
    return rows.map((row) => mapEvent(row, this.resolvePlatformTurnId(row.task_id, row.turn_id)));
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
          (SELECT COUNT(*) FROM tasks WHERE owner_id = ?) AS threads,
          (SELECT COUNT(*) FROM turns tr JOIN tasks t ON t.id = tr.task_id
            WHERE t.owner_id = ?) AS turns,
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
      .prepare("SELECT scopes FROM feishu_credentials WHERE user_id = ?")
      .get(userId) as { scopes: string } | undefined;
    return [
      {
        id: "feishu",
        name: "飞书",
        managed: true,
        connected: Boolean(row),
        scopes: row ? safeStringArray(row.scopes) : [],
        status: row ? "CONNECTED" : "NOT_CONNECTED",
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
          (SELECT COUNT(*) FROM tasks) AS threads,
          (SELECT COUNT(*) FROM turns) AS turns,
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
      const payload = sanitizeTaskEventPayload(input.type, input.payload);
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
        mapSubagentEvent(row, this.resolvePlatformTurnId(summary.parentThreadId, row.turn_id)),
      ),
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
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
         FROM projects p WHERE p.id = ? AND p.owner_id = ?`,
      )
      .get(id, ownerId) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
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
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
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

function mapEvent(row: EventRow, platformTurnId: string | null): TaskEvent {
  const payload = sanitizeRuntimeTurnIdentifier(
    sanitizeTaskEventPayload(
      row.type,
      JSON.parse(row.payload_json) as TaskEventPayloadMap[TaskEventType],
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

function mapSubagentEvent(row: SubagentEventRow, platformTurnId: string | null): ThreadItem {
  const rawPayload = JSON.parse(row.payload_json) as Record<string, unknown>;
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
  TURN_FAILED: ["status", "error"],
  TURN_INTERRUPTED: ["status"],
  USER_MESSAGE: ["itemId", "kind", "text"],
  AGENT_MESSAGE_DELTA: ["itemId", "delta"],
  REASONING_SUMMARY_DELTA: ["itemId", "delta"],
  PLAN_UPDATED: ["explanation", "plan"],
  COMMAND_STARTED: ["itemId", "command", "cwd"],
  COMMAND_OUTPUT: ["itemId", "delta"],
  COMMAND_COMPLETED: ["itemId", "command", "exitCode", "durationMs"],
  TOOL_STARTED: ["itemId", "tool", "arguments"],
  TOOL_COMPLETED: ["itemId", "tool", "durationMs"],
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
} as const satisfies Record<TaskEventType, readonly string[]>;

function sanitizeTaskEventPayload<Type extends TaskEventType>(
  type: Type,
  payload: TaskEventPayloadMap[Type],
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
    projected[key] = stripDangerousReasoningKeys(source[key]);
  }
  return projected as TaskEventPayloadMap[Type];
}

const EVENT_TYPES_REQUIRING_STABLE_ITEM_ID = new Set<TaskEventType>([
  "USER_MESSAGE",
  "AGENT_MESSAGE_DELTA",
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

function stripDangerousReasoningKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDangerousReasoningKeys);
  if (!value || typeof value !== "object") return value;
  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "reasoningTextDelta" ||
      key === "reasoning_text_delta" ||
      key === "encrypted_content" ||
      key === "encryptedContent"
    ) {
      continue;
    }
    clean[key] = stripDangerousReasoningKeys(nested);
  }
  return clean;
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
