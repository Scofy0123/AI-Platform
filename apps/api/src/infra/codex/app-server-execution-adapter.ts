import { EventEmitter } from "node:events";
import {
  type ActorContext,
  type EffectiveThreadConfigSnapshot,
  type ModelOption,
  ModelOptionSchema,
  type ThreadGoalSnapshot,
  type ThreadGoalView,
} from "@codexplatform/contracts";
import type { InternalAccount } from "../../domain/account-admin-store.js";
import { GoalSyncConflictError } from "../../domain/errors.js";
import type {
  ApprovalDraft,
  AttachedGoalRuntimeResult,
  GoalRuntimeCapability,
  PlanModeCatalogCapability,
  RuntimeGoalProjection,
  TaskEventDraft,
  TaskExecutionAdapter,
} from "../../domain/platform-service.js";
import {
  ActiveTurnResumeConflictError,
  ApprovalTransportUnavailableError as ApprovalUnavailable,
  InvalidThreadResumeResponseError,
  ThreadResumeSafetyError,
} from "../../domain/platform-service.js";
import type { ApprovalTransportIdentity } from "../../domain/platform-store.js";
import type { ActorRegistry } from "../../tools/actor-registry.js";
import type { DynamicToolCall, DynamicToolResponse } from "../../tools/tool-runtime.js";
import {
  type DynamicToolDefinition,
  isRateLimitSnapshot,
  type WeeklyQuota,
  weeklyQuotaFromRateLimitSnapshot,
} from "./codex-runtime.js";
import { CodexEventNormalizer } from "./event-normalizer.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse.js";
import type { Model } from "./generated/v2/Model.js";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";

interface RpcPort extends EventEmitter {
  respond(id: number | string, result: unknown): Promise<void>;
  respondError?(id: number | string, error: { code: number; message: string }): Promise<void>;
}

interface RuntimePort {
  readGoalProtocolCapability(): GoalRuntimeCapability;
  readPlanProtocolCapability(): GoalRuntimeCapability;
  startThread(input: {
    cwd: string;
    dynamicTools: ReturnType<ToolRuntimePort["definitions"]>;
    effectiveConfig: EffectiveThreadConfigSnapshot;
  }): Promise<unknown>;
  resumeThread(
    threadId: string,
    options: { cwd: string; effectiveConfig: EffectiveThreadConfigSnapshot },
  ): Promise<ThreadResumeResponse>;
  startTurn(
    threadId: string,
    prompt: string,
    options: {
      cwd: string;
      effectiveConfig: EffectiveThreadConfigSnapshot;
      attachments?: Array<{ name: string; path: string; mimeType: string }>;
    },
  ): Promise<unknown>;
  disableThreadMemory(threadId: string): Promise<unknown>;
  setThreadGoal(
    threadId: string,
    input: { objective: string; status: "active" | "paused" | "complete"; tokenBudget: number },
  ): Promise<{
    objective: string;
    status: string;
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    updatedAt: number;
  }>;
  getThreadGoal(threadId: string): Promise<{
    objective: string;
    status: string;
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    updatedAt: number;
  } | null>;
  clearThreadGoal(threadId: string): Promise<boolean>;
  steerTurn(
    threadId: string,
    turnId: string,
    prompt: string,
    attachments?: Array<{ name: string; path: string; mimeType: string }>,
  ): Promise<unknown>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  startChatGptLogin(): Promise<{ loginId: string; authUrl: string }>;
  readWeeklyQuota(): Promise<WeeklyQuota>;
  listModels(): Promise<Model[]>;
  listCollaborationModes(input: {
    model: string | null;
    reasoningEffort: string;
  }): Promise<import("@codexplatform/contracts").CollaborationModePreset[]>;
}

export interface ManagedRuntimePort {
  accountId: string;
  rpc: RpcPort;
  runtime: RuntimePort;
}

export interface RuntimeSupervisorPort {
  startAccount(input: { accountId: string; codexHome: string }): Promise<ManagedRuntimePort>;
  stopAccount?(accountId: string): Promise<void>;
  stopAll(): Promise<void>;
  on?(
    event: "accountCrashed",
    listener: (event: {
      accountId: string;
      exitCode: number | null;
      signal: string | null;
    }) => void,
  ): this;
}

interface ToolRuntimePort {
  definitions(): DynamicToolDefinition[];
  invoke(call: DynamicToolCall): Promise<DynamicToolResponse>;
}

interface AdapterOptions {
  supervisor: RuntimeSupervisorPort;
  tools: ToolRuntimePort;
  actors: ActorRegistry;
  runtimeDataDir?: string;
}

interface ThreadContext {
  taskId: string;
  userId: string;
  accountId: string;
  connectionGeneration: number;
  threadId: string;
  turnId: string | null;
  parentThreadId: string | null;
  actorContext: ActorContext;
}

interface PendingApproval {
  accountId: string;
  connectionGeneration: number;
  threadId: string;
  turnId: string;
  rpc: RpcPort;
  rawId: number | string;
  approvalType: ApprovalDraft["approvalType"];
  params: Record<string, unknown>;
}

interface AttachedConnection {
  rpc: RpcPort;
  generation: number;
}

type BufferedRpcSignal =
  | { kind: "NOTIFICATION"; value: unknown }
  | { kind: "SERVER_REQUEST"; rpc: RpcPort; value: unknown };

