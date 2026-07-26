import { createHash, randomUUID } from "node:crypto";
import type { TaskEvent, TaskEventPayloadMap, TaskEventType } from "@codexplatform/contracts";
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
  accountAlias: string | null;
  leaseId: string | null;
  threadId: string | null;
  currentTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: string;
  requestId: string;
  taskId: string;
  turnId: string;
  itemId: string;
  approvalType: string;
  status: string;
  payload: unknown;
  decision: string | null;
  requestedAt: string;
  decidedAt: string | null;
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
  created_at: number;
  updated_at: number;
}

interface EventRow {
  task_id: string;
  sequence: number;
  thread_id: string | null;
  turn_id: string | null;
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
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
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

  createTask(input: { ownerId: string; projectId: string; title: string; now: Date }): TaskRecord {
    const ownsProject = this.getProject(input.projectId, input.ownerId);
    if (!ownsProject) throw new Error("Project not found");
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO tasks (
          id, project_id, owner_id, title, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'READY', ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.ownerId,
        input.title,
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

  createTurn(input: {
    id: string;
    taskId: string;
    ownerId: string;
    prompt: string;
    status: "ALLOCATING" | "QUEUED";
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
          `INSERT INTO turns (id, task_id, prompt, status, started_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.taskId, input.prompt, input.status, input.now.getTime());
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
             WHERE a.task_id = ? AND a.turn_id = ?
               AND a.status IN ('PENDING', 'DELIVERY_PENDING')
           )`,
      )
      .run(now.getTime(), taskId, turnId, taskId, turnId);
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
      const sequenceRow = this.sqlite
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?",
        )
        .get(input.taskId) as { sequence: number };
      this.sqlite
        .prepare(
          `INSERT INTO task_events (
            task_id, sequence, thread_id, turn_id, type, payload_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.taskId,
          sequenceRow.sequence,
          input.threadId,
          input.turnId,
          input.type,
          JSON.stringify(input.payload),
          input.now.getTime(),
        );
      return {
        taskId: input.taskId,
        threadId: input.threadId,
        turnId: input.turnId,
        sequence: sequenceRow.sequence,
        timestamp: input.now.toISOString(),
        type: input.type,
        payload: input.payload,
      } as TaskEvent;
    });
  }

  listTaskEvents(taskId: string, ownerId: string, afterSequence = 0): TaskEvent[] | null {
    if (!this.getTaskForUser(taskId, ownerId)) return null;
    const rows = this.sqlite
      .prepare("SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence")
      .all(taskId, afterSequence) as EventRow[];
    return rows.map(mapEvent);
  }

  createApproval(input: {
    requestId: string;
    rawRpcId: number | string;
    accountId: string;
    connectionGeneration: number;
    threadId: string;
    taskId: string;
    turnId: string;
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
          connection_generation, thread_id, task_id, turn_id, item_id, approval_type,
          status, payload_json, requested_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
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
         WHERE task_id = ? AND turn_id = ?
           AND status IN ('PENDING', 'DELIVERY_PENDING')`,
      )
      .run(taskId, turnId);
    return result.changes;
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

  listAudit(filter: { actorUserId?: string } = {}) {
    const rows = filter.actorUserId
      ? (this.sqlite
          .prepare("SELECT * FROM audit_events WHERE actor_user_id = ? ORDER BY created_at DESC")
          .all(filter.actorUserId) as Array<Record<string, unknown>>)
      : (this.sqlite.prepare("SELECT * FROM audit_events ORDER BY created_at DESC").all() as Array<
          Record<string, unknown>
        >);
    return rows.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
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
    accountAlias: row.account_alias,
    leaseId: row.lease_id,
    threadId: row.thread_id,
    currentTurnId: row.current_turn_id,
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
  };
}

function mapEvent(row: EventRow): TaskEvent {
  return {
    taskId: row.task_id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    sequence: row.sequence,
    timestamp: new Date(row.created_at).toISOString(),
    type: row.type,
    payload: JSON.parse(row.payload_json),
  } as TaskEvent;
}

function mapApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    requestId: String(row.request_id),
    taskId: String(row.task_id),
    turnId: String(row.turn_id),
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
