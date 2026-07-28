import type {
  EffectiveThreadConfigSnapshot,
  ExecutionPermissionSelection,
} from "@codexplatform/contracts";
import type { Personality } from "./generated/Personality.js";
import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type { ApprovalsReviewer } from "./generated/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "./generated/v2/AskForApproval.js";
import type { Model } from "./generated/v2/Model.js";
import type { ModelListParams } from "./generated/v2/ModelListParams.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import type { SandboxMode } from "./generated/v2/SandboxMode.js";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.js";
import type { ThreadBackgroundTerminalsListResponse } from "./generated/v2/ThreadBackgroundTerminalsListResponse.js";
import type { ThreadBackgroundTerminalsTerminateResponse } from "./generated/v2/ThreadBackgroundTerminalsTerminateResponse.js";
import type { ThreadMemoryModeSetParams } from "./generated/v2/ThreadMemoryModeSetParams.js";
import type { ThreadMemoryModeSetResponse } from "./generated/v2/ThreadMemoryModeSetResponse.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { UserInput } from "./generated/v2/UserInput.js";

export interface RpcPeer {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond?(id: number | string, value: unknown): Promise<void>;
}

export interface DynamicToolDefinition {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonValue;
}

export type WeeklyQuota =
  | {
      status: "KNOWN";
      limitId: string | null;
      usedPercent: number;
      remainingPercent: number;
      windowDurationMins: 10_080;
      resetsAt: number | null;
    }
  | { status: "WEEKLY_QUOTA_UNKNOWN" };

interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName?: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

const MAX_MODEL_CATALOG_PAGES = 100;

export class CodexAppServerRuntime {
  private readonly memoryDisabledThreadIds = new Set<string>();

  constructor(private readonly rpc: RpcPeer) {}