export class AppServerExecutionAdapter extends EventEmitter implements TaskExecutionAdapter {
  private readonly attachedConnectionByAccount = new Map<string, AttachedConnection>();
  private readonly lastConnectionGenerationByAccount = new Map<string, number>();
  private readonly runtimeByThread = new Map<string, RuntimePort>();
  private readonly contextByThread = new Map<string, ThreadContext>();
  private readonly normalizerByTask = new Map<string, CodexEventNormalizer>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly startingSignalsByThread = new Map<string, BufferedRpcSignal[]>();
  private readonly goalCapabilityByAccount = new Map<string, GoalRuntimeCapability>();

  constructor(private readonly options: AdapterOptions) {
    super();
    options.supervisor.on?.("accountCrashed", (event) => this.handleAccountCrash(event));
  }

  async listModels(account: InternalAccount): Promise<ModelOption[]> {
    const managed = await this.options.supervisor.startAccount({
      accountId: account.id,
      codexHome: account.codexHome,
    });
    return (await managed.runtime.listModels()).map(mapRuntimeModel);
  }

  async readGoalCapability(account: InternalAccount): Promise<GoalRuntimeCapability> {
    try {
      const managed = await this.options.supervisor.startAccount({
        accountId: account.id,
        codexHome: account.codexHome,
      });
      this.attach(managed);
      const cached = this.goalCapabilityByAccount.get(account.id);
      if (cached) return { ...cached };
      const capability = managed.runtime.readGoalProtocolCapability();
      if (cacheableGoalCapability(capability)) {
        this.goalCapabilityByAccount.set(account.id, capability);
      }
      return { ...capability };
    } catch (error) {
      return {
        availability: "UNAVAILABLE",
        reasonCode: "RUNTIME_CAPABILITY_PROBE_FAILED",
        reason: error instanceof Error ? error.message : "Goal Runtime capability probe failed",
      };
    }
  }

  async readPlanModeCatalog(
    account: InternalAccount,
    requested?: { model: string | null; reasoningEffort: string },
  ): Promise<PlanModeCatalogCapability> {
    try {
      const managed = await this.options.supervisor.startAccount({
        accountId: account.id,
        codexHome: account.codexHome,
      });
      this.attach(managed);
      const protocol = managed.runtime.readPlanProtocolCapability();
      if (protocol.availability !== "AVAILABLE") {
        return { ...protocol, presets: [] };
      }
      const fallback = requested ?? (await planFallbackFromModels(managed.runtime.listModels()));
      const presets = await managed.runtime.listCollaborationModes(fallback);
      if (
        !presets.some((preset) => preset.mode === "plan") ||
        !presets.some((preset) => preset.mode === "default")
      ) {
        return {
          availability: "UNAVAILABLE",
          reasonCode: "PLAN_PRESET_MISSING",
          reason: "Runtime collaboration mode directory is incomplete",
          presets: [],
        };
      }
      return { availability: "AVAILABLE", reasonCode: null, reason: null, presets };
    } catch (error) {
      return {
        availability: "UNAVAILABLE",
        reasonCode: "RUNTIME_CAPABILITY_PROBE_FAILED",
        reason:
          error instanceof Error ? error.message : "Plan mode Runtime capability probe failed",
        presets: [],
      };
    }
  }

  async setThreadGoal(
    threadId: string,
    goal: ThreadGoalSnapshot,
  ): Promise<AttachedGoalRuntimeResult<RuntimeGoalProjection>> {
    const runtime = this.runtimeByThread.get(threadId);
    if (!runtime) return { attachment: "DETACHED" };
    try {
      const nativeGoal = await runtime.setThreadGoal(threadId, {
        objective: goal.objective,
        status: runtimeGoalStatus(goal.status),
        tokenBudget: goal.tokenBudget,
      });
      return {
        attachment: "ATTACHED",
        goal: projectRuntimeGoal(goal, nativeGoal),
        runtimeUpdatedAt: nativeGoal.updatedAt,
      };
    } catch (error) {
      this.cacheAttachedGoalFailure(threadId, error);
      throw error;
    }
  }

  async getThreadGoal(threadId: string): Promise<AttachedGoalRuntimeResult<RuntimeGoalProjection>> {
    const runtime = this.runtimeByThread.get(threadId);
    if (!runtime) return { attachment: "DETACHED" };
    try {
      const nativeGoal = await runtime.getThreadGoal(threadId);
      return {
        attachment: "ATTACHED",
        goal: nativeGoal ? projectRuntimeGoal(null, nativeGoal) : null,
        runtimeUpdatedAt: nativeGoal?.updatedAt ?? null,
      };
    } catch (error) {
      this.cacheAttachedGoalFailure(threadId, error);
      throw error;
    }
  }

  async clearThreadGoal(
    threadId: string,
  ): Promise<AttachedGoalRuntimeResult<{ cleared: boolean }>> {
    const runtime = this.runtimeByThread.get(threadId);
    if (!runtime) return { attachment: "DETACHED" };
    try {
      const cleared = await runtime.clearThreadGoal(threadId);
      if ((await runtime.getThreadGoal(threadId)) !== null) {
        throw new GoalSyncConflictError(
          "clear",
          "Runtime Goal remained present after thread/goal/clear",
        );
      }
      return { attachment: "ATTACHED", cleared };
    } catch (error) {
      this.cacheAttachedGoalFailure(threadId, error);
      throw error;
    }
  }

  async syncThreadGoal(
    threadId: string,
    goal: ThreadGoalSnapshot,
  ): Promise<AttachedGoalRuntimeResult<RuntimeGoalProjection>> {
    const applied = await this.setThreadGoal(threadId, goal);
    if (applied.attachment === "DETACHED") return applied;
    const verified = await this.getThreadGoal(threadId);
    if (verified.attachment === "DETACHED" || !verified.goal) {
      throw new GoalSyncConflictError(
        "clear",
        "Runtime Goal verification returned no Goal after synchronization",
      );
    }
    assertGoalProjectionMatches(goal, verified.goal);
    return {
      ...verified,
      goal: {
        ...verified.goal,
        objective: verified.goal.objective || goal.objective,
        timeBudgetSeconds: goal.timeBudgetSeconds,
      },
    };
  }

