import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type TaskDetail,
  type TaskEvent,
  type TaskEventPayloadMap,
  type TaskEventType,
  type TaskStatus,
  TaskStatusSchema,
  type TaskSummary,
} from "@codexplatform/contracts";
import type { WeeklyQuota } from "../infra/codex/codex-runtime.js";
import type { PlatformApi } from "../web-api.js";
import type { AccountAdminStore, InternalAccount } from "./account-admin-store.js";
import type { LeasedTurn, SQLiteLeaseStore } from "./lease-store.js";
import type {
  ApprovalTransportIdentity,
  SQLitePlatformStore,
  TaskRecord,
} from "./platform-store.js";

export interface RuntimeSafetyPort {
  authorize(userId: string): { allowed: boolean; mode: string; reason?: string };
}

export interface TaskEventDraft<Type extends TaskEventType = TaskEventType> {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  type: Type;
  payload: TaskEventPayloadMap[Type];
  at?: Date;
}

export interface ApprovalDraft {
  requestId: string;
  rawRpcId: number | string;
  accountId: string;
  connectionGeneration: number;
  taskId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  approvalType: "COMMAND" | "FILE_CHANGE" | "PERMISSIONS";
  payload: unknown;
  at?: Date;
}

export class ApprovalTransportUnavailableError extends Error {
  constructor(message = "Codex approval transport is not attached") {
    super(message);
    this.name = "ApprovalTransportUnavailableError";
  }
}

export interface TaskExecutionAdapter {
  startTask(input: {
    accountId: string;
    codexHome: string;
    taskId: string;
    userId: string;
    cwd: string;
    prompt: string;
    existingThreadId: string | null;
  }): Promise<{ threadId: string; turnId: string }>;
  steerTask(threadId: string, turnId: string, prompt: string): Promise<void>;
  interruptTask(threadId: string, turnId: string): Promise<void>;
  respondApproval(
    requestId: string,
    decision: string,
    context: {
      transport: ApprovalTransportIdentity;
      approvalType: ApprovalDraft["approvalType"];
    },
  ): Promise<void>;
  startAccountLogin(account: InternalAccount): Promise<{ loginId: string; authUrl: string }>;
  refreshWeeklyQuota(account: InternalAccount): Promise<WeeklyQuota>;
  on(event: "taskEvent", listener: (event: TaskEventDraft) => void): this;
  on(event: "approval", listener: (event: ApprovalDraft) => void): this;
  on(event: "accountAuthenticated", listener: (event: { accountId: string }) => void): this;
  on(event: "accountAuthFailed", listener: (event: { accountId: string }) => void): this;
  on(event: "accountCrashed", listener: (event: { accountId: string }) => void): this;
  emit(event: "taskEvent", value: TaskEventDraft): boolean;
  emit(event: "approval", value: ApprovalDraft): boolean;
  close(): Promise<void>;
}

interface LocalPlatformServiceOptions {
  store: SQLitePlatformStore;
  leases: SQLiteLeaseStore;
  accounts: AccountAdminStore;
  execution: TaskExecutionAdapter;
  safety: RuntimeSafetyPort;
  dataDir: string;
  now?: () => Date;
}

type BufferedExecutionSignal =
  | { kind: "TASK_EVENT"; value: TaskEventDraft }
  | { kind: "APPROVAL"; value: ApprovalDraft };

const TERMINAL_STATUS_BY_EVENT = {
  TURN_COMPLETED: "COMPLETED",
  TURN_FAILED: "FAILED",
  TURN_INTERRUPTED: "INTERRUPTED",
} as const satisfies Partial<Record<TaskEventType, TaskStatus>>;

export class LocalPlatformService implements PlatformApi {
  private readonly now: () => Date;
  private readonly eventBus = new EventEmitter();
  private readonly schedulerTurnByRuntimeTurn = new Map<string, string>();
  private readonly pendingStartSignalsByTask = new Map<string, BufferedExecutionSignal[]>();

  constructor(private readonly options: LocalPlatformServiceOptions) {
    this.now = options.now ?? (() => new Date());
    options.store.markUndeliverableApprovalsForRecovery();
    options.execution.on("taskEvent", (event) => this.receiveTaskEvent(event));
    options.execution.on("approval", (approval) => this.receiveApproval(approval));
    options.execution.on("accountAuthenticated", ({ accountId }) => {
      options.accounts.markAuthenticated(accountId, this.now());
      void this.refreshAccountQuota(accountId);
    });
    options.execution.on("accountAuthFailed", ({ accountId }) => {
      options.accounts.markReauthenticationRequired(accountId);
    });
    options.execution.on("accountCrashed", ({ accountId }) => {
      options.accounts.setState(accountId, "QUARANTINED");
    });
  }