  async initialize(): Promise<{
    userAgent: string;
    codexHome: string;
    platformFamily: string;
    platformOs: string;
  }> {
    const response = await this.rpc.request<{
      userAgent: string;
      codexHome: string;
      platformFamily: string;
      platformOs: string;
    }>("initialize", {
      clientInfo: { name: "codexplatform", title: "CodexPlatform", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.rpc.notify("initialized");
    return response;
  }

  async startChatGptLogin(): Promise<{ loginId: string; authUrl: string }> {
    const response = await this.rpc.request<
      | { type: "chatgpt"; loginId: string; authUrl: string }
      | { type: "chatgptDeviceCode"; loginId: string; verificationUrl: string; userCode: string }
    >("account/login/start", {
      type: "chatgpt",
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
    });
    if (response.type !== "chatgpt") {
      throw new Error(`Unexpected Codex login response: ${response.type}`);
    }
    return { loginId: response.loginId, authUrl: response.authUrl };
  }

  async readWeeklyQuota(): Promise<WeeklyQuota> {
    const response = await this.rpc.request<RateLimitsResponse>("account/rateLimits/read");
    const snapshots = response.rateLimitsByLimitId
      ? Object.entries(response.rateLimitsByLimitId)
          .filter((entry): entry is [string, RateLimitSnapshot] => isRateLimitSnapshot(entry[1]))
          .sort(([leftKey, left], [rightKey, right]) => {
            return codexBucketPriority(rightKey, right) - codexBucketPriority(leftKey, left);
          })
          .map(([, snapshot]) => snapshot)
      : [response.rateLimits];

    for (const snapshot of snapshots) {
      const quota = weeklyQuotaFromRateLimitSnapshot(snapshot);
      if (quota.status === "KNOWN") return quota;
    }
    return { status: "WEEKLY_QUOTA_UNKNOWN" };
  }

  async listModels(): Promise<Model[]> {
    const models: Model[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      if (pageCount >= MAX_MODEL_CATALOG_PAGES) {
        throw new Error(`Codex model/list exceeded ${MAX_MODEL_CATALOG_PAGES} pages`);
      }
      pageCount += 1;

      const params: ModelListParams = {
        cursor,
        limit: 100,
        includeHidden: false,
      };
      const page: ModelListResponse = await this.rpc.request<ModelListResponse>(
        "model/list",
        params,
      );
      models.push(...page.data.filter((model) => !model.hidden));

      if (page.nextCursor !== null) {
        if (seenCursors.has(page.nextCursor)) {
          throw new Error("Codex model/list returned a repeated pagination cursor");
        }
        seenCursors.add(page.nextCursor);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);

    return models;
  }

  async startThread(input: {
    cwd: string;
    dynamicTools: DynamicToolDefinition[];
    effectiveConfig?: EffectiveThreadConfigSnapshot;
  }): Promise<unknown> {
    const params = {
      cwd: input.cwd,
      dynamicTools: input.dynamicTools,
      ...(input.effectiveConfig
        ? threadConfigParams(input.effectiveConfig)
        : { approvalPolicy: "on-request" as const, sandbox: "workspace-write" as const }),
      ephemeral: false,
    } satisfies ThreadStartParams;
    const response = await this.rpc.request("thread/start", params);
    const threadId = extractResponseThreadId(response);
    if (threadId) this.memoryDisabledThreadIds.delete(threadId);
    return response;
  }

  async startTurn(
    threadId: string,
    prompt: string,
    options?: {
      cwd: string;
      effectiveConfig: EffectiveThreadConfigSnapshot;
      attachments?: Array<{ name: string; path: string; mimeType: string }>;
    },
  ): Promise<unknown> {
    if (!this.memoryDisabledThreadIds.has(threadId)) {
      throw new Error("Thread native memory must be disabled before turn/start");
    }
    const userInput: UserInput[] = [];
    if (prompt.length > 0) userInput.push(textInput(prompt));
    for (const attachment of options?.attachments ?? []) {
      userInput.push(
        attachment.mimeType.startsWith("image/")
          ? { type: "localImage", path: attachment.path }
          : { type: "mention", name: attachment.name, path: attachment.path },
      );
    }
    const params = {
      threadId,
      input: userInput,
      ...(options ? turnConfigParams(options.cwd, options.effectiveConfig) : {}),
    } satisfies TurnStartParams;
    return this.rpc.request("turn/start", params);
  }

  async disableThreadMemory(threadId: string): Promise<ThreadMemoryModeSetResponse> {
    const params = {
      threadId,
      mode: "disabled",
    } satisfies ThreadMemoryModeSetParams;
    const response = await this.rpc.request<ThreadMemoryModeSetResponse>(
      "thread/memoryMode/set",
      params,
    );
    if (!isEmptyJsonObject(response)) {
      throw new Error("Invalid thread/memoryMode/set response");
    }
    this.memoryDisabledThreadIds.add(threadId);
    return response;
  }

  steerTurn(threadId: string, turnId: string, prompt: string): Promise<unknown> {
    return this.rpc.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [textInput(prompt)],
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.rpc.request("turn/interrupt", { threadId, turnId });
    let cursor: string | null = null;
    do {
      const page: ThreadBackgroundTerminalsListResponse =
        await this.rpc.request<ThreadBackgroundTerminalsListResponse>(
          "thread/backgroundTerminals/list",
          { threadId, cursor, limit: 100 },
        );
      for (const terminal of page.data) {
        const result = await this.rpc.request<ThreadBackgroundTerminalsTerminateResponse>(
          "thread/backgroundTerminals/terminate",
          { threadId, processId: terminal.processId },
        );
        if (!result.terminated) {
          throw new Error(`Codex background terminal ${terminal.processId} was not terminated`);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    await this.rpc.request("thread/backgroundTerminals/clean", { threadId });
  }

  async resumeThread(
    threadId: string,
    options?: { cwd: string; effectiveConfig: EffectiveThreadConfigSnapshot },
  ): Promise<ThreadResumeResponse> {
    this.memoryDisabledThreadIds.delete(threadId);
    const params = {
      threadId,
      ...(options ? { cwd: options.cwd, ...threadConfigParams(options.effectiveConfig) } : {}),
    } satisfies ThreadResumeParams;
    return this.rpc.request<ThreadResumeResponse>("thread/resume", params);
  }

  async decideServerRequest(requestId: number | string, result: unknown): Promise<void> {
    if (!this.rpc.respond) throw new Error("RPC peer cannot answer server requests");
    await this.rpc.respond(requestId, result);
  }
}

export function weeklyQuotaFromRateLimitSnapshot(snapshot: RateLimitSnapshot): WeeklyQuota {
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (window?.windowDurationMins !== 10_080) continue;
    const usedPercent = clamp(window.usedPercent, 0, 100);
    return {
      status: "KNOWN",
      limitId: snapshot.limitId,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowDurationMins: 10_080,
      resetsAt: window.resetsAt,
    };
  }
  return { status: "WEEKLY_QUOTA_UNKNOWN" };
}

function codexBucketPriority(key: string, snapshot: RateLimitSnapshot): number {
  const candidates = [key, snapshot.limitId, snapshot.limitName]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (candidates.includes("codex")) return 2;
  if (candidates.some((value) => value.includes("codex"))) return 1;
  return 0;
}

function textInput(text: string) {
  return { type: "text" as const, text, text_elements: [] };
}

export function codexPermissionParams(
  selection: ExecutionPermissionSelection,
  cwd: string,
):
  | {
      thread: {
        approvalPolicy: AskForApproval;
        approvalsReviewer: ApprovalsReviewer;
        sandbox: SandboxMode;
      };
      turn: {
        approvalPolicy: AskForApproval;
        approvalsReviewer: ApprovalsReviewer;
        sandboxPolicy: SandboxPolicy;
      };
    }
  | {
      thread: {
        approvalPolicy: AskForApproval;
        approvalsReviewer: ApprovalsReviewer;
        permissions: string;
      };
      turn: {
        approvalPolicy: AskForApproval;
        approvalsReviewer: ApprovalsReviewer;
        permissions: string;
      };
    } {
  if (selection.mode === "CUSTOM") {
    return {
      thread: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        permissions: selection.profileId,
      },
      turn: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        permissions: selection.profileId,
      },
    };
  }

  if (selection.mode === "FULL_ACCESS") {
    return {
      thread: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      },
      turn: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    };
  }

  const approvalsReviewer = selection.mode === "APPROVE_FOR_ME" ? "auto_review" : "user";
  return {
    thread: {
      approvalPolicy: "on-request",
      approvalsReviewer,
      sandbox: "workspace-write",
    },
    turn: {
      approvalPolicy: "on-request",
      approvalsReviewer,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    },
  };
}

function extractResponseThreadId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const thread = (value as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)) return null;
  const id = (thread as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isEmptyJsonObject(value: unknown): value is Record<string, never> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function threadConfigParams(config: EffectiveThreadConfigSnapshot) {
  if (config.permissionMode === "READ_ONLY") {
    return {
      model: config.model,
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "user" as const,
      sandbox: "read-only" as const,
      developerInstructions: config.instructions,
      personality: personality(config),
    } satisfies Partial<ThreadStartParams & ThreadResumeParams>;
  }
  const permission = codexPermissionParams(selectionFromConfig(config), "");
  return {
    model: config.model,
    ...permission.thread,
    developerInstructions: config.instructions,
    personality: personality(config),
  } satisfies Partial<ThreadStartParams & ThreadResumeParams>;
}

function turnConfigParams(cwd: string, config: EffectiveThreadConfigSnapshot) {
  if (config.permissionMode === "READ_ONLY") {
    return {
      model: config.model,
      effort: config.reasoningEffort.toLowerCase(),
      summary: "auto" as const,
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "user" as const,
      sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
      personality: personality(config),
    } satisfies Partial<TurnStartParams>;
  }
  const permission = codexPermissionParams(selectionFromConfig(config), cwd);
  return {
    model: config.model,
    effort: config.reasoningEffort.toLowerCase(),
    summary: "auto" as const,
    ...permission.turn,
    personality: personality(config),
  } satisfies Partial<TurnStartParams>;
}

function selectionFromConfig(config: EffectiveThreadConfigSnapshot): ExecutionPermissionSelection {
  if (config.approvalMode !== "ASK") throw new Error("Unsupported approval mode");
  if (config.permissionMode === "APPROVE_FOR_ME") {
    return { mode: "APPROVE_FOR_ME", profileId: null };
  }
  if (config.permissionMode === "FULL_ACCESS") {
    return { mode: "FULL_ACCESS", profileId: null };
  }
  if (
    config.permissionMode === "DEFAULT" ||
    config.permissionMode === "WORKSPACE_WRITE" ||
    config.permissionMode === "ASK_FOR_APPROVAL"
  ) {
    return { mode: "ASK_FOR_APPROVAL", profileId: null };
  }
  throw new Error("Unsupported permission mode");
}

function personality(config: EffectiveThreadConfigSnapshot): Personality {
  return config.personality.toLowerCase() as Personality;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function isRateLimitSnapshot(value: unknown): value is RateLimitSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    (snapshot.limitId === null || typeof snapshot.limitId === "string") &&
    isRateLimitWindow(snapshot.primary) &&
    isRateLimitWindow(snapshot.secondary)
  );
}

function isRateLimitWindow(value: unknown): value is RateLimitWindow | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const window = value as Record<string, unknown>;
  return (
    typeof window.usedPercent === "number" &&
    (window.windowDurationMins === null || typeof window.windowDurationMins === "number") &&
    (window.resetsAt === null || typeof window.resetsAt === "number")
  );
}