  async startTask(input: {
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
  }): Promise<{ threadId: string; turnId: string }> {
    const managed = await this.options.supervisor.startAccount({
      accountId: input.accountId,
      codexHome: input.codexHome,
    });
    const connectionGeneration = this.attach(managed);
    let threadId: string;
    if (input.existingThreadId) {
      try {
        const resumed = await managed.runtime.resumeThread(input.existingThreadId, {
          cwd: input.cwd,
          effectiveConfig: input.effectiveConfig,
        });
        const state = inspectResumedThread(resumed, input.existingThreadId);
        threadId = state.threadId;
        if (state.kind === "ACTIVE_CONFLICT") {
          throw new ActiveTurnResumeConflictError(threadId, state.turnId, state.reason);
        }
        assertMemoryDisabledResponse(await managed.runtime.disableThreadMemory(threadId));
      } catch (error) {
        const safetyError =
          error instanceof ThreadResumeSafetyError
            ? error
            : new InvalidThreadResumeResponseError(
                input.existingThreadId,
                "Thread resume response is unsafe; the new prompt was not accepted",
              );
        this.detachAccount(input.accountId, safetyError.message, {
          sourceTaskId: input.taskId,
          ...(safetyError.turnId ? { sourceRuntimeTurnId: safetyError.turnId } : {}),
        });
        await this.options.supervisor.stopAccount?.(input.accountId).catch(() => undefined);
        throw safetyError;
      }
    } else {
      try {
        threadId = extractThreadId(
          await managed.runtime.startThread({
            cwd: input.cwd,
            dynamicTools: this.options.tools.definitions(),
            effectiveConfig: input.effectiveConfig,
          }),
        );
        assertMemoryDisabledResponse(await managed.runtime.disableThreadMemory(threadId));
      } catch (error) {
        const safetyError =
          error instanceof ThreadResumeSafetyError
            ? error
            : new InvalidThreadResumeResponseError(
                "unknown",
                "Thread memory isolation is unsafe; the new prompt was not accepted",
              );
        this.detachAccount(input.accountId, safetyError.message);
        await this.options.supervisor.stopAccount?.(input.accountId).catch(() => undefined);
        throw safetyError;
      }
    }
    input.onThreadPrepared?.(threadId);
    if (input.goal) {
      const capability =
        this.goalCapabilityByAccount.get(input.accountId) ??
        managed.runtime.readGoalProtocolCapability();
      if (capability.availability !== "AVAILABLE") {
        if (cacheableGoalCapability(capability)) {
          this.goalCapabilityByAccount.set(input.accountId, capability);
        }
        throw new Error(capability.reason ?? "Goal protocol is unavailable for this Runtime");
      }
      const synced = await managed.runtime.setThreadGoal(threadId, {
        objective: input.goal.objective,
        status: runtimeGoalStatus(input.goal.status),
        tokenBudget: input.goal.tokenBudget,
      });
      this.emit("goalUpdated", {
        taskId: input.taskId,
        threadId,
        status: platformGoalStatus(synced.status),
        tokensUsed: synced.tokensUsed,
        timeUsedSeconds: synced.timeUsedSeconds,
        runtimeUpdatedAt: synced.updatedAt,
      });
    } else if (input.existingThreadId) {
      await managed.runtime.clearThreadGoal(threadId);
    }
    const contextKey = connectionThreadKey(input.accountId, connectionGeneration, threadId);
    this.contextByThread.set(contextKey, {
      taskId: input.taskId,
      userId: input.userId,
      accountId: input.accountId,
      connectionGeneration,
      threadId,
      turnId: null,
      parentThreadId: null,
      actorContext: cloneActorContext(input.actorContext),
    });
    this.runtimeByThread.set(threadId, managed.runtime);
    this.normalizerByTask.set(
      input.taskId,
      new CodexEventNormalizer({
        taskId: input.taskId,
        codexHome: input.codexHome,
        workspaceDir: input.cwd,
        ...(this.options.runtimeDataDir ? { runtimeDataDir: this.options.runtimeDataDir } : {}),
      }),
    );
    const startingSignals: BufferedRpcSignal[] = [];
    this.startingSignalsByThread.set(contextKey, startingSignals);
    try {
      const turnId = extractTurnId(
        await managed.runtime.startTurn(threadId, input.prompt, {
          cwd: input.cwd,
          effectiveConfig: input.effectiveConfig,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        }),
      );
      const context = this.contextByThread.get(contextKey);
      if (!context) throw new Error("Codex Turn context detached while starting");
      context.turnId = turnId;
      this.options.actors.bind({
        taskId: input.taskId,
        accountId: input.accountId,
        connectionGeneration,
        threadId,
        turnId,
        actorContext: input.actorContext,
      });
      await this.flushStartingSignals(
        input.accountId,
        connectionGeneration,
        contextKey,
        startingSignals,
      );
      if (!this.contextByThread.has(contextKey)) {
        throw new Error("Codex Turn context detached while reconciling startup events");
      }
      return { threadId, turnId };
    } catch (error) {
      if (this.startingSignalsByThread.get(contextKey) === startingSignals) {
        this.startingSignalsByThread.delete(contextKey);
      }
      await this.rejectStartingServerRequests(
        input.accountId,
        connectionGeneration,
        startingSignals,
      );
      const context = this.contextByThread.get(contextKey);
      if (context?.turnId) {
        this.options.actors.clearTurn({
          accountId: input.accountId,
          connectionGeneration,
          threadId,
          turnId: context.turnId,
        });
      }
      this.contextByThread.delete(contextKey);
      this.runtimeByThread.delete(threadId);
      this.normalizerByTask.delete(input.taskId);
      throw error;
    }
  }

