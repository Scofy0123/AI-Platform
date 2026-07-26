export interface RpcPeer {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond?(id: number | string, value: unknown): Promise<void>;
}

export interface DynamicToolDefinition {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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

  startThread(input: { cwd: string; dynamicTools: DynamicToolDefinition[] }): Promise<unknown> {
    return this.rpc.request("thread/start", {
      cwd: input.cwd,
      dynamicTools: input.dynamicTools,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
    });
  }

  startTurn(threadId: string, prompt: string): Promise<unknown> {
    return this.rpc.request("turn/start", {
      threadId,
      input: [textInput(prompt)],
    });
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

  resumeThread(threadId: string): Promise<unknown> {
    return this.rpc.request("thread/resume", { threadId });
  }

  async decideServerRequest(requestId: number | string, result: unknown): Promise<void> {
    if (!this.rpc.respond) throw new Error("RPC peer cannot answer server requests");
    await this.rpc.respond(requestId, result);
  }
}

function textInput(text: string) {
  return { type: "text" as const, text, text_elements: [] };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRateLimitSnapshot(value: RateLimitSnapshot | undefined): value is RateLimitSnapshot {
  return value !== undefined;
}
