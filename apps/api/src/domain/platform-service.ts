import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  type ActorContext,
  type Bootstrap,
  type BrowserDraftAttachment,
  BrowserDraftAttachmentSchema,
  type CollaborationModePreset,
  type ComposerCapability,
  type ComposerState,
  type ComposerStatePatch,
  type DraftAttachment,
  type EffectiveConfigOverride,
  EffectiveConfigOverrideSchema,
  type EffectiveThreadConfigSnapshot,
  EffectiveThreadConfigSnapshotSchema,
  type ModelCatalog,
  ModelCatalogSchema,
  type ModelOption,
  ModelOptionSchema,
  PLATFORM_VERSION,
  type SubagentThread,
  type SubagentThreadDetail,
  type TaskDetail,
  type TaskEvent,
  type TaskEventPayloadMap,
  type TaskEventType,
  type TaskStatus,
  TaskStatusSchema,
  type TaskSummary,
  type Thread,
  type ThreadGoalInput,
  ThreadGoalInputSchema,
  type ThreadGoalPatch,
  ThreadGoalPatchSchema,
  type ThreadGoalSnapshot,
  type ThreadGoalView,
  ThreadGoalViewSchema,
  type ThreadItem,
  TurnStatusSchema,
  type UserSettings,
  type UserSettingsPatch,
  type UserSettingsView,
} from "@codexplatform/contracts";
import type { WeeklyQuota } from "../infra/codex/codex-runtime.js";
import { RpcError } from "../infra/codex/jsonl-rpc-client.js";
import type { PlatformApi } from "../web-api.js";
import type { AccountAdminStore, InternalAccount } from "./account-admin-store.js";
import {
  type AttachmentScanner,
  BasicAttachmentScanner,
  MAX_FOLDER_FILES,
  MAX_TURN_ATTACHMENT_BYTES,
} from "./attachments.js";
import { listComposerCapabilities as buildComposerCapabilities } from "./composer-capabilities.js";
import {
  GoalCapabilityUnavailableError,
  GoalMutationBlockedByPendingTurnError,
  PlanModeCapabilityChangedError,
  PlanPresetModelUnavailableError,
} from "./errors.js";
import type { LeasedTurn, SQLiteLeaseStore } from "./lease-store.js";
import type {
  ApprovalTransportIdentity,
  AttachmentCleanupJob,
  SQLitePlatformStore,
  StoredThreadGoalView,
  TaskRecord,
  TurnRecord,
} from "./platform-store.js";

export interface RuntimeSafetyPort {
  authorize(userId: string): { allowed: boolean; mode: string; reason?: string };
}

export interface TaskEventDraft<Type extends TaskEventType = TaskEventType> {
  taskId: string;
  threadId: string | null;
  turnId: string | null;
  /** Present only for events that belong to a child Agent Thread. */
  subagentThreadId?: string;
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
  parentTurnId?: string;
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

export class ModelCatalogUnavailableError extends Error {
  constructor(message = "Runtime model catalog is unavailable") {
    super(message);
    this.name = "ModelCatalogUnavailableError";
  }
}

class NoRoutableModelAccountError extends ModelCatalogUnavailableError {
  constructor() {
    super("No routable Codex account has a model catalog");
    this.name = "NoRoutableModelAccountError";
  }
}

class AllocatedAccountIneligibleError extends Error {
  constructor() {
    super("Allocated Codex account is no longer eligible for Runtime start");
    this.name = "AllocatedAccountIneligibleError";
  }
}

export class AllocatedModelSelectionChangedError extends Error {
  constructor(message = "Model availability changed after allocation; submit the Turn again") {
    super(message);
    this.name = "AllocatedModelSelectionChangedError";
  }
}

interface PreRuntimeFailure {
  code: string;
  publicMessage: string;
}

export abstract class ThreadResumeSafetyError extends Error {
  abstract readonly code: string;
  readonly promptAccepted = false;
  readonly rejoined = false;

  constructor(
    readonly threadId: string,
    readonly turnId: string | null,
    message: string,
  ) {
    super(message);
  }
}

export class ActiveTurnResumeConflictError extends ThreadResumeSafetyError {
  readonly code = "ACTIVE_TURN_RESUME_CONFLICT";

  constructor(
    threadId: string,
    turnId: string | null,
    message = "Thread already has an active Turn; the new prompt was not accepted",
  ) {
    super(threadId, turnId, message);
    this.name = "ActiveTurnResumeConflictError";
  }
}

export class InvalidThreadResumeResponseError extends ThreadResumeSafetyError {
  readonly code = "INVALID_THREAD_RESUME_RESPONSE";

  constructor(
    threadId: string,
    message = "Thread resume response is unsafe; the new prompt was not accepted",
  ) {
    super(threadId, null, message);
    this.name = "InvalidThreadResumeResponseError";
  }
}

export interface GoalRuntimeCapability {
  availability: "AVAILABLE" | "UNAVAILABLE";
  reasonCode: string | null;
  reason: string | null;
}

export interface PlanModeCatalogCapability {
  availability: "AVAILABLE" | "UNAVAILABLE";
  reasonCode: string | null;
  reason: string | null;
  presets: CollaborationModePreset[];
}

export type AttachedGoalRuntimeResult<T> =
  | { attachment: "DETACHED" }
  | ({ attachment: "ATTACHED" } & T);

export interface RuntimeGoalProjection {
  goal: ThreadGoalSnapshot | null;
  runtimeUpdatedAt: number | null;
}

export interface TaskExecutionAdapter {
  listModels(account: InternalAccount): Promise<ModelOption[]>;
  readGoalCapability(account: InternalAccount): Promise<GoalRuntimeCapability>;
  readPlanModeCatalog(
    account: InternalAccount,
    requested?: { model: string | null; reasoningEffort: string },
  ): Promise<PlanModeCatalogCapability>;
  setThreadGoal(
    threadId: string,
    goal: ThreadGoalSnapshot,
  ): Promise<AttachedGoalRuntimeResult<RuntimeGoalProjection>>;
  getThreadGoal(threadId: string): Promise<AttachedGoalRuntimeResult<RuntimeGoalProjection>>;
  clearThreadGoal(threadId: string): Promise<AttachedGoalRuntimeResult<{ cleared: boolean }>>;
  syncThreadGoal(
    threadId: string,
    goal: ThreadGoalSnapshot,
  ): Promise<AttachedGoalRuntimeResult<RuntimeGoalProjection>>;
  startTask(input: {
    accountId: string;
    codexHome: string;
    taskId: string;
    userId: string;
    cwd: string;
    prompt: string;
    existingThreadId: string | null;
    effectiveConfig: EffectiveThreadConfigSnapshot;
    actorContext: ActorContext;
    goal?: ThreadGoalSnapshot | null;
    onThreadPrepared?(threadId: string): void;
    attachments?: Array<{ name: string; path: string; mimeType: string }>;
  }): Promise<{ threadId: string; turnId: string }>;
  steerTask(
    threadId: string,
    turnId: string,
    prompt: string,
    attachments?: Array<{ name: string; path: string; mimeType: string }>,
  ): Promise<void>;
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
  on(
    event: "accountQuotaUpdated",
    listener: (event: { accountId: string; quota: WeeklyQuota }) => void,
  ): this;
  on(
    event: "goalUpdated",
    listener: (event: {
      taskId: string;
      threadId: string;
      status: ThreadGoalView["status"];
      tokensUsed: number;
      timeUsedSeconds: number;
      runtimeUpdatedAt: number;
    }) => void,
  ): this;
  on(event: "goalCleared", listener: (event: { taskId: string; threadId: string }) => void): this;
  on(
    event: "accountCrashed",
    listener: (event: {
      accountId: string;
      reason?: string;
      sourceTaskId?: string;
      sourceRuntimeTurnId?: string;
    }) => void,
  ): this;
  emit(event: "taskEvent", value: TaskEventDraft): boolean;
  emit(event: "approval", value: ApprovalDraft): boolean;
  emit(event: "accountQuotaUpdated", value: { accountId: string; quota: WeeklyQuota }): boolean;
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
  attachmentScanner?: AttachmentScanner;
}

type BufferedExecutionSignal =
  | { kind: "TASK_EVENT"; value: TaskEventDraft }
  | { kind: "APPROVAL"; value: ApprovalDraft };

interface CachedAccountModelCatalog {
  models: ModelOption[];
  observedAt: Date;
  expiresAt: Date;
}

interface AccountModelCatalogRead {
  models: ModelOption[];
  observedAt: Date;
  stale: boolean;
}

const TERMINAL_STATUS_BY_EVENT = {
  TURN_COMPLETED: "COMPLETED",
  TURN_FAILED: "FAILED",
  TURN_INTERRUPTED: "INTERRUPTED",
} as const satisfies Partial<Record<TaskEventType, TaskStatus>>;

const SUBAGENT_TERMINAL_STATUS_BY_EVENT: Partial<
  Record<TaskEventType, "DONE" | "FAILED" | "INTERRUPTED">
> = {
  TURN_COMPLETED: "DONE",
  TURN_FAILED: "FAILED",
  TURN_INTERRUPTED: "INTERRUPTED",
  RECOVERY_REQUIRED: "FAILED",
};

export class LocalPlatformService implements PlatformApi {
  private readonly now: () => Date;
  private readonly eventBus = new EventEmitter();
  private readonly schedulerTurnByRuntimeTurn = new Map<string, string>();
  private readonly pendingStartSignalsByTask = new Map<string, BufferedExecutionSignal[]>();
  private readonly quotaRefreshByAccount = new Map<string, Promise<void>>();
  private readonly modelCatalogByAccount = new Map<string, CachedAccountModelCatalog>();
  private readonly modelCatalogRefreshByAccount = new Map<
    string,
    Promise<CachedAccountModelCatalog>
  >();
  private readonly modelCatalogGenerationByAccount = new Map<string, number>();
  private readonly modelCatalogCooldownUntilByAccount = new Map<string, Date>();
  private readonly goalMutationTailByThread = new Map<string, Promise<void>>();

  constructor(private readonly options: LocalPlatformServiceOptions) {
    this.now = options.now ?? (() => new Date());
    options.store.markUndeliverableApprovalsForRecovery();
    options.execution.on("taskEvent", (event) => this.receiveTaskEvent(event));
    options.execution.on("approval", (approval) => this.receiveApproval(approval));
    options.execution.on("accountAuthenticated", ({ accountId }) => {
      this.invalidateAccountModelCatalog(accountId);
      options.accounts.markAuthenticated(accountId, this.now());
      void this.refreshAccountQuota(accountId);
    });
    options.execution.on("accountAuthFailed", ({ accountId }) => {
      this.invalidateAccountModelCatalog(accountId);
      options.accounts.markReauthenticationRequired(accountId);
    });
    options.execution.on(
      "accountQuotaUpdated",
      ({ accountId, quota }: { accountId: string; quota: WeeklyQuota }) => {
        if (quota.status !== "KNOWN" || !options.accounts.getInternal(accountId)) return;
        this.storeWeeklyQuota(accountId, quota, this.now());
      },
    );
    options.execution.on("accountCrashed", ({ accountId, reason }) => {
      this.invalidateAccountModelCatalog(accountId);
      const occurredAt = this.now();
      const recoveryReason = reason ?? "Codex App Server exited; recovery is required.";
      const recovered = options.store.recoverAccountRuntimeState(accountId, occurredAt);
      for (const task of recovered) {
        if (task.runtimeTurnId) {
          const key = runtimeTurnKey(task.taskId, task.runtimeTurnId);
          if (key) this.schedulerTurnByRuntimeTurn.delete(key);
        }
        this.pendingStartSignalsByTask.delete(task.taskId);
        const event = options.store.appendTaskEvent({
          taskId: task.taskId,
          threadId: task.runtimeThreadId,
          turnId: task.platformTurnId,
          type: "RECOVERY_REQUIRED",
          payload: { reason: recoveryReason },
          now: occurredAt,
        });
        this.publish(event);
      }
      this.startPromotedTurns(options.leases.promoteQueue(occurredAt));
    });
    options.execution.on("goalUpdated", (event) => {
      const ownerId = options.store.getTaskOwnerId(event.taskId);
      if (!ownerId || !options.store.getThreadGoal(event.taskId, ownerId)) return;
      options.store.syncThreadGoal({
        threadId: event.taskId,
        ownerId,
        runtimeThreadId: event.threadId,
        status: event.status,
        tokensUsed: event.tokensUsed,
        timeUsedSeconds: event.timeUsedSeconds,
        runtimeUpdatedAt: event.runtimeUpdatedAt,
        now: this.now(),
      });
    });
    options.execution.on("goalCleared", ({ taskId }) => {
      const ownerId = options.store.getTaskOwnerId(taskId);
      if (ownerId && options.store.getThreadGoal(taskId, ownerId)) {
        options.store.markThreadGoalRecovery(taskId, ownerId, this.now());
      }
    });
  }

