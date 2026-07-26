import { EventEmitter } from "node:events";
import type { InternalAccount } from "../../domain/account-admin-store.js";
import type {
  ApprovalDraft,
  TaskEventDraft,
  TaskExecutionAdapter,
} from "../../domain/platform-service.js";
import { ApprovalTransportUnavailableError as ApprovalUnavailable } from "../../domain/platform-service.js";
import type { ApprovalTransportIdentity } from "../../domain/platform-store.js";
import type { ActorRegistry } from "../../tools/actor-registry.js";
import type { DynamicToolCall, DynamicToolResponse } from "../../tools/tool-runtime.js";
import type { WeeklyQuota } from "./codex-runtime.js";
import { CodexEventNormalizer } from "./event-normalizer.js";
import type { CommandExecutionRequestApprovalResponse } from "./generated/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./generated/v2/FileChangeRequestApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.js";

interface RpcPort extends EventEmitter {
  respond(id: number | string, result: unknown): Promise<void>;
  respondError?(id: number | string, error: { code: number; message: string }): Promise<void>;
}

interface RuntimePort {
  startThread(input: {
    cwd: string;
    dynamicTools: ReturnType<ToolRuntimePort["definitions"]>;
  }): Promise<unknown>;
  resumeThread(threadId: string): Promise<unknown>;
  startTurn(threadId: string, prompt: string): Promise<unknown>;
  steerTurn(threadId: string, turnId: string, prompt: string): Promise<unknown>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  startChatGptLogin(): Promise<{ loginId: string; authUrl: string }>;
  readWeeklyQuota(): Promise<WeeklyQuota>;
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
  definitions(): Array<{
    type: "function";
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  invoke(call: DynamicToolCall): Promise<DynamicToolResponse>;
}

interface AdapterOptions {
  supervisor: RuntimeSupervisorPort;
  tools: ToolRuntimePort;
  actors: ActorRegistry;
}

interface ThreadContext {
  taskId: string;
  userId: string;
  accountId: string;
  connectionGeneration: number;
  threadId: string;
  turnId: string | null;
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

  constructor(private readonly options: AdapterOptions) {
    super();
    options.supervisor.on?.("accountCrashed", (event) => this.handleAccountCrash(event));
  }

  async startTask(input: {
    accountId: string;
    codexHome: string;
    taskId: string;
    userId: string;
    cwd: string;
    prompt: string;
    existingThreadId: string | null;
  }): Promise<{ threadId: string; turnId: string }> {
    const managed = await this.options.supervisor.startAccount({
      accountId: input.accountId,
      codexHome: input.codexHome,
    });
    const connectionGeneration = this.attach(managed);
    const threadId = input.existingThreadId
      ? extractThreadId(
          await managed.runtime.resumeThread(input.existingThreadId),
          input.existingThreadId,
        )
      : extractThreadId(
          await managed.runtime.startThread({
            cwd: input.cwd,
            dynamicTools: this.options.tools.definitions(),
          }),
        );
    const contextKey = connectionThreadKey(input.accountId, connectionGeneration, threadId);
    this.contextByThread.set(contextKey, {
      taskId: input.taskId,
      userId: input.userId,
      accountId: input.accountId,
      connectionGeneration,
      threadId,
      turnId: null,
    });
    this.runtimeByThread.set(threadId, managed.runtime);
    this.normalizerByTask.set(input.taskId, new CodexEventNormalizer({ taskId: input.taskId }));
    const startingSignals: BufferedRpcSignal[] = [];
    this.startingSignalsByThread.set(contextKey, startingSignals);
    try {
      const turnId = extractTurnId(await managed.runtime.startTurn(threadId, input.prompt));
      const context = this.contextByThread.get(contextKey);
      if (!context) throw new Error("Codex Turn context detached while starting");
      context.turnId = turnId;
      this.options.actors.bind(threadId, {
        taskId: input.taskId,
        userId: input.userId,
        accountId: input.accountId,
        turnId,
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
      if (context?.turnId) this.options.actors.clearTurn(threadId, context.turnId);
      this.contextByThread.delete(contextKey);
      this.runtimeByThread.delete(threadId);
      this.normalizerByTask.delete(input.taskId);
      throw error;
    }
  }

  async steerTask(threadId: string, turnId: string, prompt: string): Promise<void> {
    await this.requireRuntime(threadId).steerTurn(threadId, turnId, prompt);
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
    const threadId = stringValue(params.threadId);
    if (!threadId) return;
    const context = this.contextByThread.get(
      connectionThreadKey(accountId, connectionGeneration, threadId),
    );
    if (!context) return;
    const normalizer = this.normalizerByTask.get(context.taskId);
    if (!normalizer) return;
    for (const event of normalizer.normalizeNotification(message)) {
      const draft: TaskEventDraft = {
        taskId: event.taskId,
        threadId: event.threadId,
        turnId: event.turnId,
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
        this.options.actors.clearTurn(threadId, event.turnId);
        if (context.turnId === event.turnId) context.turnId = null;
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
      const response = await this.options.tools.invoke({
        threadId: requiredString(params.threadId, "threadId"),
        turnId: requiredString(params.turnId, "turnId"),
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
      this.emit("approval", {
        requestId,
        rawRpcId: message.id,
        accountId,
        connectionGeneration,
        taskId: context.taskId,
        threadId,
        turnId,
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

  private handleAccountCrash(event: {
    accountId: string;
    exitCode: number | null;
    signal: string | null;
  }): void {
    this.detachAccount(event.accountId, "Codex App Server exited; recovery is required.");
  }

  private detachAccount(accountId: string, reason: string): void {
    this.attachedConnectionByAccount.delete(accountId);
    this.emit("accountCrashed", { accountId });
    for (const [contextKey, context] of this.contextByThread) {
      if (context.accountId !== accountId) continue;
      if (context.turnId) {
        this.emit("taskEvent", {
          taskId: context.taskId,
          threadId: context.threadId,
          turnId: context.turnId,
          type: "RECOVERY_REQUIRED",
          payload: { reason },
        } satisfies TaskEventDraft<"RECOVERY_REQUIRED">);
        this.options.actors.clearTurn(context.threadId, context.turnId);
      }
      this.runtimeByThread.delete(context.threadId);
      this.contextByThread.delete(contextKey);
      this.startingSignalsByThread.delete(contextKey);
      this.normalizerByTask.delete(context.taskId);
    }
    for (const [key, pending] of this.pendingApprovals) {
      if (pending.accountId === accountId) this.pendingApprovals.delete(key);
    }
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

function connectionThreadKey(accountId: string, generation: number, threadId: string): string {
  return JSON.stringify([accountId, generation, threadId]);
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

function extractThreadId(value: unknown, fallback?: string): string {
  const thread = asRecord(asRecord(value).thread);
  return stringValue(thread.id) ?? fallback ?? requiredString(asRecord(value).threadId, "threadId");
}

function extractTurnId(value: unknown): string {
  return requiredString(asRecord(asRecord(value).turn).id, "turn.id");
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
