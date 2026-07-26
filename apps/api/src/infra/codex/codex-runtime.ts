import type { EffectiveThreadConfigSnapshot } from "@codexplatform/contracts";
import type { Personality } from "./generated/Personality.js";
import type { JsonValue } from "./generated/serde_json/JsonValue.js";
import type { SandboxPolicy } from "./generated/v2/SandboxPolicy.js";
import type { ThreadMemoryModeSetParams } from "./generated/v2/ThreadMemoryModeSetParams.js";
import type { ThreadMemoryModeSetResponse } from "./generated/v2/ThreadMemoryModeSetResponse.js";
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";

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

interface RateLimitSnapshot {
  limitId: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

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
      ? Object.values(response.rateLimitsByLimitId).filter(isRateLimitSnapshot)
      : [response.rateLimits];

    for (const snapshot of snapshots) {
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
    }
    return { status: "WEEKLY_QUOTA_UNKNOWN" };
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
    options?: { cwd: string; effectiveConfig: EffectiveThreadConfigSnapshot },
  ): Promise<unknown> {
    if (!this.memoryDisabledThreadIds.has(threadId)) {
      throw new Error("Thread native memory must be disabled before turn/start");
    }
    const params = {
      threadId,
      input: [textInput(prompt)],
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

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.rpc.request("turn/interrupt", { threadId, turnId });
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

function textInput(text: string) {
  return { type: "text" as const, text, text_elements: [] };
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
  return {
    model: config.model,
    approvalPolicy: approvalPolicy(config),
    approvalsReviewer: "user" as const,
    sandbox: sandboxMode(config),
    developerInstructions: config.instructions,
    personality: personality(config),
  } satisfies Partial<ThreadStartParams & ThreadResumeParams>;
}

function turnConfigParams(cwd: string, config: EffectiveThreadConfigSnapshot) {
  return {
    model: config.model,
    effort: config.reasoningEffort.toLowerCase(),
    summary: "auto" as const,
    approvalPolicy: approvalPolicy(config),
    approvalsReviewer: "user" as const,
    sandboxPolicy: sandboxPolicy(cwd, config),
    personality: personality(config),
  } satisfies Partial<TurnStartParams>;
}

function approvalPolicy(config: EffectiveThreadConfigSnapshot): "on-request" {
  if (config.approvalMode !== "ASK") throw new Error("Unsupported approval mode");
  return "on-request";
}

function sandboxMode(config: EffectiveThreadConfigSnapshot): "read-only" | "workspace-write" {
  if (config.permissionMode === "READ_ONLY") return "read-only";
  if (config.permissionMode === "DEFAULT" || config.permissionMode === "WORKSPACE_WRITE") {
    return "workspace-write";
  }
  throw new Error("Unsupported permission mode");
}

function sandboxPolicy(cwd: string, config: EffectiveThreadConfigSnapshot): SandboxPolicy {
  if (config.permissionMode === "READ_ONLY") {
    return { type: "readOnly", networkAccess: false };
  }
  if (config.permissionMode === "DEFAULT" || config.permissionMode === "WORKSPACE_WRITE") {
    return {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    };
  }
  throw new Error("Unsupported permission mode");
}

function personality(config: EffectiveThreadConfigSnapshot): Personality {
  return config.personality.toLowerCase() as Personality;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRateLimitSnapshot(value: RateLimitSnapshot | undefined): value is RateLimitSnapshot {
  return value !== undefined;
}