  async steerTask(
    threadId: string,
    turnId: string,
    prompt: string,
    attachments?: Array<{ name: string; path: string; mimeType: string }>,
  ): Promise<void> {
    const runtime = this.requireRuntime(threadId);
    if (attachments?.length) {
      await runtime.steerTurn(threadId, turnId, prompt, attachments);
    } else {
      await runtime.steerTurn(threadId, turnId, prompt);
    }
  }

  async interruptTask(threadId: string, turnId: string): Promise<void> {
    await this.requireRuntime(threadId).interruptTurn(threadId, turnId);
  }

  async respondApproval(
    requestId: string,
    decision: string,
    context: {
      transport: ApprovalTransportIdentity;
      approvalType: ApprovalDraft["approvalType"];
    },
  ): Promise<void> {
    if (requestId !== context.transport.requestId) {
      throw new Error("Codex approval transport request id does not match the audit id");
    }
    const key = pendingApprovalKey(context.transport);
    const pending = this.pendingApprovals.get(key);
    if (!pending) throw new ApprovalUnavailable("Codex approval request is no longer attached");
    if (pending.approvalType !== context.approvalType) {
      throw new Error("Codex approval type does not match the pending request");
    }
    await pending.rpc.respond(
      pending.rawId,
      approvalResponse(pending.approvalType, pending.params, decision),
    );
    this.pendingApprovals.delete(key);
  }

  async startAccountLogin(account: InternalAccount): Promise<{ loginId: string; authUrl: string }> {
    const managed = await this.options.supervisor.startAccount({
      accountId: account.id,
      codexHome: account.codexHome,
    });
    this.attach(managed);
    return managed.runtime.startChatGptLogin();
  }

  async refreshWeeklyQuota(account: InternalAccount): Promise<WeeklyQuota> {
    const managed = await this.options.supervisor.startAccount({
      accountId: account.id,
      codexHome: account.codexHome,
    });
    this.attach(managed);
    return managed.runtime.readWeeklyQuota();
  }

  async close(): Promise<void> {
    this.removeAllListeners();
    await this.options.supervisor.stopAll();
  }

  private attach(managed: ManagedRuntimePort): number {
    const attached = this.attachedConnectionByAccount.get(managed.accountId);
    if (attached?.rpc === managed.rpc) return attached.generation;
    const generation = (this.lastConnectionGenerationByAccount.get(managed.accountId) ?? 0) + 1;
    this.goalCapabilityByAccount.delete(managed.accountId);
    this.lastConnectionGenerationByAccount.set(managed.accountId, generation);
    this.attachedConnectionByAccount.set(managed.accountId, { rpc: managed.rpc, generation });
    managed.rpc.on("notification", (message: unknown) => {
      this.receiveNotification(managed.accountId, generation, message);
    });
    managed.rpc.on("serverRequest", (message: unknown) => {
      void this.receiveServerRequest(managed.accountId, generation, managed.rpc, message).catch(
        () => this.handleServerRequestFailure(managed.accountId, generation, message),
      );
    });
    return generation;
  }

  private receiveNotification(
    accountId: string,
    connectionGeneration: number,
    value: unknown,
  ): void {
    const threadId = messageThreadId(value);
    const starting = threadId
      ? this.startingSignalsByThread.get(
          connectionThreadKey(accountId, connectionGeneration, threadId),
        )
      : undefined;
    if (starting) {
      starting.push({ kind: "NOTIFICATION", value });
      return;
    }
    this.handleNotification(accountId, connectionGeneration, value);
  }

  private async receiveServerRequest(
    accountId: string,
    connectionGeneration: number,
    rpc: RpcPort,
    value: unknown,
  ): Promise<void> {
    const threadId = messageThreadId(value);
    const starting = threadId
      ? this.startingSignalsByThread.get(
          connectionThreadKey(accountId, connectionGeneration, threadId),
        )
      : undefined;
    if (starting) {
      starting.push({ kind: "SERVER_REQUEST", rpc, value });
      return;
    }
    await this.handleServerRequest(accountId, connectionGeneration, rpc, value);
  }

  private async flushStartingSignals(
    accountId: string,
    connectionGeneration: number,
    contextKey: string,
    signals: BufferedRpcSignal[],
  ): Promise<void> {
    while (signals.length > 0) {
      const signal = signals.shift();
      if (!signal) continue;
      if (signal.kind === "NOTIFICATION") {
        this.handleNotification(accountId, connectionGeneration, signal.value);
        continue;
      }
      try {
        await this.handleServerRequest(accountId, connectionGeneration, signal.rpc, signal.value);
      } catch {
        this.handleServerRequestFailure(accountId, connectionGeneration, signal.value);
        break;
      }
    }
    if (this.startingSignalsByThread.get(contextKey) === signals) {
      this.startingSignalsByThread.delete(contextKey);
    }
  }

  private async rejectStartingServerRequests(
    accountId: string,
    connectionGeneration: number,
    signals: BufferedRpcSignal[],
  ): Promise<void> {
    await Promise.all(
      signals.flatMap((signal) => {
        if (signal.kind !== "SERVER_REQUEST") return [];
        const message = asMessage(signal.value);
        if (message.id === undefined || !signal.rpc.respondError) return [];
        return [
          signal.rpc
            .respondError(message.id, {
              code: -32_601,
              message: "Codex Turn failed to start",
            })
            .catch(() => {
              this.handleServerRequestFailure(accountId, connectionGeneration, signal.value);
            }),
        ];
      }),
    );
  }