  async createProject(userId: string, input: { name: string }) {
    return this.options.store.createProject({ ownerId: userId, name: input.name, now: this.now() });
  }

  async listProjects(userId: string) {
    return this.options.store.listProjects(userId);
  }

  async createTask(userId: string, input: { projectId: string; title: string }) {
    return this.options.store.createTask({
      ownerId: userId,
      projectId: input.projectId,
      title: input.title,
      now: this.now(),
    });
  }

  async listTasks(userId: string, projectId?: string) {
    return this.options.store.listTasks(userId, projectId).map(toTaskSummary);
  }

  async getTask(taskId: string, userId: string): Promise<TaskDetail | null> {
    const task = this.options.store.getTaskForUser(taskId, userId);
    if (!task) return null;
    const queued = this.options.leases.getQueueEntry(taskId, userId);
    return {
      ...toTaskSummary(task),
      prompt: this.options.store.getLatestTurnPrompt(taskId, userId),
      accountAlias: task.accountAlias,
      queue: queued
        ? {
            position: queued.position,
            etaMs: queued.etaMs,
            etaEstimated: queued.etaEstimated,
          }
        : null,
    };
  }

  async startTurn(taskId: string, userId: string, prompt: string) {
    const task = this.requireTask(taskId, userId);
    const safety = this.options.safety.authorize(userId);
    if (!safety.allowed) throw new Error(safety.reason ?? "Real Codex execution is not allowed");

    for (const recoverableTurnId of this.options.store.listRecoverableTurnIds(taskId, userId)) {
      this.options.store.completeTurn(recoverableTurnId, "ABANDONED_FOR_RESUME", this.now());
      this.startPromotedTurns(this.options.leases.releaseTurn(recoverableTurnId, this.now()));
    }

    await this.refreshStaleQuotas();
    const schedulerTurnId = randomUUID();
    this.options.store.createTurn({
      id: schedulerTurnId,
      taskId,
      ownerId: userId,
      prompt,
      status: "ALLOCATING",
      now: this.now(),
    });
    const allocation = this.options.leases.acquireTurn({
      userId,
      taskId,
      turnId: schedulerTurnId,
      now: this.now(),
    });
    if (allocation.kind === "QUEUED") {
      this.options.store.setTurnStatus(schedulerTurnId, "QUEUED");
      this.options.store.setTaskQueued(taskId, allocation.ticket, this.now());
      const event = this.options.store.appendTaskEvent({
        taskId,
        threadId: task.threadId,
        turnId: null,
        type: "QUEUED",
        payload: {
          position: allocation.position,
          etaMs: allocation.etaMs,
          etaEstimated: allocation.etaEstimated,
        },
        now: this.now(),
      });
      this.publish(event);
      return { status: "QUEUED", ...allocation };
    }
    return this.startAllocatedTurn(allocation);
  }

  async steerTask(taskId: string, userId: string, prompt: string) {
    const task = this.requireTask(taskId, userId);
    if (!task.threadId || !task.currentTurnId) throw new Error("Task has no active Codex turn");
    await this.options.execution.steerTask(task.threadId, task.currentTurnId, prompt);
    return { status: "RUNNING" };
  }

  async interruptTask(taskId: string, userId: string) {
    const task = this.requireTask(taskId, userId);
    if (!task.threadId || !task.currentTurnId) throw new Error("Task has no active Codex turn");
    await this.options.execution.interruptTask(task.threadId, task.currentTurnId);
    return { status: "INTERRUPTING" };
  }

  async listTaskEvents(taskId: string, userId: string, afterSequence: number) {
    return this.options.store.listTaskEvents(taskId, userId, afterSequence);
  }

  subscribeTaskEvents(taskId: string, listener: (event: TaskEvent) => void): () => void {
    const eventName = `task:${taskId}`;
    this.eventBus.on(eventName, listener);
    return () => this.eventBus.off(eventName, listener);
  }

  async listApprovals(taskId: string, userId: string) {
    return this.options.store.listApprovals(taskId, userId);
  }

