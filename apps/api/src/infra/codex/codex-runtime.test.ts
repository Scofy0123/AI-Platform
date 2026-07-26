import { describe, expect, test, vi } from "vitest";
import { CodexAppServerRuntime, type RpcPeer } from "./codex-runtime.js";

describe("CodexAppServerRuntime", () => {
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

  test("starts a thread with dynamic tools and starts, steers, then interrupts a turn", async () => {
    const rpc = new FakeRpc({
      "thread/start": { thread: { id: "thread-1" }, model: "gpt-5", cwd: "/workspace" },
      "turn/start": { turn: { id: "turn-1" } },
      "turn/steer": { turnId: "turn-1" },
      "turn/interrupt": {},
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

  constructor(private readonly responses: Record<string, unknown>) {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    return this.responses[method] as T;
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