  private handleServerRequestFailure(
    accountId: string,
    connectionGeneration: number,
    value: unknown,
  ): void {
    const params = asRecord(asRecord(value).params);
    const threadId = stringValue(params.threadId);
    if (!threadId) return;
    const context = this.contextByThread.get(
      connectionThreadKey(accountId, connectionGeneration, threadId),
    );
    if (!context) return;
    this.detachAccount(accountId, "Codex response delivery failed; recovery is required.");
    void this.options.supervisor.stopAccount?.(accountId).catch(() => undefined);
  }

  private handleNotification(
    accountId: string,
    connectionGeneration: number,
    value: unknown,
  ): void {
    const message = asMessage(value);
    const params = asRecord(message.params);
    if (message.method === "account/login/completed") {
      this.emit(params.success === true ? "accountAuthenticated" : "accountAuthFailed", {
        accountId,
      });
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      if (!isRateLimitSnapshot(params.rateLimits)) return;
      const quota = weeklyQuotaFromRateLimitSnapshot(params.rateLimits);
      if (quota.status === "KNOWN") this.emit("accountQuotaUpdated", { accountId, quota });
      return;
    }
    if (message.method === "thread/goal/updated") {
      const goalThreadId = stringValue(params.threadId);
      if (!goalThreadId) return;
      const goal = asRecord(params.goal);
      const context = this.contextByThread.get(
        connectionThreadKey(accountId, connectionGeneration, goalThreadId),
      );
      if (
        context &&
        typeof goal.status === "string" &&
        Number.isInteger(goal.tokensUsed) &&
        Number.isInteger(goal.timeUsedSeconds) &&
        Number.isInteger(goal.updatedAt)
      ) {
        const status = platformGoalStatusOrNull(goal.status);
        if (!status) {
          const reason = `Unsupported Runtime Goal status: ${goal.status}`;
          this.goalCapabilityByAccount.set(accountId, {
            availability: "UNAVAILABLE",
            reasonCode: "RUNTIME_GOAL_STATUS_UNSUPPORTED",
            reason,
          });
          this.detachAccount(accountId, reason, { sourceTaskId: context.taskId });
          void this.options.supervisor.stopAccount?.(accountId).catch(() => undefined);
          return;
        }
        this.emit("goalUpdated", {
          taskId: context.taskId,
          threadId: context.threadId,
          status,
          tokensUsed: goal.tokensUsed,
          timeUsedSeconds: goal.timeUsedSeconds,
          runtimeUpdatedAt: goal.updatedAt,
        });
      }
      return;
    }
    if (message.method === "thread/goal/cleared") {
      const goalThreadId = stringValue(params.threadId);
      if (!goalThreadId) return;
      const context = this.contextByThread.get(
        connectionThreadKey(accountId, connectionGeneration, goalThreadId),
      );
      if (context) this.emit("goalCleared", { taskId: context.taskId, threadId: context.threadId });
      return;
    }
    const threadId = stringValue(params.threadId);
    if (!threadId) return;
    const context = this.contextByThread.get(
      connectionThreadKey(accountId, connectionGeneration, threadId),
    );
    if (!context) return;
    const normalizer = this.normalizerByTask.get(context.taskId);
    if (!normalizer) return;
    for (const event of normalizer.normalizeNotification(message)) {
      if (event.type === "TURN_STARTED" && event.turnId) {
        context.turnId = event.turnId;
        this.options.actors.bind({
          taskId: context.taskId,
          accountId: context.accountId,
          connectionGeneration: context.connectionGeneration,
          threadId: context.threadId,
          turnId: event.turnId,
          actorContext: context.actorContext,
        });
      }
      if (event.type === "SUBAGENT_ACTIVITY") {
        this.attachSubagentContext(context, event.payload.agentThreadId);
      }
      const draft: TaskEventDraft = {
        taskId: event.taskId,
        threadId: event.threadId,
        turnId: event.turnId,
        ...(context.parentThreadId !== null && event.type !== "SUBAGENT_ACTIVITY"
          ? { subagentThreadId: context.threadId }
          : {}),
        type: event.type,
        payload: event.payload,
      } as TaskEventDraft;
      this.emit("taskEvent", draft);
      if (
        event.turnId &&
        (event.type === "TURN_COMPLETED" ||
          event.type === "TURN_FAILED" ||
          event.type === "TURN_INTERRUPTED")
      ) {
        this.deletePendingApprovalsForTurn(accountId, connectionGeneration, threadId, event.turnId);
        this.options.actors.clearTurn({
          accountId,
          connectionGeneration,
          threadId,
          turnId: event.turnId,
        });
        if (context.turnId === event.turnId) context.turnId = null;
        this.detachDescendantContexts(context);
      }
    }
  }

  private cacheAttachedGoalFailure(threadId: string, error: unknown): void {
    const context = [...this.contextByThread.values()].find(
      (candidate) => candidate.threadId === threadId,
    );
    if (!context) return;
    if (!isMethodNotFoundError(error)) return;
    this.goalCapabilityByAccount.set(context.accountId, {
      availability: "UNAVAILABLE",
      reasonCode: "RUNTIME_GOAL_METHOD_UNSUPPORTED",
      reason: error instanceof Error ? error.message : "Goal Runtime method is unsupported",
    });
  }

