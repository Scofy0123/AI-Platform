import { describe, expect, test, vi } from "vitest";
import { CodexAppServerRuntime, codexPermissionParams, type RpcPeer } from "./codex-runtime.js";
import type { Model } from "./generated/v2/Model.js";

describe("CodexAppServerRuntime", () => {
  test("maps Ask for approval to workspace sandbox and user review", () => {
    expect(
      codexPermissionParams({ mode: "ASK_FOR_APPROVAL", profileId: null }, "/workspace"),
    ).toEqual({
      thread: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
      turn: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
    });
  });

  test("maps Approve for me to auto review without widening the sandbox", () => {
    expect(
      codexPermissionParams({ mode: "APPROVE_FOR_ME", profileId: null }, "/workspace"),
    ).toMatchObject({
      thread: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
      },
      turn: {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
      },
    });
  });

  test("maps Full access to danger-full-access without routine approval", () => {
    expect(codexPermissionParams({ mode: "FULL_ACCESS", profileId: null }, "/workspace")).toEqual({
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
    });
  });

  test("maps Custom to a permission profile without a sandbox policy", () => {
    expect(
      codexPermissionParams({ mode: "CUSTOM", profileId: "restricted-network" }, "/workspace"),
    ).toEqual({
      thread: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        permissions: "restricted-network",
      },
      turn: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        permissions: "restricted-network",
      },
    });
  });

  test("performs the initialize then initialized handshake with experimental APIs enabled", async () => {
    const rpc = new FakeRpc({
      initialize: {
        userAgent: "codex/0.144.6",
        codexHome: "/tmp/account-1",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.initialize()).resolves.toMatchObject({ userAgent: "codex/0.144.6" });
    expect(rpc.requests[0]).toEqual({
      method: "initialize",
      params: {
        clientInfo: { name: "codexplatform", title: "CodexPlatform", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    expect(rpc.notifications).toEqual([{ method: "initialized", params: undefined }]);
  });

  test("starts browser login and exposes the returned auth URL", async () => {
    const rpc = new FakeRpc({
      "account/login/start": {
        type: "chatgpt",
        loginId: "login-1",
        authUrl: "https://auth.example.test/start",
      },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.startChatGptLogin()).resolves.toEqual({
      loginId: "login-1",
      authUrl: "https://auth.example.test/start",
    });
    expect(rpc.requests[0]).toEqual({
      method: "account/login/start",
      params: { type: "chatgpt", codexStreamlinedLogin: true, useHostedLoginSuccessPage: true },
    });
  });

  test("recognizes only an exact seven-day quota bucket", async () => {
    const rpc = new FakeRpc({
      "account/rateLimits/read": {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 },
          secondary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_785_225_600 },
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.readWeeklyQuota()).resolves.toEqual({
      status: "KNOWN",
      limitId: "codex",
      usedPercent: 35,
      remainingPercent: 65,
      windowDurationMins: 10_080,
      resetsAt: 1_785_225_600,
    });
  });

  test("prefers the codex weekly bucket when multiple seven-day limits are returned", async () => {
    const rpc = new FakeRpc({
      "account/rateLimits/read": {
        rateLimits: {
          limitId: "legacy",
          primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1 },
          secondary: null,
        },
        rateLimitsByLimitId: {
          other: {
            limitId: "other",
            limitName: "Other product",
            primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 2 },
            secondary: null,
          },
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 3 },
            secondary: null,
          },
        },
        rateLimitResetCredits: null,
      },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.readWeeklyQuota()).resolves.toEqual({
      status: "KNOWN",
      limitId: "codex",
      usedPercent: 42,
      remainingPercent: 58,
      windowDurationMins: 10_080,
      resetsAt: 3,
    });
  });

  test("returns WEEKLY_QUOTA_UNKNOWN rather than substituting a short window", async () => {
    const rpc = new FakeRpc({
      "account/rateLimits/read": {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1 },
          secondary: null,
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.readWeeklyQuota()).resolves.toEqual({ status: "WEEKLY_QUOTA_UNKNOWN" });
  });

  test("reads every visible model page in runtime order", async () => {
    const modelA = runtimeModel("model-a");
    const hiddenModel = runtimeModel("hidden-model", { hidden: true });
    const modelB = runtimeModel("model-b");
    const rpc = new FakeRpc({
      "model/list": (params: unknown) =>
        (params as { cursor: string | null }).cursor === null
          ? { data: [modelA], nextCursor: "page-2" }
          : { data: [hiddenModel, modelB], nextCursor: null },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.listModels()).resolves.toEqual([modelA, modelB]);
    expect(rpc.requests).toEqual([
      {
        method: "model/list",
        params: { cursor: null, limit: 100, includeHidden: false },
      },
      {
        method: "model/list",
        params: { cursor: "page-2", limit: 100, includeHidden: false },
      },
    ]);
  });

  test("fails closed when model pagination repeats a cursor", async () => {
    const rpc = new FakeRpc({
      "model/list": { data: [runtimeModel("model-a")], nextCursor: "repeat" },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.listModels()).rejects.toThrow("repeated pagination cursor");
    expect(rpc.requests).toHaveLength(2);
  });

  test("fails closed when model pagination exceeds its page budget", async () => {
    let page = 0;
    const rpc = new FakeRpc({
      "model/list": () => {
        page += 1;
        return { data: [], nextCursor: page <= 100 ? `page-${page}` : null };
      },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.listModels()).rejects.toThrow("exceeded 100 pages");
    expect(rpc.requests).toHaveLength(100);
  });

  test("starts a thread with dynamic tools and starts, steers, then interrupts a turn", async () => {
    const rpc = new FakeRpc({
      "thread/start": { thread: { id: "thread-1" }, model: "gpt-5", cwd: "/workspace" },
      "thread/memoryMode/set": {},
      "turn/start": { turn: { id: "turn-1" } },
      "turn/steer": { turnId: "turn-1" },
      "turn/interrupt": {},
      "thread/backgroundTerminals/list": {
        data: [
          {
            itemId: "command-1",
            processId: "process-1",
            command: "long-running-command",
            cwd: "/workspace",
            osPid: 123,
            cpuPercent: 0,
            rssKb: null,
          },
        ],
        nextCursor: null,
      },
      "thread/backgroundTerminals/terminate": { terminated: true },
      "thread/backgroundTerminals/clean": {},
    });
    const runtime = new CodexAppServerRuntime(rpc);
    const tools = [
      {
        type: "function" as const,
        name: "feishu_doc_read",
        description: "Read a Feishu document",
        inputSchema: { type: "object", properties: { url: { type: "string" } } },
      },
    ];

    await expect(
      runtime.startThread({ cwd: "/workspace", dynamicTools: tools }),
    ).resolves.toMatchObject({ thread: { id: "thread-1" } });
    await expect(runtime.disableThreadMemory("thread-1")).resolves.toEqual({});
    await expect(runtime.startTurn("thread-1", "Summarize this repo")).resolves.toEqual({
      turn: { id: "turn-1" },
    });
    await runtime.steerTurn("thread-1", "turn-1", "Focus on security");
    await runtime.interruptTurn("thread-1", "turn-1");

    expect(rpc.requests).toEqual([
      {
        method: "thread/start",
        params: {
          cwd: "/workspace",
          dynamicTools: tools,
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          ephemeral: false,
        },
      },
      {
        method: "thread/memoryMode/set",
        params: {
          threadId: "thread-1",
          mode: "disabled",
        },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: "Summarize this repo", text_elements: [] }],
        },
      },
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [{ type: "text", text: "Focus on security", text_elements: [] }],
        },
      },
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
      {
        method: "thread/backgroundTerminals/list",
        params: { threadId: "thread-1", cursor: null, limit: 100 },
      },
      {
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: "thread-1", processId: "process-1" },
      },
      {
        method: "thread/backgroundTerminals/clean",
        params: { threadId: "thread-1" },
      },
    ]);
  });

  test("terminates background terminals across every pagination page after an interrupt", async () => {
    const rpc = new FakeRpc({
      "turn/interrupt": {},
      "thread/backgroundTerminals/list": (params: unknown) =>
        (params as { cursor: string | null }).cursor === null
          ? {
              data: [
                {
                  itemId: "command-1",
                  processId: "process-1",
                  command: "first",
                  cwd: "/workspace",
                  osPid: 1,
                  cpuPercent: null,
                  rssKb: null,
                },
              ],
              nextCursor: "page-2",
            }
          : {
              data: [
                {
                  itemId: "command-2",
                  processId: "process-2",
                  command: "second",
                  cwd: "/workspace",
                  osPid: 2,
                  cpuPercent: null,
                  rssKb: null,
                },
              ],
              nextCursor: null,
            },
      "thread/backgroundTerminals/terminate": { terminated: true },
      "thread/backgroundTerminals/clean": {},
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await runtime.interruptTurn("thread-1", "turn-1");

    expect(rpc.requests.slice(1)).toEqual([
      {
        method: "thread/backgroundTerminals/list",
        params: { threadId: "thread-1", cursor: null, limit: 100 },
      },
      {
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: "thread-1", processId: "process-1" },
      },
      {
        method: "thread/backgroundTerminals/list",
        params: { threadId: "thread-1", cursor: "page-2", limit: 100 },
      },
      {
        method: "thread/backgroundTerminals/terminate",
        params: { threadId: "thread-1", processId: "process-2" },
      },
      {
        method: "thread/backgroundTerminals/clean",
        params: { threadId: "thread-1" },
      },
    ]);
  });

  test("fails closed when Codex reports that a background terminal survived termination", async () => {
    const rpc = new FakeRpc({
      "turn/interrupt": {},
      "thread/backgroundTerminals/list": {
        data: [
          {
            itemId: "command-1",
            processId: "process-1",
            command: "still-running",
            cwd: "/workspace",
            osPid: 123,
            cpuPercent: null,
            rssKb: null,
          },
        ],
        nextCursor: null,
      },
      "thread/backgroundTerminals/terminate": { terminated: false },
      "thread/backgroundTerminals/clean": {},
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.interruptTurn("thread-1", "turn-1")).rejects.toThrow(
      "process-1 was not terminated",
    );
    expect(rpc.requests).not.toContainEqual({
      method: "thread/backgroundTerminals/clean",
      params: { threadId: "thread-1" },
    });
  });

  test("propagates a native memory disable failure without issuing a Turn request", async () => {
    const rpc = new FakeRpc({
      "thread/memoryMode/set": new Error("memory mode unavailable"),
      "turn/start": { turn: { id: "turn-must-not-start" } },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.disableThreadMemory("thread-1")).rejects.toThrow(
      "memory mode unavailable",
    );
    await expect(runtime.startTurn("thread-1", "Must not run")).rejects.toThrow(
      "native memory must be disabled",
    );
    expect(rpc.requests).toEqual([
      {
        method: "thread/memoryMode/set",
        params: { threadId: "thread-1", mode: "disabled" },
      },
    ]);
  });

  test("refuses turn/start when the caller skips the native memory gate", async () => {
    const rpc = new FakeRpc({
      "turn/start": { turn: { id: "turn-must-not-start" } },
    });
    const runtime = new CodexAppServerRuntime(rpc);

    await expect(runtime.startTurn("thread-1", "Must not run")).rejects.toThrow(
      "native memory must be disabled",
    );
    expect(rpc.requests).toEqual([]);
  });

  test.each([null, [], { accepted: true }])(
    "rejects a malformed native memory response: %j",
    async (response) => {
      const rpc = new FakeRpc({
        "thread/memoryMode/set": response,
        "turn/start": { turn: { id: "turn-must-not-start" } },
      });
      const runtime = new CodexAppServerRuntime(rpc);

      await expect(runtime.disableThreadMemory("thread-1")).rejects.toThrow(
        "Invalid thread/memoryMode/set response",
      );
      await expect(runtime.startTurn("thread-1", "Must not run")).rejects.toThrow(
        "native memory must be disabled",
      );
      expect(rpc.requests).toEqual([
        {
          method: "thread/memoryMode/set",
          params: { threadId: "thread-1", mode: "disabled" },
        },
      ]);
    },
  );

  test("maps an effective platform snapshot to real thread/start and turn/start fields", async () => {
    const rpc = new FakeRpc({
      "thread/start": { thread: { id: "thread-1" } },
      "thread/memoryMode/set": {},
      "turn/start": { turn: { id: "turn-1" } },
    });
    const runtime = new CodexAppServerRuntime(rpc);
    const config = {
      model: "gpt-5-codex",
      reasoningEffort: "HIGH",
      permissionMode: "READ_ONLY",
      approvalMode: "ASK",
      personality: "FRIENDLY",
      instructions: "Use the employee's Feishu identity.",
      sourceVersion: "org-policy-v1",
    } as const;

    await runtime.startThread({ cwd: "/workspace", dynamicTools: [], effectiveConfig: config });
    await runtime.disableThreadMemory("thread-1");
    await runtime.startTurn("thread-1", "Inspect", {
      cwd: "/workspace",
      effectiveConfig: config,
    });

    expect(rpc.requests).toEqual([
      {
        method: "thread/start",
        params: {
          cwd: "/workspace",
          dynamicTools: [],
          model: "gpt-5-codex",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "read-only",
          developerInstructions: "Use the employee's Feishu identity.",
          personality: "friendly",
          ephemeral: false,
        },
      },
      {
        method: "thread/memoryMode/set",
        params: { threadId: "thread-1", mode: "disabled" },
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: "Inspect", text_elements: [] }],
          model: "gpt-5-codex",
          effort: "high",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          personality: "friendly",
          summary: "auto",
        },
      },
    ]);
  });

  test("reapplies the immutable snapshot when resuming and preserves explicit empty instructions", async () => {
    const rpc = new FakeRpc({
      "thread/resume": { thread: { id: "thread-1" } },
    });
    const runtime = new CodexAppServerRuntime(rpc);
    const config = {
      model: null,
      reasoningEffort: "ULTRA",
      permissionMode: "WORKSPACE_WRITE",
      approvalMode: "ASK",
      personality: "NONE",
      instructions: "",
      sourceVersion: "org-policy-v1",
    } as const;

    await runtime.resumeThread("thread-1", {
      cwd: "/workspace",
      effectiveConfig: config,
    });

    expect(rpc.requests).toEqual([
      {
        method: "thread/resume",
        params: {
          threadId: "thread-1",
          cwd: "/workspace",
          model: null,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
          developerInstructions: "",
          personality: "none",
        },
      },
    ]);
  });

  test("waits for the transport acknowledgement when answering a server request", async () => {
    const acknowledgement = deferred<void>();
    const respond = vi.fn(() => acknowledgement.promise);
    const rpc = Object.assign(new FakeRpc({}), { respond });
    const runtime = new CodexAppServerRuntime(rpc);
    let settled = false;

    const response = Promise.resolve(
      runtime.decideServerRequest(7, { decision: "accept" }),
    ).finally(() => {
      settled = true;
    });
    await nextTick();

    expect(settled).toBe(false);
    expect(respond).toHaveBeenCalledWith(7, { decision: "accept" });

    acknowledgement.resolve();
    await expect(response).resolves.toBeUndefined();
  });
});

class FakeRpc implements RpcPeer {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];

  constructor(
    private readonly responses: Record<string, unknown | ((params: unknown) => unknown)>,
  ) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    const configured = this.responses[method];
    const response = typeof configured === "function" ? configured(params) : configured;
    if (response instanceof Error) throw response;
    return response as T;
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function runtimeModel(id: string, overrides: Partial<Model> = {}): Model {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: "",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    ...overrides,
  };
}