  async createProject(userId: string, input: { name: string }) {
    return this.options.store.createProject({ ownerId: userId, name: input.name, now: this.now() });
  }

  async listProjects(userId: string) {
    return this.options.store.listProjects(userId);
  }

  async getBootstrap(): Promise<Bootstrap> {
    return {
      platformVersion: PLATFORM_VERSION,
      defaultMode: "CODEX" as const,
      enabledModes: ["CODEX"],
      capabilities: {
        threads: true as const,
        settings: true as const,
        subagents: true as const,
        reasoningSummaries: true as const,
      },
    };
  }

  async listModels(userId: string, threadId?: string): Promise<ModelCatalog> {
    return this.readModelCatalogForUser(userId, threadId, true);
  }

  private async readModelCatalogForUser(
    userId: string,
    threadId: string | undefined,
    allowStale: boolean,
  ): Promise<ModelCatalog> {
    this.options.store.getUserIdentity(userId);
    let requiredAccountId: string | null = null;
    if (threadId) {
      const task = this.options.store.getTaskForUser(threadId, userId);
      if (!task) throw new Error("Thread not found");
      if (task.threadId && !task.accountId) {
        throw new ModelCatalogUnavailableError("Thread runtime account binding is missing");
      }
      requiredAccountId = task.accountId;
    }

    const accountIds = this.options.leases.listModelRoutingAccountIdsForUser(
      userId,
      this.now(),
      requiredAccountId,
    );
    if (accountIds.length === 0) {
      throw new NoRoutableModelAccountError();
    }

    const catalogs = await Promise.all(
      accountIds.map(async (accountId) => {
        const account = this.options.accounts.getInternal(accountId);
        if (!account) {
          throw new ModelCatalogUnavailableError("Eligible Codex account is unavailable");
        }
        return this.readAccountModelCatalog(account, { allowStale });
      }),
    );
    if (accountIds.some((accountId) => !this.isAccountModelRoutingEligible(userId, accountId))) {
      throw new ModelCatalogUnavailableError();
    }
    const observedAt = new Date(
      Math.min(...catalogs.map((catalog) => catalog.observedAt.getTime())),
    ).toISOString();
    const models =
      catalogs.length === 1
        ? (catalogs[0]?.models ?? [])
        : intersectAccountModelCatalogs(catalogs.map((catalog) => catalog.models));

    return ModelCatalogSchema.parse({
      models,
      scope: requiredAccountId ? "SINGLE_ACCOUNT" : "ELIGIBLE_ACCOUNT_INTERSECTION",
      accountCount: accountIds.length,
      observedAt,
      stale: catalogs.some((catalog) => catalog.stale),
    });
  }

  async createTask(userId: string, input: { projectId: string; title: string }) {
    return this.options.store.createTask({
      ownerId: userId,
      projectId: input.projectId,
      title: input.title,
      now: this.now(),
    });
  }

  async listComposerCapabilities(userId: string, threadId?: string): Promise<ComposerCapability[]> {
    const task = threadId ? this.options.store.getTaskForUser(threadId, userId) : null;
    if (threadId && !task) throw new Error("Thread not found");
    const goalCapability = await this.readGoalCapabilityForUser(userId, task?.accountId ?? null);
    const planCapability = await this.readPlanCapabilityForUser(userId, task?.accountId ?? null);
    return buildComposerCapabilities({
      stagingAvailable: true,
      goalAvailable: goalCapability.availability === "AVAILABLE",
      goalUnavailableReason:
        goalCapability.reason ?? "Goal protocol is unavailable for this Runtime",
      ...(goalCapability.reasonCode
        ? { goalUnavailableReasonCode: goalCapability.reasonCode }
        : {}),
      planModeAvailable: planCapability.availability === "AVAILABLE",
      planModeUnavailableReason:
        planCapability.reason ?? "Plan mode is unavailable for this Runtime",
      ...(planCapability.reasonCode
        ? { planModeUnavailableReasonCode: planCapability.reasonCode }
        : {}),
      skillRecorderAvailable: false,
      skillRecorderUnavailableReason: "Requires an isolated Computer Use Worker",
      approvedSkills: [],
      approvedApps: [],
      recentThreads: [],
    });
  }

  async patchThreadComposer(
    threadId: string,
    userId: string,
    patch: ComposerStatePatch,
  ): Promise<ComposerState> {
    const task = this.requireTask(threadId, userId);
    if (patch.planMode) {
      const capability = await this.readPlanCapabilityForUser(userId, task.accountId);
      if (capability.availability !== "AVAILABLE") {
        throw new PlanModeCapabilityChangedError();
      }
    }
    return this.options.store.patchComposerState({
      threadId,
      ownerId: userId,
      planMode: patch.planMode,
      expectedRevision: patch.revision,
      now: this.now(),
    });
  }

  async createDraft(userId: string, input: { projectId: string }) {
    return this.options.store.createDraft({
      ownerId: userId,
      projectId: input.projectId,
      now: this.now(),
      expiresAt: new Date(this.now().getTime() + 60 * 60_000),
    });
  }

  async getDraft(
    threadId: string,
    userId: string,
  ): Promise<{ id: string; projectId: string; lifecycleState: "DRAFT" } | null> {
    const task = this.options.store.getTaskForUser(threadId, userId);
    return task?.lifecycleState === "DRAFT"
      ? { id: task.id, projectId: task.projectId, lifecycleState: "DRAFT" }
      : null;
  }

  async getThreadComposer(threadId: string, userId: string): Promise<ComposerState | null> {
    return this.options.store.getComposerState(threadId, userId);
  }

  async deleteDraft(threadId: string, userId: string): Promise<void> {
    this.options.store.deleteDraft(threadId, userId, this.now());
    await this.processAttachmentCleanupJobs(this.now());
  }

  async cleanupExpiredDrafts(now = this.now()): Promise<number> {
    const expired = this.options.store.expireDrafts(now);
    await this.processAttachmentCleanupJobs(now);
    return expired.length;
  }

  async uploadAttachment(
    threadId: string,
    userId: string,
    input: {
      files: Array<{ name: string; relativePath: string; mimeType: string; content: Buffer }>;
    },
  ): Promise<BrowserDraftAttachment> {
    const task = this.options.store.getTaskForUser(threadId, userId);
    if (!task || task.lifecycleState === "EXPIRED") throw new Error("Thread not found");
    if (task.archivedAt) throw new Error("Thread is archived");
    if (input.files.length === 0) throw new Error("Missing attachment file");
    if (input.files.length > MAX_FOLDER_FILES) throw new Error("Folder exceeds the 500 file limit");
    const totalBytes = input.files.reduce((sum, file) => sum + file.content.byteLength, 0);
    if (totalBytes > MAX_TURN_ATTACHMENT_BYTES) {
      throw new Error("Attachments exceed the 200 MiB Turn limit");
    }
    const scanner = this.options.attachmentScanner ?? new BasicAttachmentScanner();
    const scannedFiles = await Promise.all(
      input.files.map(async (file) => {
        const scan = await scanner.scan({
          name: file.name,
          relativePath: file.relativePath,
          mimeType: file.mimeType,
          sizeBytes: file.content.byteLength,
          content: file.content,
        });
        if (scan.status !== "READY") throw new Error(scan.reason);
        return { ...file, relativePath: scan.normalizedRelativePath };
      }),
    );
    if (new Set(scannedFiles.map((file) => file.relativePath)).size !== scannedFiles.length) {
      throw new Error("Duplicate attachment path");
    }
    const attachmentId = randomUUID();
    const attachmentRoot = join(
      this.options.dataDir,
      "workspaces",
      threadId,
      ".codexplatform",
      "attachments",
      attachmentId,
    );
    let stagingPrepared = false;
    const isFolder = scannedFiles.length > 1 || scannedFiles[0]?.relativePath.includes("/");
    const commonRoot = commonAttachmentRoot(scannedFiles.map((file) => file.relativePath));
    const relativePath = isFolder
      ? join(".codexplatform", "attachments", attachmentId, ...(commonRoot ? [commonRoot] : []))
      : join(
          ".codexplatform",
          "attachments",
          attachmentId,
          scannedFiles[0]?.relativePath as string,
        );
    try {
      await prepareSafeAttachmentRoot(this.options.dataDir, threadId, attachmentId);
      stagingPrepared = true;
      for (const file of scannedFiles) {
        await writeSafeAttachmentFile(attachmentRoot, file.relativePath, file.content);
      }
      const stored = this.options.store.createAttachment({
        id: attachmentId,
        threadId,
        ownerId: userId,
        kind: isFolder ? "FOLDER" : "FILE",
        name: isFolder
          ? (commonRoot ?? "attachments")
          : basename(scannedFiles[0]?.relativePath as string),
        relativePath,
        mimeType: isFolder ? "application/x-directory" : (scannedFiles[0]?.mimeType as string),
        sizeBytes: totalBytes,
        fileCount: scannedFiles.length,
        scanStatus: "READY",
        now: this.now(),
      });
      return projectBrowserAttachment(stored);
    } catch (error) {
      if (stagingPrepared) {
        await removeSafeAttachmentRoot(this.options.dataDir, threadId, attachmentId);
      }
      throw error;
    }
  }

  async deleteAttachment(threadId: string, attachmentId: string, userId: string): Promise<void> {
    this.options.store.deleteAttachment(attachmentId, threadId, userId, this.now());
    await this.processAttachmentCleanupJobs(this.now());
  }

  async listAttachments(threadId: string, userId: string): Promise<BrowserDraftAttachment[]> {
    return this.options.store
      .listUnclaimedAttachments(threadId, userId)
      .map(projectBrowserAttachment);
  }

  async getThreadGoal(threadId: string, userId: string): Promise<ThreadGoalView | null> {
    return this.options.store.getThreadGoal(threadId, userId);
  }