  private attachSubagentContext(parent: ThreadContext, childThreadId: string): void {
    if (!childThreadId || childThreadId === parent.threadId) return;
    const key = connectionThreadKey(parent.accountId, parent.connectionGeneration, childThreadId);
    const existing = this.contextByThread.get(key);
    if (existing) {
      if (
        existing.taskId !== parent.taskId ||
        existing.userId !== parent.userId ||
        existing.parentThreadId !== parent.threadId
      ) {
        this.detachAccount(
          parent.accountId,
          "Subagent actor context conflicted with its parent; recovery is required.",
        );
      }
      return;
    }
    this.contextByThread.set(key, {
      taskId: parent.taskId,
      userId: parent.userId,
      accountId: parent.accountId,
      connectionGeneration: parent.connectionGeneration,
      threadId: childThreadId,
      turnId: null,
      parentThreadId: parent.threadId,
      actorContext: cloneActorContext(parent.actorContext),
    });
    const runtime = this.runtimeByThread.get(parent.threadId);
    if (runtime) this.runtimeByThread.set(childThreadId, runtime);
  }

  private detachDescendantContexts(parent: ThreadContext): void {
    const pending = [parent.threadId];
    while (pending.length > 0) {
      const parentThreadId = pending.shift();
      if (!parentThreadId) continue;
      for (const [key, context] of this.contextByThread) {
        if (context.parentThreadId !== parentThreadId) continue;
        pending.push(context.threadId);
        if (context.turnId) {
          this.options.actors.clearTurn({
            accountId: context.accountId,
            connectionGeneration: context.connectionGeneration,
            threadId: context.threadId,
            turnId: context.turnId,
          });
        }
        this.runtimeByThread.delete(context.threadId);
        this.contextByThread.delete(key);
        this.startingSignalsByThread.delete(key);
      }
    }
  }

  private async handleServerRequest(
    accountId: string,
    connectionGeneration: number,
    rpc: RpcPort,
    value: unknown,
  ): Promise<void> {
    const message = asMessage(value);
    if (message.id === undefined) return;
    const params = asRecord(message.params);
    if (message.method === "item/tool/call") {
      const attached = this.attachedConnectionByAccount.get(accountId);
      if (!attached || attached.generation !== connectionGeneration || attached.rpc !== rpc) {
        await rpc.respondError?.(message.id, {
          code: -32_601,
          message: "Tool call is not bound to this App Server connection",
        });
        return;
      }
      const threadId = requiredString(params.threadId, "threadId");
      const turnId = requiredString(params.turnId, "turnId");
      const context = this.contextByThread.get(
        connectionThreadKey(accountId, connectionGeneration, threadId),
      );
      if (
        !context ||
        context.turnId !== turnId ||
        !this.options.actors.resolve({
          accountId,
          connectionGeneration,
          threadId,
          turnId,
        })
      ) {
        await rpc.respondError?.(message.id, {
          code: -32_601,
          message: "Tool call is not bound to this App Server connection",
        });
        return;
      }
      const response = await this.options.tools.invoke({
        accountId,
        connectionGeneration,
        threadId,
        turnId,
        callId: requiredString(params.callId, "callId"),
        namespace: stringValue(params.namespace),
        tool: requiredString(params.tool, "tool"),
        arguments: params.arguments,
      });
      await rpc.respond(message.id, response);
      return;
    }

    const threadId = stringValue(params.threadId);
    const context = threadId
      ? this.contextByThread.get(connectionThreadKey(accountId, connectionGeneration, threadId))
      : null;
    const normalizer = context ? this.normalizerByTask.get(context.taskId) : null;
    const approvalEvent = normalizer?.normalizeServerRequest(message);
    if (approvalEvent?.type === "APPROVAL_REQUESTED" && context && threadId) {
      const requestId = String(message.id);
      const turnId = approvalEvent.turnId ?? requiredString(params.turnId, "turnId");
      if (context.turnId !== turnId) {
        await rpc.respondError?.(message.id, {
          code: -32_601,
          message: "Approval Turn is no longer active",
        });
        return;
      }
      const transport = {
        accountId,
        connectionGeneration,
        threadId,
        turnId,
        requestId,
        rawRpcId: message.id,
      } satisfies ApprovalTransportIdentity;
      this.pendingApprovals.set(pendingApprovalKey(transport), {
        accountId,
        connectionGeneration,
        threadId,
        turnId,
        rpc,
        rawId: message.id,
        approvalType: approvalEvent.payload.approvalType,
        params,
      });
      const rootTurnId = context.parentThreadId !== null ? this.findRootTurnId(context) : null;
      this.emit("approval", {
        requestId,
        rawRpcId: message.id,
        accountId,
        connectionGeneration,
        taskId: context.taskId,
        threadId,
        turnId,
        ...(rootTurnId ? { parentTurnId: rootTurnId } : {}),
        itemId: String(approvalEvent.payload.itemId),
        approvalType: approvalEvent.payload.approvalType,
        payload: params,
      } satisfies ApprovalDraft);
      return;
    }
    await rpc.respondError?.(message.id, {
      code: -32_601,
      message: "Unsupported server request",
    });
  }

  private requireRuntime(threadId: string): RuntimePort {
    const runtime = this.runtimeByThread.get(threadId);
    if (!runtime) throw new Error("Codex thread is not attached to a runtime");
    return runtime;
  }

  private findRootTurnId(context: ThreadContext): string | null {
    let current = context;
    const visited = new Set<string>();
    while (current.parentThreadId !== null) {
      if (visited.has(current.threadId)) return null;
      visited.add(current.threadId);
      const parent = this.contextByThread.get(
        connectionThreadKey(
          current.accountId,
          current.connectionGeneration,
          current.parentThreadId,
        ),
      );
      if (!parent) return null;
      current = parent;
    }
    return current.turnId;
  }