  async decideApproval(approvalId: string, userId: string, decision: string) {
    const claim = this.options.store.claimApprovalDelivery({
      approvalId,
      userId,
      decision,
    });
    if (claim.kind === "ALREADY_DELIVERED") return claim.approval;
    try {
      await this.options.execution.respondApproval(claim.approval.requestId, decision, {
        transport: claim.transport,
        approvalType: claim.approval.approvalType as ApprovalDraft["approvalType"],
      });
    } catch (error) {
      if (error instanceof ApprovalTransportUnavailableError) {
        this.options.store.markApprovalDeliveryRecoveryRequired({ approvalId, userId, decision });
      } else {
        this.options.store.releaseApprovalDelivery({ approvalId, userId, decision });
      }
      throw error;
    }
    const approval = this.options.store.completeApprovalDelivery({
      approvalId,
      userId,
      decision,
      now: this.now(),
    });
    this.options.store.setTaskRunningIfCurrentAndUnblocked(
      approval.taskId,
      approval.turnId,
      this.now(),
    );
    const event = this.options.store.appendTaskEvent({
      taskId: approval.taskId,
      threadId: this.options.store.getTaskForUser(approval.taskId, userId)?.threadId ?? null,
      turnId: approval.turnId,
      type: "APPROVAL_DECIDED",
      payload: { approvalId: approval.id, decision },
      now: this.now(),
    });
    this.publish(event);
    return approval;
  }

  async listAccounts() {
    return this.options.accounts.list();
  }

  async addAccount(input: { alias: string }, adminUserId: string) {
    const id = randomUUID();
    this.options.leases.addAccount({
      id,
      alias: input.alias,
      codexHome: join(this.options.dataDir, "codex-accounts", id),
      status: "REAUTH_REQUIRED",
      authStatus: "UNAUTHENTICATED",
      maxActiveUsers: 4,
      weeklyRemaining: null,
      quotaUpdatedAt: null,
      allowUnknownQuota: false,
      healthScore: 100,
    });
    this.options.accounts.recordLifecycleEvent({
      accountId: id,
      actorUserId: adminUserId,
      action: "ACCOUNT_ADDED",
      outcome: "SUCCESS",
      summary: "Codex account added",
      now: this.now(),
    });
    return this.options.accounts.list().find((account) => account.id === id) ?? null;
  }

  async loginAccount(accountId: string, adminUserId: string) {
    const account = this.options.accounts.getInternal(accountId);
    if (!account) throw new Error("Codex account not found");
    try {
      const login = await this.options.execution.startAccountLogin(account);
      this.options.accounts.recordLifecycleEvent({
        accountId,
        actorUserId: adminUserId,
        action: "ACCOUNT_LOGIN_STARTED",
        outcome: "SUCCESS",
        summary: "Codex account login started",
        now: this.now(),
      });
      return login;
    } catch (error) {
      this.options.accounts.recordLifecycleEvent({
        accountId,
        actorUserId: adminUserId,
        action: "ACCOUNT_LOGIN_STARTED",
        outcome: "FAILED",
        summary: "Codex account login could not be started",
        now: this.now(),
      });
      throw error;
    }
  }

  async setAccountState(
    accountId: string,
    state: "DRAINING" | "QUARANTINED" | "AVAILABLE",
    adminUserId: string,
  ) {
    this.options.accounts.setState(accountId, state, {
      actorUserId: adminUserId,
      now: this.now(),
    });
    return this.options.accounts.list().find((account) => account.id === accountId) ?? null;
  }

  async listAudit() {
    return this.options.store.listAudit();
  }

  async runMaintenance(now = this.now()): Promise<void> {
    for (const schedulerTurnId of this.schedulerTurnByRuntimeTurn.values()) {
      this.options.leases.heartbeatTurn(schedulerTurnId, now);
    }
    this.recoverStaleTurns(now);
    await this.refreshStaleQuotas(now);
    this.startPromotedTurns(this.options.leases.releaseIdleLeases(now));
  }

  recoverStaleTurns(now = this.now()): number {
    const stale = this.options.leases.markStaleTurnsForRecovery(now);
    this.persistInterruptedTurns(
      stale,
      "Runtime heartbeat was lost; resume must occur at a Turn boundary.",
      now,
    );
    return stale.length;
  }