  async putThreadGoal(
    threadId: string,
    userId: string,
    input: ThreadGoalInput,
  ): Promise<ThreadGoalView> {
    return this.withGoalMutationLock(threadId, async () => {
      const task = this.requireTask(threadId, userId);
      await this.ensureGoalCapability(userId, task.accountId);
      await this.interruptGoalMutationTurn(task);
      const parsed = ThreadGoalInputSchema.parse(input);
      const pending = this.options.store.putThreadGoal({
        threadId,
        ownerId: userId,
        ...parsed,
        now: this.now(),
      });
      return this.synchronizeStoredGoal(task, userId, pending);
    });
  }

  async patchThreadGoal(
    threadId: string,
    userId: string,
    patch: ThreadGoalPatch,
  ): Promise<ThreadGoalView> {
    return this.withGoalMutationLock(threadId, async () => {
      const task = this.requireTask(threadId, userId);
      await this.ensureGoalCapability(userId, task.accountId);
      await this.interruptGoalMutationTurn(task);
      const pending = this.options.store.patchThreadGoal({
        threadId,
        ownerId: userId,
        patch: ThreadGoalPatchSchema.parse(patch),
        now: this.now(),
      });
      return this.synchronizeStoredGoal(task, userId, pending);
    });
  }

  async deleteThreadGoal(
    threadId: string,
    userId: string,
  ): Promise<{ cleared: true; runtimeSyncState: "PENDING" | "SYNCED" }> {
    return this.withGoalMutationLock(threadId, async () => {
      const task = this.requireTask(threadId, userId);
      const current = this.options.store.getThreadGoal(threadId, userId);
      if (!current) throw new Error("Goal not found");
      await this.ensureGoalCapability(userId, task.accountId);
      await this.interruptGoalMutationTurn(task);
      const deletion = this.options.store.deleteThreadGoalMutation(threadId, userId, this.now());
      if (!deletion.deleted) throw new Error("Goal not found");
      if (!task.threadId) {
        this.options.store.finalizeThreadGoalDelete({
          threadId,
          ownerId: userId,
          expectedRevision: deletion.revision,
          runtimeSyncState: "PENDING",
          now: this.now(),
        });
        return { cleared: true, runtimeSyncState: "PENDING" };
      }
      try {
        const cleared = await this.options.execution.clearThreadGoal(task.threadId);
        if (cleared.attachment === "DETACHED") {
          this.options.store.finalizeThreadGoalDelete({
            threadId,
            ownerId: userId,
            expectedRevision: deletion.revision,
            runtimeSyncState: "PENDING",
            now: this.now(),
          });
          return { cleared: true, runtimeSyncState: "PENDING" };
        }
        const verified = await this.options.execution.getThreadGoal(task.threadId);
        if (verified.attachment !== "ATTACHED" || verified.goal !== null) {
          throw new Error("Runtime Goal remained present after clear");
        }
        this.options.store.finalizeThreadGoalDelete({
          threadId,
          ownerId: userId,
          expectedRevision: deletion.revision,
          runtimeSyncState: "SYNCED",
          now: this.now(),
        });
        return { cleared: true, runtimeSyncState: "SYNCED" };
      } catch (error) {
        this.options.store.markThreadGoalRecovery(threadId, userId, this.now());
        throw error;
      }
    });
  }

  async listTasks(userId: string, projectId?: string) {
    return this.options.store.listTasks(userId, projectId).map(toTaskSummary);
  }

  async getTask(taskId: string, userId: string): Promise<TaskDetail | null> {
    const task = this.options.store.getTaskForUser(taskId, userId);
    if (task?.lifecycleState !== "ACTIVE") return null;
    const queued = this.options.leases.getQueueEntry(taskId, userId);
    return {
      ...toTaskSummary(task),
      prompt: this.options.store.getLatestTurnPrompt(taskId, userId),
      accountAlias: null,
      queue: queued
        ? {
            position: queued.position,
            etaMs: queued.etaMs,
            etaEstimated: queued.etaEstimated,
          }
        : null,
    };
  }

  async createThread(
    userId: string,
    input: { projectId: string; title: string; config?: EffectiveConfigOverride },
  ) {
    const threadConfig = input.config ? this.validateConfigOverride(input.config) : null;
    if (threadConfig) {
      const effectiveConfig = this.resolveEffectiveConfig(userId, threadConfig, null);
      if (
        effectiveConfig.model !== null ||
        threadConfig.model !== undefined ||
        threadConfig.reasoningEffort !== undefined
      ) {
        await this.resolveAndValidateModelSelection(userId, null, effectiveConfig);
      }
    }
    const task = this.options.store.createTask({
      ownerId: userId,
      projectId: input.projectId,
      title: input.title,
      threadConfig,
      now: this.now(),
    });
    return (await this.getThread(task.id, userId)) as Thread;
  }

  async listThreads(userId: string, projectId?: string): Promise<Thread[]> {
    return Promise.all(
      this.options.store
        .listTasks(userId, projectId)
        .map((task) => this.projectThread(task, userId)),
    );
  }

  async listArchivedThreads(userId: string): Promise<Thread[]> {
    return Promise.all(
      this.options.store.listArchivedTasks(userId).map((task) => this.projectThread(task, userId)),
    );
  }

  async archiveThread(threadId: string, userId: string): Promise<{ ok: true }> {
    this.options.store.archiveThread({ threadId, ownerId: userId, now: this.now() });
    return { ok: true };
  }

  async unarchiveThread(threadId: string, userId: string): Promise<{ ok: true }> {
    this.options.store.unarchiveThread({ threadId, ownerId: userId, now: this.now() });
    return { ok: true };
  }

  async getThread(threadId: string, userId: string): Promise<Thread | null> {
    const task = this.options.store.getTaskForUser(threadId, userId);
    return task?.lifecycleState === "ACTIVE" ? this.projectThread(task, userId) : null;
  }

  async getAdminThread(threadId: string, adminUserId: string): Promise<Thread | null> {
    const admin = this.options.store.getUserIdentity(adminUserId);
    if (admin.role !== "ADMIN") return null;
    const ownerId = this.options.store.getTaskOwnerId(threadId);
    if (!ownerId) return null;
    const owner = this.options.store.getUserIdentity(ownerId);
    if (owner.tenantKey !== admin.tenantKey) return null;
    const task = this.options.store.getTaskForUser(threadId, ownerId);
    return task?.lifecycleState === "ACTIVE" ? this.projectThread(task, ownerId) : null;
  }

  async startThreadTurn(
    threadId: string,
    userId: string,
    prompt: string,
    config?: EffectiveConfigOverride,
    attachmentIds: string[] = [],
  ) {
    return this.startTurn(threadId, userId, prompt, config, attachmentIds);
  }

  async steerThread(
    threadId: string,
    userId: string,
    prompt: string,
    attachmentIds: string[] = [],
  ) {
    return this.steerTask(threadId, userId, prompt, attachmentIds);
  }

  async interruptThread(threadId: string, userId: string) {
    return this.interruptTask(threadId, userId);
  }

  async listThreadEvents(threadId: string, userId: string, afterSequence: number) {
    const events = this.options.store.listTaskEvents(threadId, userId, afterSequence);
    return events?.map((event) => projectThreadEvent(threadId, event)) ?? null;
  }

  subscribeThreadEvents(threadId: string, listener: (event: TaskEvent) => void): () => void {
    return this.subscribeTaskEvents(threadId, (event) =>
      listener(projectThreadEvent(threadId, event)),
    );
  }

  async listSubagents(threadId: string, userId: string): Promise<SubagentThread[] | null> {
    return this.options.store.listSubagents(threadId, userId, this.now());
  }

  async getSubagent(threadId: string, userId: string): Promise<SubagentThreadDetail | null> {
    return this.options.store.getSubagentDetail(threadId, userId, this.now());
  }

  async getMySettings(userId: string): Promise<UserSettingsView> {
    return withSettingsPolicy(this.options.store.getUserSettings(userId, this.now()));
  }

  async patchMySettings(userId: string, patch: UserSettingsPatch): Promise<UserSettingsView> {
    this.validateSettingsPatch(patch);
    const defaultProjectId = patch.general?.defaultProjectId;
    if (
      defaultProjectId !== undefined &&
      defaultProjectId !== null &&
      !this.options.store.listProjects(userId).some((project) => project.id === defaultProjectId)
    ) {
      throw new Error("Invalid default project");
    }
    if (patch.execution?.model !== undefined || patch.execution?.reasoningEffort !== undefined) {
      const current = this.options.store.getUserSettings(userId, this.now());
      const model =
        patch.execution.model !== undefined ? patch.execution.model : current.execution.model;
      await this.resolveAndValidateModelSelection(userId, null, {
        ...this.resolveEffectiveConfig(userId, null, null),
        model,
        reasoningEffort: patch.execution.reasoningEffort ?? current.execution.reasoningEffort,
      });
    }
    return withSettingsPolicy(this.options.store.patchUserSettings(userId, patch, this.now()));
  }

  async getMyUsage(userId: string) {
    return this.options.store.getUserUsage(userId);
  }

  async getMyConnections(userId: string) {
    return this.options.store.getUserConnections(userId);
  }

  async getMyPlugins(_userId: string) {
    return [];
  }

  async startTurn(
    taskId: string,
    userId: string,
    prompt: string,
    turnConfig?: EffectiveConfigOverride,
    attachmentIds: string[] = [],
  ) {
    const task = this.requireTask(taskId, userId);
    if (task.threadId && !task.accountId) {
      throw new Error("Thread runtime account binding is missing");
    }
    const safety = this.options.safety.authorize(userId);
    if (!safety.allowed) throw new Error(safety.reason ?? "Real Codex execution is not allowed");

    await this.refreshStaleQuotas();
    const configSnapshot = await this.resolveAndValidateModelSelection(
      userId,
      task,
      this.resolveEffectiveConfig(
        userId,
        task.threadConfig,
        turnConfig ? this.validateConfigOverride(turnConfig) : null,
      ),
      { allowUnresolvedDefault: true },
    );
    for (const recoverableTurnId of this.options.store.listRecoverableTurnIds(taskId, userId)) {
      this.options.store.completeTurn(recoverableTurnId, "ABANDONED_FOR_RESUME", this.now());
      this.startPromotedTurns(this.options.leases.releaseTurn(recoverableTurnId, this.now()));
    }
    const schedulerTurnId = randomUUID();
    this.options.store.createTurn({
      id: schedulerTurnId,
      taskId,
      ownerId: userId,
      prompt,
      status: "ALLOCATING",
      configSnapshot,
      attachmentIds,
      now: this.now(),
    });
    const allocation = this.options.leases.acquireTurn({
      userId,
      taskId,
      turnId: schedulerTurnId,
      now: this.now(),
      requiredAccountId: task.threadId ? task.accountId : null,
    });
    if (allocation.kind === "QUEUED") {
      this.options.store.setTurnStatus(schedulerTurnId, "QUEUED");
      this.options.store.setTaskQueued(taskId, allocation.ticket, this.now());
      const promoted = this.options.leases.promoteQueue(this.now());
      const current = promoted.find((turn) => turn.turnId === schedulerTurnId);
      this.startPromotedTurns(promoted.filter((turn) => turn.turnId !== schedulerTurnId));
      if (current) return this.startAllocatedTurn(current);
      const queue = this.options.leases.getQueueEntry(taskId, userId);
      if (!queue) throw new Error("Queued Turn disappeared before it could be started");
      const event = this.options.store.appendTaskEvent({
        taskId,
        threadId: task.threadId,
        turnId: null,
        type: "QUEUED",
        payload: {
          position: queue.position,
          etaMs: queue.etaMs,
          etaEstimated: queue.etaEstimated,
        },
        now: this.now(),
      });
      this.publish(event);
      return { status: "QUEUED", ...allocation, ...queue };
    }
    return this.startAllocatedTurn(allocation);
  }