  private handleAccountCrash(event: {
    accountId: string;
    exitCode: number | null;
    signal: string | null;
  }): void {
    this.detachAccount(event.accountId, "Codex App Server exited; recovery is required.");
  }

  private detachAccount(
    accountId: string,
    reason: string,
    source?: { sourceTaskId: string; sourceRuntimeTurnId?: string },
  ): void {
    this.attachedConnectionByAccount.delete(accountId);
    this.goalCapabilityByAccount.delete(accountId);
    for (const [contextKey, context] of this.contextByThread) {
      if (context.accountId !== accountId) continue;
      if (context.turnId) {
        this.options.actors.clearTurn({
          accountId: context.accountId,
          connectionGeneration: context.connectionGeneration,
          threadId: context.threadId,
          turnId: context.turnId,
        });
      }
      this.runtimeByThread.delete(context.threadId);
      this.contextByThread.delete(contextKey);
      this.startingSignalsByThread.delete(contextKey);
      this.normalizerByTask.delete(context.taskId);
    }
    for (const [key, pending] of this.pendingApprovals) {
      if (pending.accountId === accountId) this.pendingApprovals.delete(key);
    }
    this.emit("accountCrashed", { accountId, reason, ...source });
  }

  private deletePendingApprovalsForTurn(
    accountId: string,
    connectionGeneration: number,
    threadId: string,
    turnId: string,
  ): void {
    for (const [key, pending] of this.pendingApprovals) {
      if (
        pending.accountId === accountId &&
        pending.connectionGeneration === connectionGeneration &&
        pending.threadId === threadId &&
        pending.turnId === turnId
      ) {
        this.pendingApprovals.delete(key);
      }
    }
  }
}

async function planFallbackFromModels(
  modelsPromise: Promise<Model[]>,
): Promise<{ model: string | null; reasoningEffort: string }> {
  const models = await modelsPromise;
  const selected = models.find((model) => model.isDefault) ?? models[0];
  if (!selected) throw new Error("Runtime model catalog is empty");
  return {
    model: selected.model,
    reasoningEffort: selected.defaultReasoningEffort,
  };
}

function mapRuntimeModel(model: Model): ModelOption {
  return ModelOptionSchema.parse({
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    isDefault: model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
      value: effort.reasoningEffort,
      description: effort.description,
    })),
    inputModalities: model.inputModalities,
    supportsPersonality: model.supportsPersonality,
  });
}

function connectionThreadKey(accountId: string, generation: number, threadId: string): string {
  return JSON.stringify([accountId, generation, threadId]);
}

function cloneActorContext(actor: ActorContext): ActorContext {
  return {
    tenantKey: actor.tenantKey,
    userId: actor.userId,
    role: actor.role,
    toolScopes: [...actor.toolScopes],
    approvalPolicy: actor.approvalPolicy,
  };
}

function runtimeGoalStatus(status: ThreadGoalView["status"]): "active" | "paused" | "complete" {
  if (status === "ACTIVE") return "active";
  if (status === "COMPLETE") return "complete";
  return "paused";
}

function platformGoalStatus(status: string): ThreadGoalView["status"] {
  const projected = platformGoalStatusOrNull(status);
  if (projected) return projected;
  throw new Error(`Unsupported Runtime Goal status: ${status}`);
}

function platformGoalStatusOrNull(status: string): ThreadGoalView["status"] | null {
  if (status === "active") return "ACTIVE";
  if (status === "complete") return "COMPLETE";
  if (status === "budgetLimited" || status === "usageLimited") return "BUDGET_LIMITED";
  if (status === "paused" || status === "blocked") return "PAUSED";
  return null;
}

function projectRuntimeGoal(
  fallback: ThreadGoalSnapshot | null,
  nativeGoal: {
    objective: string;
    status: string;
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
  },
): ThreadGoalSnapshot {
  const tokenBudget = nativeGoal.tokenBudget ?? fallback?.tokenBudget;
  const objective = nativeGoal.objective || fallback?.objective;
  if (!tokenBudget || !objective) throw new Error("Runtime Goal projection is incomplete");
  return {
    objective,
    status: platformGoalStatus(nativeGoal.status),
    tokenBudget,
    tokensUsed: nativeGoal.tokensUsed,
    timeBudgetSeconds: fallback?.timeBudgetSeconds ?? 3_600,
    timeUsedSeconds: nativeGoal.timeUsedSeconds,
  };
}

function assertGoalProjectionMatches(
  expected: ThreadGoalSnapshot,
  actual: ThreadGoalSnapshot,
): void {
  if (actual.objective !== expected.objective) {
    throw new GoalSyncConflictError("objective", "Runtime Goal objective did not match the write");
  }
  const expectedStatus = platformGoalStatus(runtimeGoalStatus(expected.status));
  if (actual.status !== expectedStatus) {
    throw new GoalSyncConflictError("status", "Runtime Goal status did not match the write");
  }
  if (actual.tokenBudget !== expected.tokenBudget) {
    throw new GoalSyncConflictError(
      "tokenBudget",
      "Runtime Goal token budget did not match the write",
    );
  }
  if (actual.tokensUsed < expected.tokensUsed) {
    throw new GoalSyncConflictError("tokensUsed", "Runtime Goal token usage moved backwards");
  }
  if (actual.timeUsedSeconds < expected.timeUsedSeconds) {
    throw new GoalSyncConflictError("timeUsedSeconds", "Runtime Goal elapsed time moved backwards");
  }
}

function cacheableGoalCapability(capability: GoalRuntimeCapability): boolean {
  return (
    capability.availability === "AVAILABLE" ||
    capability.reasonCode === "RUNTIME_VERSION_UNSUPPORTED" ||
    capability.reasonCode === "RUNTIME_GOAL_METHOD_UNSUPPORTED"
  );
}

function isMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32_601
  );
}

function messageThreadId(value: unknown): string | null {
  return stringValue(asRecord(asMessage(value).params).threadId);
}

function pendingApprovalKey(transport: ApprovalTransportIdentity): string {
  return JSON.stringify([
    transport.accountId,
    transport.connectionGeneration,
    transport.threadId,
    transport.turnId,
    typeof transport.rawRpcId,
    transport.rawRpcId,
  ]);
}

function approvalResponse(
  approvalType: ApprovalDraft["approvalType"],
  params: Record<string, unknown>,
  decision: string,
):
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse
  | PermissionsRequestApprovalResponse {
  if (!isBasicApprovalDecision(decision)) {
    throw new Error(`Unsupported approval decision: ${decision}`);
  }
  if (approvalType === "COMMAND") return { decision };
  if (approvalType === "FILE_CHANGE") return { decision };
  if (decision === "decline" || decision === "cancel") {
    return { permissions: {}, scope: "turn" };
  }
  const requested = asRecord(params.permissions);
  const permissions: PermissionsRequestApprovalResponse["permissions"] = {
    ...(requested.network && typeof requested.network === "object"
      ? {
          network: requested.network as NonNullable<
            PermissionsRequestApprovalResponse["permissions"]["network"]
          >,
        }
      : {}),
    ...(requested.fileSystem && typeof requested.fileSystem === "object"
      ? {
          fileSystem: requested.fileSystem as NonNullable<
            PermissionsRequestApprovalResponse["permissions"]["fileSystem"]
          >,
        }
      : {}),
  };
  return {
    permissions,
    scope: decision === "acceptForSession" ? "session" : "turn",
  };
}

function isBasicApprovalDecision(
  decision: string,
): decision is "accept" | "acceptForSession" | "decline" | "cancel" {
  return ["accept", "acceptForSession", "decline", "cancel"].includes(decision);
}

function extractThreadId(value: unknown): string {
  const thread = asRecord(asRecord(value).thread);
  return stringValue(thread.id) ?? requiredString(asRecord(value).threadId, "threadId");
}

function inspectResumedThread(
  value: ThreadResumeResponse,
  expectedThreadId: string,
):
  | { kind: "IDLE"; threadId: string }
  | {
      kind: "ACTIVE_CONFLICT";
      threadId: string;
      turnId: string | null;
      reason: string;
    } {
  const thread = asRecord(asRecord(value).thread);
  const threadId = requiredString(thread.id, "thread.id");
  if (threadId !== expectedThreadId) {
    throw new Error("Resumed Thread id does not match the requested Thread");
  }
  const status = asRecord(thread.status);
  const statusType = requiredString(status.type, "thread.status.type");
  const turns = thread.turns;
  if (!Array.isArray(turns)) throw new Error("Missing thread.turns");
  const allowedTurnStatuses = new Set(["completed", "interrupted", "failed", "inProgress"]);
  const normalizedTurns = turns.map((turn) => {
    const value = asRecord(turn);
    const id = requiredString(value.id, "thread.turns[].id");
    const turnStatus = requiredString(value.status, "thread.turns[].status");
    if (!allowedTurnStatuses.has(turnStatus)) {
      throw new Error(`Unknown thread.turns[].status: ${turnStatus}`);
    }
    return { id, status: turnStatus };
  });
  const inProgressTurnIds = normalizedTurns
    .filter((turn) => turn.status === "inProgress")
    .map((turn) => turn.id);

  if (statusType === "active") {
    if (!Array.isArray(status.activeFlags)) throw new Error("Invalid thread.status.activeFlags");
    const allowedActiveFlags = new Set(["waitingOnApproval", "waitingOnUserInput"]);
    if (status.activeFlags.some((flag) => !allowedActiveFlags.has(String(flag)))) {
      throw new Error("Unknown thread.status.activeFlags value");
    }
    return {
      kind: "ACTIVE_CONFLICT",
      threadId,
      turnId: inProgressTurnIds.length === 1 ? (inProgressTurnIds[0] as string) : null,
      reason: "Thread already has an active Turn; the new prompt was not accepted",
    };
  }
  if (inProgressTurnIds.length > 0) {
    return {
      kind: "ACTIVE_CONFLICT",
      threadId,
      turnId: inProgressTurnIds.length === 1 ? (inProgressTurnIds[0] as string) : null,
      reason:
        "Thread resume state is inconsistent with an in-progress Turn; the new prompt was not accepted",
    };
  }
  if (!["idle", "notLoaded", "systemError"].includes(statusType)) {
    throw new Error(`Unknown thread.status.type: ${statusType}`);
  }
  if (statusType === "idle" && "activeFlags" in status) {
    throw new Error("Idle thread.status must not contain activeFlags");
  }
  if (statusType !== "idle") {
    throw new Error(`Thread resume did not return an idle Thread: ${statusType}`);
  }
  return { kind: "IDLE", threadId };
}

function extractTurnId(value: unknown): string {
  return requiredString(asRecord(asRecord(value).turn).id, "turn.id");
}

function assertMemoryDisabledResponse(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 0
  ) {
    throw new Error("Invalid thread/memoryMode/set response");
  }
}

function asMessage(value: unknown): {
  id?: number | string;
  method: string;
  params?: unknown;
} {
  const message = asRecord(value);
  return {
    ...(typeof message.id === "string" || typeof message.id === "number" ? { id: message.id } : {}),
    method: requiredString(message.method, "method"),
    params: message.params,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Missing ${field}`);
  return value;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