  recoverInterruptedTurns(now = this.now()): number {
    const interrupted = new Set(this.options.leases.markAllRunningTurnsForRecovery());
    for (const turnId of this.options.store.listStartupInterruptedTurnIds()) {
      interrupted.add(turnId);
    }
    this.persistInterruptedTurns(
      [...interrupted],
      "The API process restarted; resume must occur at a Turn boundary.",
      now,
    );
    return interrupted.size;
  }

  async close(): Promise<void> {
    this.eventBus.removeAllListeners();
    await this.options.execution.close();
  }

  private requireTask(taskId: string, userId: string) {
    const task = this.options.store.getTaskForUser(taskId, userId);
    if (!task) throw new Error("Task not found");
    return task;
  }

  private receiveTaskEvent(draft: TaskEventDraft): void {
    const pending = this.pendingStartSignalsByTask.get(draft.taskId);
    if (pending) {
      pending.push({ kind: "TASK_EVENT", value: draft });
      return;
    }
    this.handleTaskEvent(draft);
  }

  private receiveApproval(draft: ApprovalDraft): void {
    const pending = this.pendingStartSignalsByTask.get(draft.taskId);
    if (pending) {
      pending.push({ kind: "APPROVAL", value: draft });
      return;
    }
    this.handleApproval(draft);
  }

  private flushPendingStartSignals(taskId: string, pending: BufferedExecutionSignal[]): void {
    if (this.pendingStartSignalsByTask.get(taskId) === pending) {
      this.pendingStartSignalsByTask.delete(taskId);
    }
    for (const signal of pending) {
      if (signal.kind === "TASK_EVENT") this.handleTaskEvent(signal.value);
      else this.handleApproval(signal.value);
    }
  }

  private handleTaskEvent(draft: TaskEventDraft): void {
    const occurredAt = draft.at ?? this.now();
    const schedulerKey = runtimeTurnKey(draft.taskId, draft.turnId);
    const schedulerTurnId = schedulerKey
      ? this.schedulerTurnByRuntimeTurn.get(schedulerKey)
      : undefined;
    if (schedulerTurnId) this.options.leases.heartbeatTurn(schedulerTurnId, occurredAt);
    const event = this.options.store.appendTaskEvent({
      taskId: draft.taskId,
      threadId: draft.threadId,
      turnId: draft.turnId,
      type: draft.type,
      payload: draft.payload,
      now: occurredAt,
    });
    this.publish(event);
    const terminalStatus = TERMINAL_STATUS_BY_EVENT[
      draft.type as keyof typeof TERMINAL_STATUS_BY_EVENT
    ] as "COMPLETED" | "FAILED" | "INTERRUPTED" | undefined;
    if (terminalStatus) {
      if (draft.turnId) {
        this.options.store.markTurnApprovalsForRecovery(draft.taskId, draft.turnId);
      }
      if (schedulerTurnId) {
        this.finishSchedulerTurn(schedulerTurnId, terminalStatus, occurredAt);
      }
      if (schedulerKey) this.schedulerTurnByRuntimeTurn.delete(schedulerKey);
      if (draft.turnId) {
        this.options.store.setTaskInactiveIfCurrent(
          draft.taskId,
          draft.turnId,
          terminalStatus,
          occurredAt,
        );
      }
      return;
    }
    if (draft.type === "RECOVERY_REQUIRED") {
      if (draft.turnId) {
        this.options.store.markTurnApprovalsForRecovery(draft.taskId, draft.turnId);
      }
      if (schedulerTurnId) {
        this.finishSchedulerTurn(schedulerTurnId, "NEEDS_RECOVERY", occurredAt);
      }
      if (schedulerKey) this.schedulerTurnByRuntimeTurn.delete(schedulerKey);
      if (draft.turnId) {
        this.options.store.setTaskInactiveIfCurrent(
          draft.taskId,
          draft.turnId,
          "NEEDS_RECOVERY",
          occurredAt,
        );
      }
    }
  }

  private finishSchedulerTurn(
    schedulerTurnId: string,
    status: "COMPLETED" | "FAILED" | "INTERRUPTED" | "NEEDS_RECOVERY",
    finishedAt: Date,
  ): void {
    const durationMs = this.options.store.completeTurn(schedulerTurnId, status, finishedAt);
    if (durationMs !== null) this.options.leases.recordTurnDuration(durationMs, finishedAt);
    this.startPromotedTurns(this.options.leases.releaseTurn(schedulerTurnId, finishedAt));
  }