  async steerTask(taskId: string, userId: string, prompt: string, attachmentIds: string[] = []) {
    const task = this.requireTask(taskId, userId);
    if (task.status !== "RUNNING" && task.status !== "WAITING_APPROVAL") {
      throw new Error(`Task status ${task.status} does not accept Steer`);
    }
    if (!task.threadId || !task.currentTurnId) throw new Error("Task has no active Codex turn");
    const platformTurnId = this.options.store.findPlatformTurnIdForRuntimeTurn(
      taskId,
      task.currentTurnId,
    );
    if (!platformTurnId) throw new Error("Active Turn projection is unavailable");
    const steerInputId = randomUUID();
    const inputSnapshot = this.options.store.claimSteerInput({
      id: steerInputId,
      taskId,
      turnId: platformTurnId,
      ownerId: userId,
      prompt,
      attachmentIds,
      now: this.now(),
    });
    const attachments = inputSnapshot.attachments.map((attachment) => ({
      name: attachment.name,
      path: join(this.options.dataDir, "workspaces", taskId, attachment.relativePath),
      mimeType: attachment.mimeType,
    }));
    try {
      if (attachments.length > 0) {
        await this.options.execution.steerTask(
          task.threadId,
          task.currentTurnId,
          prompt,
          attachments,
        );
      } else {
        await this.options.execution.steerTask(task.threadId, task.currentTurnId, prompt);
      }
    } catch (error) {
      try {
        const occurredAt = this.now();
        const message = error instanceof Error ? error.message : "Runtime Steer failed";
        if (error instanceof RpcError) {
          this.options.store.failSteerInputDelivery(steerInputId, message, occurredAt);
        } else {
          this.options.store.markSteerInputDeliveryUnknown(steerInputId, message, occurredAt);
          const recoveryReason =
            "Steer delivery outcome is unknown after a Runtime transport failure; explicit Turn recovery is required.";
          this.options.store.markTurnApprovalsForRecovery(taskId, task.currentTurnId);
          this.finishSchedulerTurn(platformTurnId, "NEEDS_RECOVERY", occurredAt);
          const schedulerKey = runtimeTurnKey(taskId, task.currentTurnId);
          if (schedulerKey) this.schedulerTurnByRuntimeTurn.delete(schedulerKey);
          this.options.store.setTaskInactiveIfCurrent(
            taskId,
            task.currentTurnId,
            "NEEDS_RECOVERY",
            occurredAt,
          );
          const recoveryEvent = this.options.store.appendTaskEvent({
            taskId,
            threadId: task.threadId,
            turnId: platformTurnId,
            type: "RECOVERY_REQUIRED",
            payload: { reason: recoveryReason },
            now: occurredAt,
          });
          this.publish(recoveryEvent);
        }
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          "Runtime Steer failed and attachment compensation failed",
        );
      }
      throw error;
    }
    this.options.store.completeSteerInputDelivery(steerInputId, this.now());
    const event = this.options.store.appendTaskEvent({
      taskId,
      threadId: task.threadId,
      turnId: platformTurnId,
      type: "USER_MESSAGE",
      payload: { itemId: randomUUID(), kind: "STEER", text: prompt },
      now: this.now(),
    });
    this.publish(event);
    return { status: task.status, turnId: platformTurnId };
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
    return this.options.store
      .listApprovals(taskId, userId)
      ?.map((approval) => this.options.store.projectApproval(approval));
  }

  async decideApproval(approvalId: string, userId: string, decision: string) {
    const claim = this.options.store.claimApprovalDelivery({
      approvalId,
      userId,
      decision,
    });
    if (claim.kind === "ALREADY_DELIVERED") {
      return this.options.store.projectApproval(claim.approval);
    }
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
      approval.parentTurnId,
      this.now(),
    );
    const event = this.options.store.appendTaskEvent({
      taskId: approval.taskId,
      threadId: this.options.store.getTaskForUser(approval.taskId, userId)?.threadId ?? null,
      turnId: this.options.store.findPlatformTurnIdForRuntimeTurn(
        approval.taskId,
        approval.parentTurnId,
      ),
      type: "APPROVAL_DECIDED",
      payload: { approvalId: approval.id, decision },
      now: this.now(),
    });
    this.publish(event);
    const task = this.options.store.getTaskForUser(approval.taskId, userId);
    if (task?.threadId && approval.sourceThreadId && approval.sourceThreadId !== task.threadId) {
      this.options.store.appendSubagentEvent({
        threadId: approval.sourceThreadId,
        turnId: approval.turnId,
        type: "APPROVAL_DECIDED",
        payload: { approvalId: approval.id, decision },
        now: this.now(),
      });
    }
    return this.options.store.projectApproval(approval);
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
    this.invalidateAccountModelCatalog(accountId);
    return this.options.accounts.list().find((account) => account.id === accountId) ?? null;
  }

  async refreshAccountQuotaNow(accountId: string, adminUserId: string) {
    const account = this.options.accounts.getInternal(accountId);
    if (!account) throw new Error("Codex account not found");
    const observedAt = this.now();
    try {
      const quota = await this.options.execution.refreshWeeklyQuota(account);
      this.storeWeeklyQuota(accountId, quota, observedAt);
      this.options.accounts.recordLifecycleEvent({
        accountId,
        actorUserId: adminUserId,
        action: "ACCOUNT_QUOTA_REFRESHED",
        outcome: "SUCCESS",
        summary:
          quota.status === "KNOWN"
            ? `Codex weekly quota refreshed: ${quota.remainingPercent}% remaining`
            : "Codex weekly quota could not be identified",
        now: observedAt,
      });
      return this.options.accounts.list().find((item) => item.id === accountId) ?? null;
    } catch (error) {
      this.options.accounts.recordLifecycleEvent({
        accountId,
        actorUserId: adminUserId,
        action: "ACCOUNT_QUOTA_REFRESHED",
        outcome: "FAILED",
        summary: "Codex weekly quota refresh failed",
        now: observedAt,
      });
      throw error;
    }
  }

  async listAudit() {
    return this.options.store.listAudit();
  }

  async getAdminPolicies() {
    return {
      productModes: {
        enabled: ["CODEX"] as const,
        disabled: ["CHAT", "WORK"] as const,
      },
      settings: SETTINGS_POLICY,
      memory: { nativeSharedAccountMemory: false },
      deploymentStage: "LOCAL_1_1A" as const,
      productionMultiUserEnabled: false,
    };
  }

  async getAdminConnectors() {
    return [
      {
        id: "feishu",
        name: "飞书",
        managed: true,
        mode: "USER_OAUTH",
        status: "CONFIGURED",
      },
      {
        id: "demo-database",
        name: "Demo Database",
        managed: true,
        mode: "MOCK",
        status: "CONFIGURED",
      },
      {
        id: "demo-business",
        name: "Demo Business",
        managed: true,
        mode: "MOCK",
        status: "CONFIGURED",
      },
    ];
  }

  async getAdminUsage() {
    return this.options.store.getGlobalUsage();
  }

  async getAdminRuntimeHealth(adminUserId: string) {
    const safety = this.options.safety.authorize(adminUserId);
    const accounts = this.options.accounts.list();
    return {
      deploymentStage: "LOCAL_1_1A",
      multiUserReady: false,
      workerIsolation: "NOT_IMPLEMENTED",
      safetyMode: safety.mode,
      safetyAllowedForActor: safety.allowed,
      accounts: {
        total: accounts.length,
        available: accounts.filter((account) => account.status === "AVAILABLE").length,
        unhealthy: accounts.filter((account) =>
          ["QUARANTINED", "REAUTH_REQUIRED", "EXHAUSTED"].includes(account.status),
        ).length,
      },
    };
  }

  private async projectThread(task: TaskRecord, userId: string): Promise<Thread> {
    const queued = this.options.leases.getQueueEntry(task.id, userId);
    const turns = this.options.store.listTurnsForTask(task.id, userId) ?? [];
    const activeTurn =
      [...turns]
        .reverse()
        .find((turn) =>
          ["ALLOCATING", "QUEUED", "RUNNING", "WAITING_APPROVAL"].includes(turn.status),
        ) ?? null;
    const events = this.options.store.listTaskEvents(task.id, userId, 0) ?? [];
    return {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      status: TaskStatusSchema.parse(task.status),
      updatedAt: task.updatedAt,
      archivedAt: task.archivedAt,
      currentTurn: activeTurn ? projectTurn(task.id, activeTurn) : null,
      turns: turns.map((turn) => projectTurn(task.id, turn)),
      queue: queued
        ? {
            position: queued.position,
            etaMs: queued.etaMs,
            etaEstimated: queued.etaEstimated,
          }
        : null,
      items: events.map((event) => eventToThreadItem(task.id, event)),
      composerState: {
        planMode: task.planMode,
        revision: task.composerRevision,
      },
    };
  }

  async runMaintenance(now = this.now()): Promise<void> {
    await this.cleanupExpiredDrafts(now);
    const limitedGoals = this.options.store.applyGoalWatchdog(now);
    await Promise.all(
      limitedGoals.map(({ ownerId, goal }) =>
        this.enforceGoalBudgetLimit(goal.threadId, ownerId, goal).catch(() => undefined),
      ),
    );
    this.recoverExpiredModelCatalogCooldowns(now);
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
    for (const goal of this.options.store.recoverPersistedRuntimeGoals(now)) {
      const event = this.options.store.appendTaskEvent({
        taskId: goal.taskId,
        threadId: goal.runtimeThreadId,
        turnId: null,
        type: "RECOVERY_REQUIRED",
        payload: {
          reason:
            "The API process restarted while a Runtime Goal remained unfinished; explicit recovery is required.",
        },
        now,
      });
      this.publish(event);
    }
    return interrupted.size;
  }

  async close(): Promise<void> {
    this.eventBus.removeAllListeners();
    this.modelCatalogByAccount.clear();
    this.modelCatalogRefreshByAccount.clear();
    this.modelCatalogCooldownUntilByAccount.clear();
    await this.options.execution.close();
  }

  private async readAccountModelCatalog(
    account: InternalAccount,
    options: { allowStale: boolean; forceRefresh?: boolean },
  ): Promise<AccountModelCatalogRead> {
    const now = this.now();
    const cached = this.modelCatalogByAccount.get(account.id);
    if (!options.forceRefresh && cached && cached.expiresAt.getTime() > now.getTime()) {
      return {
        models: cloneModelOptions(cached.models),
        observedAt: cached.observedAt,
        stale: false,
      };
    }

    let refresh = this.modelCatalogRefreshByAccount.get(account.id);
    if (!refresh) {
      const generation = this.modelCatalogGenerationByAccount.get(account.id) ?? 0;
      let createdRefresh!: Promise<CachedAccountModelCatalog>;
      createdRefresh = (async () => {
        const models = (await this.options.execution.listModels(account)).map((model) =>
          ModelOptionSchema.parse(model),
        );
        const observedAt = this.now();
        if ((this.modelCatalogGenerationByAccount.get(account.id) ?? 0) !== generation) {
          throw new Error("Runtime model catalog changed during refresh");
        }
        const entry = {
          models: cloneModelOptions(models),
          observedAt,
          expiresAt: new Date(observedAt.getTime() + MODEL_CATALOG_TTL_MS),
        } satisfies CachedAccountModelCatalog;
        this.modelCatalogByAccount.set(account.id, entry);
        return entry;
      })().finally(() => {
        if (this.modelCatalogRefreshByAccount.get(account.id) === createdRefresh) {
          this.modelCatalogRefreshByAccount.delete(account.id);
        }
      });
      refresh = createdRefresh;
      this.modelCatalogRefreshByAccount.set(account.id, createdRefresh);
    }

    try {
      const entry = await refresh;
      return {
        models: cloneModelOptions(entry.models),
        observedAt: entry.observedAt,
        stale: false,
      };
    } catch {
      const previous = this.modelCatalogByAccount.get(account.id);
      if (options.allowStale && previous) {
        return {
          models: cloneModelOptions(previous.models),
          observedAt: previous.observedAt,
          stale: true,
        };
      }
      throw new ModelCatalogUnavailableError();
    }
  }

  private invalidateAccountModelCatalog(accountId: string): void {
    this.modelCatalogGenerationByAccount.set(
      accountId,
      (this.modelCatalogGenerationByAccount.get(accountId) ?? 0) + 1,
    );
    this.modelCatalogByAccount.delete(accountId);
    this.modelCatalogRefreshByAccount.delete(accountId);
  }

  private isAccountModelRoutingEligible(userId: string, accountId: string): boolean {
    return this.options.leases
      .listModelRoutingAccountIdsForUser(userId, this.now(), accountId)
      .includes(accountId);
  }

  private coolDownAccountAfterModelCatalogFailure(accountId: string, now: Date): void {
    this.options.leases.updateAccount(accountId, { status: "COOLDOWN" });
    this.invalidateAccountModelCatalog(accountId);
    this.modelCatalogCooldownUntilByAccount.set(
      accountId,
      new Date(now.getTime() + MODEL_CATALOG_FAILURE_COOLDOWN_MS),
    );
  }

  private recoverExpiredModelCatalogCooldowns(now: Date): void {
    for (const [accountId, cooldownUntil] of this.modelCatalogCooldownUntilByAccount) {
      if (cooldownUntil.getTime() > now.getTime()) continue;
      this.modelCatalogCooldownUntilByAccount.delete(accountId);
      const account = this.options.accounts.getInternal(accountId);
      if (account?.status !== "COOLDOWN" || account.authStatus !== "AUTHENTICATED") {
        continue;
      }
      this.invalidateAccountModelCatalog(accountId);
      this.options.leases.updateAccount(accountId, { status: "AVAILABLE" });
    }
  }

  private async resolveAndValidateModelSelection(
    userId: string,
    task: TaskRecord | null,
    config: EffectiveThreadConfigSnapshot,
    options: { allowUnresolvedDefault?: boolean } = {},
  ): Promise<EffectiveThreadConfigSnapshot> {
    let catalog: ModelCatalog;
    try {
      catalog = await this.readModelCatalogForUser(userId, task?.id, false);
    } catch (error) {
      if (
        error instanceof NoRoutableModelAccountError &&
        config.model === null &&
        options.allowUnresolvedDefault
      ) {
        return config;
      }
      throw error;
    }
    const selectedModel =
      config.model ??
      catalog.models.find((model) => model.isDefault)?.model ??
      catalog.models[0]?.model;
    if (!selectedModel) throw new ModelCatalogUnavailableError();
    validateModelAgainstCatalog(catalog.models, selectedModel, config.reasoningEffort);
    return EffectiveThreadConfigSnapshotSchema.parse({
      ...config,
      model: selectedModel,
    });
  }

  private async resolveAllocatedAccountModel(
    account: InternalAccount,
    config: EffectiveThreadConfigSnapshot,
  ): Promise<EffectiveThreadConfigSnapshot> {
    const catalog = await this.readAccountModelCatalog(account, {
      allowStale: false,
      forceRefresh: true,
    });
    const selectedModel =
      config.model ??
      catalog.models.find((model) => model.isDefault)?.model ??
      catalog.models[0]?.model;
    if (!selectedModel) throw new ModelCatalogUnavailableError();
    validateModelAgainstCatalog(catalog.models, selectedModel, config.reasoningEffort);
    return EffectiveThreadConfigSnapshotSchema.parse({
      ...config,
      model: selectedModel,
    });
  }

  private async validateAllocatedCollaborationPreset(
    account: InternalAccount,
    model: string,
    reasoningEffort: string,
  ): Promise<void> {
    const catalog = await this.readAccountModelCatalog(account, {
      allowStale: false,
      forceRefresh: true,
    });
    try {
      validateModelAgainstCatalog(catalog.models, model, reasoningEffort);
      validateModelAgainstOrganizationPolicy(model, reasoningEffort);
    } catch {
      throw new PlanPresetModelUnavailableError();
    }
  }

  private validateSettingsPatch(patch: UserSettingsPatch): void {
    const execution = patch.execution;
    if (!execution) return;
    if (
      execution.reasoningEffort !== undefined &&
      !SETTINGS_POLICY.allowedReasoningEfforts.some(
        (effort) => effort.toLowerCase() === execution.reasoningEffort?.toLowerCase(),
      )
    ) {
      throw new Error("Reasoning effort is not allowed by organization policy");
    }
    if (
      execution.permissionMode !== undefined &&
      !SETTINGS_POLICY.allowedPermissionModes.includes(execution.permissionMode)
    ) {
      throw new Error("Permission mode is not allowed in 1.1A");
    }
    if (
      execution.approvalPreference !== undefined &&
      !SETTINGS_POLICY.allowedApprovalPreferences.includes(execution.approvalPreference)
    ) {
      throw new Error("Approval preference is not allowed in 1.1A");
    }
  }

  private validateConfigOverride(config: EffectiveConfigOverride): EffectiveConfigOverride {
    const parsed = EffectiveConfigOverrideSchema.parse(config);
    if (
      parsed.permissionMode !== undefined &&
      !(SETTINGS_POLICY.allowedPermissionModes as readonly string[]).includes(parsed.permissionMode)
    ) {
      throw new Error("Permission mode is not allowed in 1.1A");
    }
    this.validateSettingsPatch({
      execution: {
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.reasoningEffort !== undefined
          ? { reasoningEffort: parsed.reasoningEffort }
          : {}),
        ...(parsed.approvalMode !== undefined ? { approvalPreference: parsed.approvalMode } : {}),
      },
      ...(parsed.personality !== undefined || parsed.instructions !== undefined
        ? {
            personalization: {
              ...(parsed.personality !== undefined ? { personality: parsed.personality } : {}),
              ...(parsed.instructions !== undefined ? { instructions: parsed.instructions } : {}),
            },
          }
        : {}),
    });
    return parsed;
  }

  private resolveEffectiveConfig(
    userId: string,
    threadOverride: EffectiveConfigOverride | null,
    turnOverride: EffectiveConfigOverride | null,
  ): EffectiveThreadConfigSnapshot {
    const settings = this.options.store.getUserSettings(userId, this.now());
    const userConfig: EffectiveConfigOverride = {
      model: settings.execution.model,
      reasoningEffort: settings.execution.reasoningEffort,
      permissionMode: settings.execution.permissionMode,
      approvalMode: settings.execution.approvalPreference,
      personality: settings.personalization.personality,
      instructions: settings.personalization.instructions,
    };
    const merged = {
      ...ORGANIZATION_DEFAULT_CONFIG,
      ...userConfig,
      ...(threadOverride ?? {}),
      ...(turnOverride ?? {}),
    };
    this.validateConfigOverride(merged);
    return EffectiveThreadConfigSnapshotSchema.parse({
      ...merged,
      instructions: joinInstructions(
        ORGANIZATION_DEVELOPER_INSTRUCTIONS,
        merged.instructions ?? "",
      ),
      sourceVersion: ORGANIZATION_CONFIG_SOURCE_VERSION,
    });
  }

  private actorContextFor(userId: string): ActorContext {
    const identity = this.options.store.getUserIdentity(userId);
    return {
      ...identity,
      toolScopes: [...ORGANIZATION_TOOL_SCOPES],
      approvalPolicy: "ASK",
    };
  }

  private async processAttachmentCleanupJobs(now: Date): Promise<void> {
    const jobs = this.options.store.listAttachmentCleanupJobs();
    await Promise.all(jobs.map((job) => this.processAttachmentCleanupJob(job, now)));
  }

  private async processAttachmentCleanupJob(job: AttachmentCleanupJob, now: Date): Promise<void> {
    try {
      const segments = job.relativePath.split("/");
      if (
        segments[0] !== ".codexplatform" ||
        segments[1] !== "attachments" ||
        segments[2] !== job.attachmentId
      ) {
        throw new Error("Invalid attachment staging reference");
      }
      await removeSafeAttachmentRoot(this.options.dataDir, job.threadId, job.attachmentId);
      this.options.store.completeAttachmentCleanupJob(job.id);
    } catch (error) {
      this.options.store.failAttachmentCleanupJob(
        job.id,
        error instanceof Error ? error.message : "Attachment cleanup failed",
        now,
      );
    }
  }

  private requireTask(taskId: string, userId: string) {
    const task = this.options.store.getTaskForUser(taskId, userId);
    if (!task) throw new Error("Task not found");
    if (task.archivedAt) throw new Error("Thread is archived");
    return task;
  }

  private async readGoalCapabilityForUser(
    userId: string,
    requiredAccountId: string | null,
  ): Promise<GoalRuntimeCapability> {
    this.options.store.getUserIdentity(userId);
    const accountIds = this.options.leases.listModelRoutingAccountIdsForUser(
      userId,
      this.now(),
      requiredAccountId,
    );
    if (accountIds.length === 0) {
      return {
        availability: "UNAVAILABLE",
        reasonCode: "NO_ROUTABLE_CODEX_ACCOUNT",
        reason: "No routable Codex account can provide the locked Goal protocol",
      };
    }
    for (const accountId of accountIds) {
      const account = this.options.accounts.getInternal(accountId);
      if (!account) {
        return {
          availability: "UNAVAILABLE",
          reasonCode: "CODEX_ACCOUNT_UNAVAILABLE",
          reason: `Codex account ${accountId} is unavailable`,
        };
      }
      const capability = await this.options.execution.readGoalCapability(account);
      if (capability.availability !== "AVAILABLE") return capability;
    }
    return { availability: "AVAILABLE", reasonCode: null, reason: null };
  }

  private async readPlanCapabilityForUser(
    userId: string,
    requiredAccountId: string | null,
  ): Promise<PlanModeCatalogCapability> {
    this.options.store.getUserIdentity(userId);
    const accountIds = this.options.leases.listAssignableAccountIdsForUser(
      userId,
      this.now(),
      requiredAccountId,
    );
    if (accountIds.length === 0) {
      return {
        availability: "UNAVAILABLE",
        reasonCode: "NO_ROUTABLE_CODEX_ACCOUNT",
        reason: "No routable Codex account can provide Plan mode",
        presets: [],
      };
    }
    let representative: CollaborationModePreset[] | null = null;
    for (const accountId of accountIds) {
      const account = this.options.accounts.getInternal(accountId);
      if (!account) {
        return {
          availability: "UNAVAILABLE",
          reasonCode: "CODEX_ACCOUNT_UNAVAILABLE",
          reason: `Codex account ${accountId} is unavailable`,
          presets: [],
        };
      }
      const capability = await this.options.execution.readPlanModeCatalog(account);
      if (capability.availability !== "AVAILABLE") return capability;
      if (
        !capability.presets.some((preset) => preset.mode === "plan") ||
        !capability.presets.some((preset) => preset.mode === "default")
      ) {
        return {
          availability: "UNAVAILABLE",
          reasonCode: "PLAN_PRESET_MISSING",
          reason: "Runtime must expose both plan and default collaboration presets",
          presets: [],
        };
      }
      representative ??= capability.presets.map(cloneCollaborationPreset);
    }
    return {
      availability: "AVAILABLE",
      reasonCode: null,
      reason: null,
      presets: representative ?? [],
    };
  }

  private async ensureGoalCapability(
    userId: string,
    requiredAccountId: string | null,
  ): Promise<void> {
    const capability = await this.readGoalCapabilityForUser(userId, requiredAccountId);
    if (capability.availability !== "AVAILABLE") {
      const reasonCode = capability.reasonCode ?? "GOAL_CAPABILITY_UNKNOWN";
      throw new GoalCapabilityUnavailableError(
        reasonCode,
        capability.reason ?? "Goal is unavailable",
        deterministicGoalCapabilityConflict(reasonCode) ? 409 : 503,
      );
    }
  }

  private async withGoalMutationLock<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.goalMutationTailByThread.get(threadId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.goalMutationTailByThread.set(threadId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.goalMutationTailByThread.get(threadId) === tail) {
        this.goalMutationTailByThread.delete(threadId);
      }
    }
  }

  private async interruptGoalMutationTurn(task: TaskRecord): Promise<void> {
    const active = this.options.store.getActiveTurnForTask(task.id, task.ownerId);
    if (!active) return;
    if (active.status === "ALLOCATING" || active.status === "QUEUED") {
      throw new GoalMutationBlockedByPendingTurnError(active.status);
    }
    if (!task.threadId || !task.currentTurnId) return;
    await this.options.execution.interruptTask(task.threadId, task.currentTurnId);
  }

  private async synchronizeStoredGoal(
    task: TaskRecord,
    ownerId: string,
    pending: StoredThreadGoalView,
  ): Promise<ThreadGoalView> {
    if (!task.threadId) return publicThreadGoal(pending);
    try {
      const synced = await this.options.execution.syncThreadGoal(task.threadId, pending);
      if (synced.attachment === "DETACHED") return publicThreadGoal(pending);
      if (!synced.goal) throw new Error("Runtime Goal synchronization returned no Goal");
      return publicThreadGoal(
        this.options.store.syncThreadGoal({
          threadId: task.id,
          ownerId,
          runtimeThreadId: task.threadId,
          status: synced.goal.status,
          tokensUsed: synced.goal.tokensUsed,
          timeUsedSeconds: synced.goal.timeUsedSeconds,
          expectedRevision: pending.revision,
          ...(synced.runtimeUpdatedAt === null
            ? {}
            : { runtimeUpdatedAt: synced.runtimeUpdatedAt }),
          source: "COMMAND",
          now: this.now(),
        }),
      );
    } catch (error) {
      this.options.store.markThreadGoalRecovery(task.id, ownerId, this.now());
      throw error;
    }
  }

  private async enforceGoalBudgetLimit(
    taskId: string,
    ownerId: string,
    limitedGoal: StoredThreadGoalView,
  ): Promise<void> {
    await this.withGoalMutationLock(taskId, async () => {
      const task = this.options.store.getTaskForUser(taskId, ownerId);
      if (!task) return;
      try {
        const active = this.options.store.getActiveTurnForTask(taskId, ownerId);
        if (active && task.threadId && task.currentTurnId) {
          await this.options.execution.interruptTask(task.threadId, task.currentTurnId);
        }
        await this.synchronizeStoredGoal(task, ownerId, limitedGoal);
      } catch (error) {
        this.options.store.markThreadGoalRecovery(taskId, ownerId, this.now());
        throw error;
      }
    });
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
    const ownerId = this.options.store.getTaskOwnerId(draft.taskId);
    if (draft.subagentThreadId) {
      if (draft.type === "TOKEN_USAGE_UPDATED" && ownerId) {
        const payload = draft.payload as TaskEventPayloadMap["TOKEN_USAGE_UPDATED"];
        this.options.store.upsertThreadTokenUsage({
          taskId: draft.taskId,
          ownerId,
          runtimeThreadId: draft.subagentThreadId,
          turnId: draft.turnId,
          ...payload,
          now: occurredAt,
        });
      }
      this.options.store.appendSubagentEvent({
        threadId: draft.subagentThreadId,
        turnId: draft.turnId,
        type: draft.type,
        payload: draft.payload,
        now: occurredAt,
      });
      const terminalSubagentStatus = SUBAGENT_TERMINAL_STATUS_BY_EVENT[draft.type];
      if (terminalSubagentStatus) {
        this.options.store.setSubagentStatus(
          draft.subagentThreadId,
          terminalSubagentStatus,
          occurredAt,
        );
      }
      return;
    }
    const schedulerKey = runtimeTurnKey(draft.taskId, draft.turnId);
    const schedulerTurnId = schedulerKey
      ? this.schedulerTurnByRuntimeTurn.get(schedulerKey)
      : undefined;
    const platformTurnId =
      schedulerTurnId ??
      this.options.store.findPlatformTurnIdForRuntimeTurn(draft.taskId, draft.turnId);
    if (schedulerTurnId) this.options.leases.heartbeatTurn(schedulerTurnId, occurredAt);
    if (draft.type === "TOKEN_USAGE_UPDATED" && ownerId && draft.threadId) {
      const payload = draft.payload as TaskEventPayloadMap["TOKEN_USAGE_UPDATED"];
      this.options.store.upsertThreadTokenUsage({
        taskId: draft.taskId,
        ownerId,
        runtimeThreadId: draft.threadId,
        turnId: draft.turnId,
        ...payload,
        now: occurredAt,
      });
      const goalUpdate = this.options.store.updateThreadGoalTokens(
        draft.taskId,
        ownerId,
        payload.total.totalTokens,
        occurredAt,
      );
      if (goalUpdate?.triggered) {
        void this.enforceGoalBudgetLimit(draft.taskId, ownerId, goalUpdate.goal).catch(
          () => undefined,
        );
      }
    }
    const event = this.options.store.appendTaskEvent({
      taskId: draft.taskId,
      threadId: draft.threadId,
      turnId: platformTurnId,
      type: draft.type,
      payload: draft.payload,
      now: occurredAt,
    });
    if (draft.type === "SUBAGENT_ACTIVITY") {
      const payload = draft.payload as TaskEventPayloadMap["SUBAGENT_ACTIVITY"];
      if (ownerId && payload.agentThreadId) {
        this.options.store.upsertSubagent({
          threadId: payload.agentThreadId,
          parentTaskId: draft.taskId,
          parentRuntimeThreadId: draft.threadId,
          parentTurnId: draft.turnId,
          ownerId,
          sessionId: null,
          name: payload.name ?? payload.agentThreadId,
          role: payload.role ?? "subagent",
          model: payload.model,
          effort: payload.effort,
          status: payload.status,
          resultSummary: payload.resultSummary,
          now: occurredAt,
        });
      }
    }
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
      if (platformTurnId) {
        this.finishSchedulerTurn(platformTurnId, "NEEDS_RECOVERY", occurredAt);
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

  private persistInterruptedTurns(
    schedulerTurnIds: string[],
    reason: string,
    now: Date,
    source: { sourceTaskId: string; sourceRuntimeTurnId: string } | null = null,
  ): void {
    for (const schedulerTurnId of schedulerTurnIds) {
      try {
        const turn = this.options.store.getTurn(schedulerTurnId);
        if (!turn) continue;
        this.options.store.setTurnStatus(schedulerTurnId, "NEEDS_RECOVERY");
        const codexTurnId = turn.codexTurnId;
        const schedulerKey = runtimeTurnKey(turn.taskId, codexTurnId);
        if (schedulerKey) this.schedulerTurnByRuntimeTurn.delete(schedulerKey);
        const task = this.options.store.getTaskForUser(turn.taskId, turn.ownerId);
        if (!task) continue;
        const goal = this.options.store.getThreadGoal(turn.taskId, turn.ownerId);
        if (goal && (goal.status === "ACTIVE" || goal.status === "PAUSED")) {
          this.options.store.markThreadGoalRecovery(turn.taskId, turn.ownerId, now);
        }
        const sourceRuntimeTurnId =
          source?.sourceTaskId === turn.taskId
            ? source.sourceRuntimeTurnId
            : (codexTurnId ?? task.currentTurnId);
        if (sourceRuntimeTurnId) {
          this.options.store.markTurnApprovalsForRecovery(turn.taskId, sourceRuntimeTurnId);
        }
        this.options.store.setTaskInactive(turn.taskId, "NEEDS_RECOVERY", now);
        const event = this.options.store.appendTaskEvent({
          taskId: turn.taskId,
          threadId: task.threadId,
          turnId: schedulerTurnId,
          type: "RECOVERY_REQUIRED",
          payload: { reason },
          now,
        });
        this.publish(event);
      } finally {
        this.startPromotedTurns(this.options.leases.releaseTurn(schedulerTurnId, now));
      }
    }
  }

  private handleApproval(draft: ApprovalDraft): void {
    const payload =
      draft.payload && typeof draft.payload === "object" && !Array.isArray(draft.payload)
        ? (draft.payload as Record<string, unknown>)
        : {};
    const parentTurnId = draft.parentTurnId ?? draft.turnId;
    const platformParentTurnId = this.options.store.findPlatformTurnIdForRuntimeTurn(
      draft.taskId,
      parentTurnId,
    );
    const task = this.options.store.getTaskForUser(
      draft.taskId,
      this.options.store.getTaskOwnerId(draft.taskId) ?? "",
    );
    const sourceSubagent = Boolean(task?.threadId && task.threadId !== draft.threadId);
    const ownerId = this.options.store.getTaskOwnerId(draft.taskId);
    let sourceSubagentName: string | null = null;
    if (sourceSubagent && task && ownerId) {
      const existing = this.options.store.getSubagent(
        draft.threadId,
        ownerId,
        draft.at ?? this.now(),
      );
      sourceSubagentName = existing?.name ?? draft.threadId;
      if (!existing) {
        this.options.store.upsertSubagent({
          threadId: draft.threadId,
          parentTaskId: draft.taskId,
          parentRuntimeThreadId: task.threadId,
          parentTurnId,
          ownerId,
          sessionId: null,
          name: sourceSubagentName,
          role: "subagent",
          model: null,
          effort: null,
          status: "ACTIVE",
          resultSummary: null,
          now: draft.at ?? this.now(),
        });
      }
    }
    const approval = this.options.store.createApproval({
      requestId: draft.requestId,
      rawRpcId: draft.rawRpcId,
      accountId: draft.accountId,
      connectionGeneration: draft.connectionGeneration,
      threadId: draft.threadId,
      taskId: draft.taskId,
      turnId: draft.turnId,
      parentTurnId,
      itemId: draft.itemId,
      approvalType: draft.approvalType,
      payload: draft.payload,
      now: draft.at ?? this.now(),
    });
    const actionable = this.options.store.setTaskWaitingApprovalIfCurrent(
      draft.taskId,
      parentTurnId,
      draft.at ?? this.now(),
    );
    if (!actionable) {
      this.options.store.markTurnApprovalsForRecovery(draft.taskId, parentTurnId);
    }
    const approvalPayload: TaskEventPayloadMap["APPROVAL_REQUESTED"] = {
      approvalId: approval.id,
      itemId: draft.itemId,
      approvalType: draft.approvalType,
      reason: typeof payload.reason === "string" ? payload.reason : null,
      sourceThreadId: sourceSubagent ? draft.threadId : null,
      sourceSubagent,
      sourceSubagentName,
      ...(draft.approvalType === "COMMAND"
        ? {
            command: typeof payload.command === "string" ? payload.command : null,
            cwd: typeof payload.cwd === "string" ? payload.cwd : null,
          }
        : {}),
    };
    const event = this.options.store.appendTaskEvent({
      taskId: draft.taskId,
      threadId: task?.threadId ?? draft.threadId,
      turnId: platformParentTurnId,
      type: "APPROVAL_REQUESTED",
      payload: approvalPayload,
      now: draft.at ?? this.now(),
    });
    this.publish(event);
    if (sourceSubagent) {
      this.options.store.appendSubagentEvent({
        threadId: draft.threadId,
        turnId: draft.turnId,
        type: "APPROVAL_REQUESTED",
        payload: approvalPayload,
        now: draft.at ?? this.now(),
      });
    }
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
    if (task.threadId && task.accountId !== allocation.accountId) {
      const error = new Error(
        "Thread runtime account binding does not match its allocated account",
      );
      this.failAllocatedTurn(allocation);
      throw error;
    }
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

    let effectiveConfig: EffectiveThreadConfigSnapshot;
    try {
      effectiveConfig = await this.resolveAllocatedAccountModel(account, queuedTurn.configSnapshot);
      if (!this.isAccountModelRoutingEligible(queuedTurn.ownerId, account.id)) {
        throw new AllocatedAccountIneligibleError();
      }
      const turnInput = this.options.store.getTurnInputSnapshot(allocation.turnId);
      if (!turnInput) throw new Error("Turn input snapshot is unavailable");
      const planCapability = await this.options.execution.readPlanModeCatalog(account, {
        model: effectiveConfig.model,
        reasoningEffort: effectiveConfig.reasoningEffort,
      });
      if (planCapability.availability !== "AVAILABLE") {
        throw new PlanModeCapabilityChangedError();
      }
      const targetMode = turnInput.planMode ? "plan" : "default";
      const preset = planCapability.presets.find((candidate) => candidate.mode === targetMode);
      if (!preset) {
        throw new PlanModeCapabilityChangedError();
      }
      const requestedConfig = {
        model: effectiveConfig.model,
        reasoningEffort: effectiveConfig.reasoningEffort.toLowerCase(),
        instructions: effectiveConfig.instructions,
      };
      const actualConfig = EffectiveThreadConfigSnapshotSchema.parse({
        ...effectiveConfig,
        model: preset.settings.model,
        reasoningEffort:
          preset.settings.reasoningEffort ?? effectiveConfig.reasoningEffort.toLowerCase(),
        requestedConfig,
        collaborationPreset: cloneCollaborationPreset(preset),
      });
      await this.validateAllocatedCollaborationPreset(
        account,
        actualConfig.model as string,
        actualConfig.reasoningEffort,
      );
      effectiveConfig = actualConfig;
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      this.options.store.updateTurnConfigSnapshot(allocation.turnId, effectiveConfig);
      if (!this.isAccountModelRoutingEligible(queuedTurn.ownerId, account.id)) {
        throw new AllocatedAccountIneligibleError();
      }
    } catch (error) {
      const accountBecameIneligible =
        error instanceof AllocatedAccountIneligibleError ||
        !this.isAccountModelRoutingEligible(queuedTurn.ownerId, account.id);
      if (error instanceof ModelCatalogUnavailableError && !accountBecameIneligible) {
        this.coolDownAccountAfterModelCatalogFailure(account.id, this.now());
      }
      this.pendingStartSignalsByTask.delete(queuedTurn.taskId);
      this.rejectAllocatedTurnBeforeRuntime(
        allocation,
        preRuntimeFailure(error, accountBecameIneligible),
      );
      if (error instanceof ModelCatalogUnavailableError && !accountBecameIneligible) throw error;
      if (error instanceof PlanModeCapabilityChangedError) throw error;
      if (error instanceof PlanPresetModelUnavailableError) throw error;
      throw new AllocatedModelSelectionChangedError(
        accountBecameIneligible
          ? "Allocated Codex account became unavailable; submit the Turn again"
          : undefined,
      );
    }

    try {
      const started = await this.options.execution.startTask({
        accountId: account.id,
        codexHome: account.codexHome,
        taskId: queuedTurn.taskId,
        userId: queuedTurn.ownerId,
        cwd,
        prompt: queuedTurn.prompt,
        existingThreadId: task.threadId,
        effectiveConfig,
        actorContext: this.actorContextFor(queuedTurn.ownerId),
        goal: this.options.store.getTurnInputSnapshot(allocation.turnId)?.goal ?? null,
        onThreadPrepared: (threadId) => {
          this.options.store.bindTaskRuntime(queuedTurn.taskId, {
            accountId: account.id,
            accountAlias: account.alias,
            leaseId: allocation.leaseId,
            threadId,
            now: this.now(),
          });
        },
        attachments:
          this.options.store
            .getTurnInputSnapshot(allocation.turnId)
            ?.attachments.map((attachment) => ({
              name: attachment.name,
              path: join(cwd, attachment.relativePath),
              mimeType: attachment.mimeType,
            })) ?? [],
      });
      this.schedulerTurnByRuntimeTurn.set(
        runtimeTurnKey(queuedTurn.taskId, started.turnId) as string,
        allocation.turnId,
      );
      this.options.store.bindTurnRuntime(allocation.turnId, started.turnId, this.now());
      const preparedTask = this.options.store.getTaskForUser(queuedTurn.taskId, queuedTurn.ownerId);
      if (
        preparedTask?.threadId !== started.threadId ||
        preparedTask.accountId !== account.id ||
        preparedTask.leaseId !== allocation.leaseId
      ) {
        this.options.store.bindTaskRuntime(queuedTurn.taskId, {
          accountId: account.id,
          accountAlias: account.alias,
          leaseId: allocation.leaseId,
          threadId: started.threadId,
          now: this.now(),
        });
      }
      this.options.store.setCurrentTurn(queuedTurn.taskId, started.turnId, "RUNNING", this.now());
      const event = this.options.store.appendTaskEvent({
        taskId: queuedTurn.taskId,
        threadId: started.threadId,
        turnId: allocation.turnId,
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
        turnId: allocation.turnId,
      };
    } catch (error) {
      if (this.pendingStartSignalsByTask.get(queuedTurn.taskId) === pendingSignals) {
        this.pendingStartSignalsByTask.delete(queuedTurn.taskId);
      }
      if (error instanceof ThreadResumeSafetyError) {
        this.options.accounts.setState(account.id, "QUARANTINED");
      }
      const preparedTask = this.options.store.getTaskForUser(queuedTurn.taskId, queuedTurn.ownerId);
      if (
        preparedTask?.threadId &&
        this.options.store.getThreadGoal(queuedTurn.taskId, queuedTurn.ownerId)
      ) {
        this.options.store.markThreadGoalRecovery(
          queuedTurn.taskId,
          queuedTurn.ownerId,
          this.now(),
        );
      }
      const persisted = this.options.store.getTurn(allocation.turnId);
      if (persisted?.status !== "NEEDS_RECOVERY") {
        this.failAllocatedTurn(
          allocation,
          error instanceof ThreadResumeSafetyError ? error.turnId : null,
        );
      }
      throw error;
    }
  }

  private rejectAllocatedTurnBeforeRuntime(
    allocation: LeasedTurn,
    failure: PreRuntimeFailure,
  ): void {
    const failedAt = this.now();
    const turn = this.options.store.getTurn(allocation.turnId);
    if (turn) {
      const durationMs = this.options.store.completeTurn(allocation.turnId, "FAILED", failedAt);
      if (durationMs !== null) this.options.leases.recordTurnDuration(durationMs, failedAt);
      this.options.store.setTaskInactive(turn.taskId, "FAILED", failedAt);
      const event = this.options.store.appendTaskEvent({
        taskId: turn.taskId,
        threadId: this.options.store.getTaskForUser(turn.taskId, turn.ownerId)?.threadId ?? null,
        turnId: allocation.turnId,
        type: "TURN_FAILED",
        payload: {
          status: "failed",
          code: failure.code,
          error: failure.publicMessage,
        },
        now: failedAt,
      });
      this.publish(event);
    }
    this.startPromotedTurns(
      this.options.leases.releaseTurnBeforeRuntime(allocation.turnId, failedAt),
    );
  }

  private startPromotedTurns(promoted: LeasedTurn[]): void {
    for (const turn of promoted) {
      void this.startAllocatedTurn(turn).catch(() => undefined);
    }
  }

  private failAllocatedTurn(
    allocation: LeasedTurn,
    sourceRuntimeTurnId: string | null = null,
  ): void {
    const failedAt = this.now();
    const persisted = this.options.store.getTurn(allocation.turnId);
    if (persisted) {
      this.options.store.completeTurn(allocation.turnId, "NEEDS_RECOVERY", failedAt);
      const task = this.options.store.getTaskForUser(persisted.taskId, persisted.ownerId);
      if (task) {
        if (sourceRuntimeTurnId) {
          this.options.store.markTurnApprovalsForRecovery(persisted.taskId, sourceRuntimeTurnId);
        }
        this.options.store.setTaskInactive(persisted.taskId, "NEEDS_RECOVERY", failedAt);
        const event = this.options.store.appendTaskEvent({
          taskId: persisted.taskId,
          threadId: task.threadId,
          turnId: allocation.turnId,
          type: "RECOVERY_REQUIRED",
          payload: { reason: "Codex Turn could not be started; explicit recovery is required." },
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

  private refreshAccountQuota(accountId: string, observedAt = this.now()): Promise<void> {
    const inFlight = this.quotaRefreshByAccount.get(accountId);
    if (inFlight) return inFlight;

    const account = this.options.accounts.getInternal(accountId);
    if (!account) return Promise.resolve();

    let refresh!: Promise<void>;
    refresh = (async () => {
      try {
        const quota = await this.options.execution.refreshWeeklyQuota(account);
        this.storeWeeklyQuota(accountId, quota, observedAt);
      } catch {
        // A stale quota already fails account eligibility. Transient network
        // failures must not be promoted to an account/authentication failure.
      } finally {
        if (this.quotaRefreshByAccount.get(accountId) === refresh) {
          this.quotaRefreshByAccount.delete(accountId);
        }
      }
    })();
    this.quotaRefreshByAccount.set(accountId, refresh);
    return refresh;
  }

  private storeWeeklyQuota(accountId: string, quota: WeeklyQuota, observedAt: Date): void {
    this.options.accounts.updateWeeklyQuota(accountId, {
      remainingPercent: quota.status === "KNOWN" ? quota.remainingPercent : null,
      resetsAt:
        quota.status === "KNOWN" && quota.resetsAt !== null
          ? normalizeResetTimestamp(quota.resetsAt)
          : null,
      observedAt,
    });
  }
}

const MODEL_CATALOG_TTL_MS = 60_000;
const MODEL_CATALOG_FAILURE_COOLDOWN_MS = 30_000;

function cloneModelOptions(models: ModelOption[]): ModelOption[] {
  return models.map((model) => ({
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({ ...effort })),
    inputModalities: [...model.inputModalities],
  }));
}

function intersectAccountModelCatalogs(catalogs: ModelOption[][]): ModelOption[] {
  const [base, ...rest] = catalogs;
  if (!base) return [];

  const intersection: ModelOption[] = [];
  for (const baseModel of base) {
    const accountModels = [
      baseModel,
      ...rest.map((models) => models.find((model) => model.model === baseModel.model)),
    ];
    if (accountModels.some((model) => !model)) continue;
    const models = accountModels as ModelOption[];
    const supportedReasoningEfforts = baseModel.supportedReasoningEfforts.filter((effort) =>
      models.every((model) =>
        model.supportedReasoningEfforts.some(
          (candidate) => candidate.value.toLowerCase() === effort.value.toLowerCase(),
        ),
      ),
    );
    if (supportedReasoningEfforts.length === 0) continue;

    const commonDefault = models.every(
      (model) =>
        model.defaultReasoningEffort.toLowerCase() ===
        baseModel.defaultReasoningEffort.toLowerCase(),
    )
      ? supportedReasoningEfforts.find(
          (effort) => effort.value.toLowerCase() === baseModel.defaultReasoningEffort.toLowerCase(),
        )?.value
      : undefined;
    const defaultReasoningEffort =
      commonDefault ??
      supportedReasoningEfforts.find(
        (effort) => effort.value.toLowerCase() === baseModel.defaultReasoningEffort.toLowerCase(),
      )?.value ??
      supportedReasoningEfforts[0]?.value;
    if (!defaultReasoningEffort) continue;

    intersection.push(
      ModelOptionSchema.parse({
        ...baseModel,
        isDefault: models.every((model) => model.isDefault),
        defaultReasoningEffort,
        supportedReasoningEfforts,
        inputModalities: baseModel.inputModalities.filter((modality) =>
          models.every((model) => model.inputModalities.includes(modality)),
        ),
        supportsPersonality: models.every((model) => model.supportsPersonality),
      }),
    );
  }
  if (!intersection.some((model) => model.isDefault) && intersection[0]) {
    intersection[0] = ModelOptionSchema.parse({ ...intersection[0], isDefault: true });
  }
  return intersection;
}

function validateModelAgainstCatalog(
  models: ModelOption[],
  selectedModel: string,
  selectedEffort: string,
): void {
  const model = models.find((candidate) => candidate.model === selectedModel);
  if (!model) throw new Error("Unsupported model selection");
  if (
    !model.supportedReasoningEfforts.some(
      (effort) => effort.value.toLowerCase() === selectedEffort.toLowerCase(),
    )
  ) {
    throw new Error(
      "Unsupported configuration: Reasoning effort is not supported by the selected model",
    );
  }
}

function preRuntimeFailure(error: unknown, accountBecameIneligible: boolean): PreRuntimeFailure {
  if (accountBecameIneligible) {
    return {
      code: "ALLOCATED_ACCOUNT_INELIGIBLE",
      publicMessage: "The allocated Codex account became unavailable before execution.",
    };
  }
  if (error instanceof PlanModeCapabilityChangedError) {
    return { code: error.code, publicMessage: error.message };
  }
  if (error instanceof PlanPresetModelUnavailableError) {
    return { code: error.code, publicMessage: error.message };
  }
  if (error instanceof ModelCatalogUnavailableError) {
    return {
      code: "MODEL_CATALOG_UNAVAILABLE",
      publicMessage: "Runtime model catalog became unavailable before execution.",
    };
  }
  return {
    code: "ALLOCATED_MODEL_SELECTION_CHANGED",
    publicMessage: "The selected model or Effort became unavailable before execution.",
  };
}

function validateModelAgainstOrganizationPolicy(model: string, reasoningEffort: string): void {
  if (
    SETTINGS_POLICY.allowedModels &&
    !(SETTINGS_POLICY.allowedModels as readonly string[]).includes(model)
  ) {
    throw new Error("Model is not allowed by organization policy");
  }
  if (
    !SETTINGS_POLICY.allowedReasoningEfforts.some(
      (allowed) => allowed.toLowerCase() === reasoningEffort.toLowerCase(),
    )
  ) {
    throw new Error("Reasoning effort is not allowed by organization policy");
  }
}

const SETTINGS_POLICY = {
  // Model choices are runtime-owned and returned by GET /api/models, so this
  // organization-policy field stays null instead of duplicating that catalog.
  allowedModels: null,
  allowedReasoningEfforts: ["LOW", "MEDIUM", "HIGH", "XHIGH", "ULTRA"] as readonly string[],
  allowedPermissionModes: [
    "DEFAULT",
    "READ_ONLY",
    "WORKSPACE_WRITE",
    "ASK_FOR_APPROVAL",
    "APPROVE_FOR_ME",
  ] as readonly UserSettings["execution"]["permissionMode"][],
  allowedApprovalPreferences: ["ASK"] as readonly UserSettings["execution"]["approvalPreference"][],
  lockedFields: [] as const,
};

const ORGANIZATION_CONFIG_SOURCE_VERSION = "org-policy-1.1a-v1";
const ORGANIZATION_DEVELOPER_INSTRUCTIONS =
  "Apply organization policy and use the authenticated employee identity for enterprise tools.";
const ORGANIZATION_DEFAULT_CONFIG: EffectiveConfigOverride = {
  model: null,
  reasoningEffort: "MEDIUM",
  permissionMode: "DEFAULT",
  approvalMode: "ASK",
  personality: "PRAGMATIC",
  instructions: "",
};
const ORGANIZATION_TOOL_SCOPES = [
  "feishu_wiki_search",
  "feishu_doc_read",
  "demo_db_query",
  "demo_business_get",
] as const;

function cloneCollaborationPreset(preset: CollaborationModePreset): CollaborationModePreset {
  return {
    name: preset.name,
    mode: preset.mode,
    settings: { ...preset.settings },
  };
}

function withSettingsPolicy(settings: UserSettings): UserSettingsView {
  return {
    ...settings,
    policy: {
      allowedModels: SETTINGS_POLICY.allowedModels,
      allowedReasoningEfforts: [...SETTINGS_POLICY.allowedReasoningEfforts],
      allowedPermissionModes: [...SETTINGS_POLICY.allowedPermissionModes],
      allowedApprovalPreferences: [...SETTINGS_POLICY.allowedApprovalPreferences],
      lockedFields: [...SETTINGS_POLICY.lockedFields],
    },
  };
}

function projectThreadEvent(threadId: string, event: TaskEvent): TaskEvent {
  return {
    ...event,
    threadId,
    itemId: event.itemId ?? derivePublicItemId(threadId, event),
    payload: event.type === "LEASE_ACQUIRED" ? {} : event.payload,
  } as TaskEvent;
}

function eventToThreadItem(threadId: string, event: TaskEvent): ThreadItem {
  const projected = projectThreadEvent(threadId, event);
  return {
    id: projected.itemId ?? derivePublicItemId(threadId, projected),
    threadId,
    turnId: projected.turnId,
    sequence: projected.sequence,
    type: projected.type,
    timestamp: projected.timestamp,
    payload: projected.payload,
  };
}

function derivePublicItemId(threadId: string, event: TaskEvent): string {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  if (typeof payload.itemId === "string" && payload.itemId.length > 0) return payload.itemId;
  return `${event.type.toLowerCase()}:${event.turnId ?? threadId}`;
}

function normalizeResetTimestamp(value: number): Date {
  return new Date(value < 10_000_000_000 ? value * 1_000 : value);
}

function runtimeTurnKey(taskId: string, turnId: string | null): string | null {
  return turnId ? `${taskId}:${turnId}` : null;
}

function commonAttachmentRoot(paths: string[]): string | null {
  const roots = paths.map((path) => path.split("/")[0]).filter(Boolean);
  return roots.length > 0 && roots.every((root) => root === roots[0]) ? (roots[0] ?? null) : null;
}

async function prepareSafeAttachmentRoot(
  dataDir: string,
  threadId: string,
  attachmentId: string,
): Promise<void> {
  const dataRoot = resolve(dataDir);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const dataRootReal = await realpath(dataRoot);
  const ancestry = attachmentAncestry(dataRoot, threadId, attachmentId);
  for (const directory of ancestry) {
    await createDirectoryWithoutSymlink(directory);
    assertContainedPath(dataRootReal, await realpath(directory));
  }
}

async function writeSafeAttachmentFile(
  attachmentRoot: string,
  relativePath: string,
  content: Buffer,
): Promise<void> {
  const rootReal = await realpath(attachmentRoot);
  const segments = relativePath.split("/");
  const fileName = segments.pop();
  if (!fileName) throw new Error("Unsafe attachment staging path");

  let parent = attachmentRoot;
  let parentReal = rootReal;
  for (const segment of segments) {
    parent = join(parent, segment);
    await createDirectoryWithoutSymlink(parent);
    parentReal = await realpath(parent);
    assertContainedPath(rootReal, parentReal);
  }

  const target = join(parentReal, fileName);
  assertContainedPath(rootReal, target);
  try {
    await lstat(target);
    throw new Error("Unsafe attachment staging path");
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }

  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    target,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

async function createDirectoryWithoutSymlink(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Unsafe attachment staging path");
  }
}

async function removeSafeAttachmentRoot(
  dataDir: string,
  threadId: string,
  attachmentId: string,
): Promise<void> {
  const dataRoot = resolve(dataDir);
  let dataRootReal: string;
  try {
    dataRootReal = await realpath(dataRoot);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }

  const ancestry = attachmentAncestry(dataRoot, threadId, attachmentId);
  for (const path of ancestry) {
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Unsafe attachment staging path");
    }
    assertContainedPath(dataRootReal, await realpath(path));
  }
  await rm(ancestry.at(-1) as string, { recursive: true, force: true });
}

function attachmentAncestry(dataRoot: string, threadId: string, attachmentId: string): string[] {
  const workspaces = join(dataRoot, "workspaces");
  const workspace = join(workspaces, threadId);
  const privateRoot = join(workspace, ".codexplatform");
  const attachments = join(privateRoot, "attachments");
  return [workspaces, workspace, privateRoot, attachments, join(attachments, attachmentId)];
}

function assertContainedPath(base: string, candidate: string): void {
  const child = relative(base, candidate);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return;
  throw new Error("Unsafe attachment staging path");
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function projectTurn(threadId: string, turn: TurnRecord): Thread["turns"][number] {
  return {
    id: turn.id,
    threadId,
    prompt: turn.prompt,
    status: TurnStatusSchema.parse(turn.status),
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    model: turn.configSnapshot.model,
    effort: turn.configSnapshot.reasoningEffort,
    permissionMode: turn.configSnapshot.permissionMode,
    configSnapshot: turn.configSnapshot,
  };
}

function joinInstructions(required: string, personal: string): string {
  return personal.length > 0 ? `${required}\n\n${personal}` : required;
}

function deterministicGoalCapabilityConflict(reasonCode: string): boolean {
  return [
    "RUNTIME_VERSION_UNSUPPORTED",
    "RUNTIME_GOAL_METHOD_UNSUPPORTED",
    "RUNTIME_GOAL_STATUS_UNSUPPORTED",
  ].includes(reasonCode);
}

function publicThreadGoal(goal: StoredThreadGoalView): ThreadGoalView {
  const { revision: _revision, ...view } = goal;
  return ThreadGoalViewSchema.parse(view);
}

function projectBrowserAttachment(attachment: DraftAttachment): BrowserDraftAttachment {
  const { relativePath: _relativePath, ...browserAttachment } = attachment;
  return BrowserDraftAttachmentSchema.parse(browserAttachment);
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