  private persistInterruptedTurns(schedulerTurnIds: string[], reason: string, now: Date): void {
    for (const schedulerTurnId of schedulerTurnIds) {
      const turn = this.options.store.getTurn(schedulerTurnId);
      if (!turn) {
        this.startPromotedTurns(this.options.leases.releaseTurn(schedulerTurnId, now));
        continue;
      }
      this.options.store.setTurnStatus(schedulerTurnId, "NEEDS_RECOVERY");
      const task = this.options.store.getTaskForUser(turn.taskId, turn.ownerId);
      if (!task) continue;
      const codexTurnId = turn.codexTurnId ?? task.currentTurnId;
      if (codexTurnId) {
        this.options.store.markTurnApprovalsForRecovery(turn.taskId, codexTurnId);
      }
      const schedulerKey = runtimeTurnKey(turn.taskId, codexTurnId);
      if (schedulerKey) this.schedulerTurnByRuntimeTurn.delete(schedulerKey);
      this.options.store.setTaskInactive(turn.taskId, "NEEDS_RECOVERY", now);
      const event = this.options.store.appendTaskEvent({
        taskId: turn.taskId,
        threadId: task.threadId,
        turnId: codexTurnId,
        type: "RECOVERY_REQUIRED",
        payload: { reason },
        now,
      });
      this.publish(event);
      this.startPromotedTurns(this.options.leases.releaseTurn(schedulerTurnId, now));
    }
  }

  private handleApproval(draft: ApprovalDraft): void {
    const payload =
      draft.payload && typeof draft.payload === "object" && !Array.isArray(draft.payload)
        ? (draft.payload as Record<string, unknown>)
        : {};
    const approval = this.options.store.createApproval({
      requestId: draft.requestId,
      rawRpcId: draft.rawRpcId,
      accountId: draft.accountId,
      connectionGeneration: draft.connectionGeneration,
      threadId: draft.threadId,
      taskId: draft.taskId,
      turnId: draft.turnId,
      itemId: draft.itemId,
      approvalType: draft.approvalType,
      payload: draft.payload,
      now: draft.at ?? this.now(),
    });
    const actionable = this.options.store.setTaskWaitingApprovalIfCurrent(
      draft.taskId,
      draft.turnId,
      draft.at ?? this.now(),
    );
    if (!actionable) {
      this.options.store.markTurnApprovalsForRecovery(draft.taskId, draft.turnId);
    }
    const event = this.options.store.appendTaskEvent({
      taskId: draft.taskId,
      threadId: draft.threadId,
      turnId: draft.turnId,
      type: "APPROVAL_REQUESTED",
      payload: {
        approvalId: approval.id,
        itemId: draft.itemId,
        approvalType: draft.approvalType,
        reason: typeof payload.reason === "string" ? payload.reason : null,
        ...(draft.approvalType === "COMMAND"
          ? {
              command: typeof payload.command === "string" ? payload.command : null,
              cwd: typeof payload.cwd === "string" ? payload.cwd : null,
            }
          : {}),
      },
      now: draft.at ?? this.now(),
    });
    this.publish(event);
  }

  private publish(event: TaskEvent): void {
    this.eventBus.emit(`task:${event.taskId}`, event);
  }

  private async startAllocatedTurn(allocation: LeasedTurn) {
    const queuedTurn = this.options.store.getTurn(allocation.turnId);
    if (!queuedTurn) {
      const promoted = this.options.leases.releaseTurn(allocation.turnId, this.now());
      this.startPromotedTurns(promoted);
      throw new Error("Allocated turn no longer exists");
    }
    const task = this.requireTask(queuedTurn.taskId, queuedTurn.ownerId);
    const account = this.options.accounts.getInternal(allocation.accountId);
    if (!account) {
      const error = new Error("Allocated Codex account no longer exists");
      this.failAllocatedTurn(allocation);
      throw error;
    }
    const cwd = join(this.options.dataDir, "workspaces", queuedTurn.taskId);
    const pendingSignals: BufferedExecutionSignal[] = [];
    if (this.pendingStartSignalsByTask.has(queuedTurn.taskId)) {
      this.failAllocatedTurn(allocation);
      throw new Error("Task execution is already starting");
    }
    this.pendingStartSignalsByTask.set(queuedTurn.taskId, pendingSignals);

    try {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const started = await this.options.execution.startTask({
        accountId: account.id,
        codexHome: account.codexHome,
        taskId: queuedTurn.taskId,
        userId: queuedTurn.ownerId,
        cwd,
        prompt: queuedTurn.prompt,
        existingThreadId: task.threadId,
      });
      this.schedulerTurnByRuntimeTurn.set(
        runtimeTurnKey(queuedTurn.taskId, started.turnId) as string,
        allocation.turnId,
      );
      this.options.store.bindTurnRuntime(allocation.turnId, started.turnId, this.now());
      this.options.store.bindTaskRuntime(queuedTurn.taskId, {
        accountId: account.id,
        accountAlias: account.alias,
        leaseId: allocation.leaseId,
        threadId: started.threadId,
        now: this.now(),
      });
      this.options.store.setCurrentTurn(queuedTurn.taskId, started.turnId, "RUNNING", this.now());
      const event = this.options.store.appendTaskEvent({
        taskId: queuedTurn.taskId,
        threadId: started.threadId,
        turnId: started.turnId,
        type: "LEASE_ACQUIRED",
        payload: { accountAlias: account.alias },
        now: this.now(),
      });
      this.publish(event);
      this.flushPendingStartSignals(queuedTurn.taskId, pendingSignals);
      const reconciledTask = this.options.store.getTaskForUser(
        queuedTurn.taskId,
        queuedTurn.ownerId,
      );
      return {
        status: reconciledTask?.status ?? "RUNNING",
        accountAlias: account.alias,
        threadId: started.threadId,
        turnId: started.turnId,
      };
    } catch (error) {
      if (this.pendingStartSignalsByTask.get(queuedTurn.taskId) === pendingSignals) {
        this.pendingStartSignalsByTask.delete(queuedTurn.taskId);
      }
      this.failAllocatedTurn(allocation);
      throw error;
    }
  }

  private startPromotedTurns(promoted: LeasedTurn[]): void {
    for (const turn of promoted) {
      void this.startAllocatedTurn(turn).catch(() => undefined);
    }
  }

  private failAllocatedTurn(allocation: LeasedTurn): void {
    const failedAt = this.now();
    const persisted = this.options.store.getTurn(allocation.turnId);
    if (persisted) {
      this.options.store.completeTurn(allocation.turnId, "NEEDS_RECOVERY", failedAt);
      const task = this.options.store.getTaskForUser(persisted.taskId, persisted.ownerId);
      if (task) {
        this.options.store.setTaskInactive(persisted.taskId, "NEEDS_RECOVERY", failedAt);
        const event = this.options.store.appendTaskEvent({
          taskId: persisted.taskId,
          threadId: task.threadId,
          turnId: persisted.codexTurnId,
          type: "RECOVERY_REQUIRED",
          payload: {
            reason: "Codex Turn could not be started; explicit recovery is required.",
          },
          now: failedAt,
        });
        this.publish(event);
      }
    }
    this.startPromotedTurns(this.options.leases.releaseTurn(allocation.turnId, failedAt));
  }

  private async refreshStaleQuotas(observedAt = this.now()): Promise<void> {
    const now = observedAt.getTime();
    const stale = this.options.accounts
      .list()
      .filter(
        (account) =>
          account.authStatus === "AUTHENTICATED" &&
          (!account.quotaUpdatedAt ||
            now - new Date(account.quotaUpdatedAt).getTime() > 5 * 60_000),
      );
    await Promise.all(stale.map((account) => this.refreshAccountQuota(account.id, observedAt)));
  }

  private async refreshAccountQuota(accountId: string, observedAt = this.now()): Promise<void> {
    const account = this.options.accounts.getInternal(accountId);
    if (!account) return;
    try {
      const quota = await this.options.execution.refreshWeeklyQuota(account);
      this.options.accounts.updateWeeklyQuota(accountId, {
        remainingPercent: quota.status === "KNOWN" ? quota.remainingPercent : null,
        resetsAt:
          quota.status === "KNOWN" && quota.resetsAt !== null
            ? normalizeResetTimestamp(quota.resetsAt)
            : null,
        observedAt,
      });
    } catch {
      this.options.accounts.setState(accountId, "QUARANTINED");
    }
  }
}

function normalizeResetTimestamp(value: number): Date {
  return new Date(value < 10_000_000_000 ? value * 1_000 : value);
}

function runtimeTurnKey(taskId: string, turnId: string | null): string | null {
  return turnId ? `${taskId}:${turnId}` : null;
}

function toTaskSummary(task: TaskRecord): TaskSummary {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: TaskStatusSchema.parse(task.status),
    updatedAt: task.updatedAt,
  };
}
