import { EventEmitter } from "node:events";
import type {
  Bootstrap,
  ComposerCapability,
  ModelCatalog,
  ModelOption,
  TaskDetail,
  TaskEvent,
  Thread,
  UserSettingsView,
} from "@codexplatform/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ActiveTurnResumeConflictError,
  InvalidThreadResumeResponseError,
  ModelCatalogUnavailableError,
} from "./domain/platform-service.js";
import { buildApp, readMultipartStream, streamTaskEvents, subscribeWithReplay } from "./server.js";
import type { AuthApi, PlatformApi } from "./web-api.js";

const STANDARD_MODEL: ModelOption = {
  id: "fake-codex-standard",
  model: "fake-codex-standard",
  displayName: "Fake Codex Standard",
  description: "Deterministic test model",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ value: "medium", description: "Balanced" }],
  inputModalities: ["text"],
  supportsPersonality: false,
};

describe("CodexPlatform HTTP API", () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  test("completes Feishu OAuth and sets HttpOnly SameSite session cookies", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform, webOrigin: "http://127.0.0.1:5173" });
    apps.push(app);

    const start = await app.inject({ method: "GET", url: "/api/auth/feishu/start" });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toBe("https://auth.example.test/start");
    expect(start.headers["set-cookie"]).toContain(
      "codexplatform_oauth_binding=binding-1; Max-Age=600; Path=/api/auth/feishu/callback; HttpOnly; SameSite=Lax",
    );

    const missingBinding = await app.inject({
      method: "GET",
      url: "/api/auth/feishu/callback?code=code-1&state=state-1",
    });
    expect(missingBinding.statusCode).toBe(400);

    const wrongBinding = await app.inject({
      method: "GET",
      url: "/api/auth/feishu/callback?code=code-1&state=state-1",
      cookies: { codexplatform_oauth_binding: "wrong-binding" },
    });
    expect(wrongBinding.statusCode).toBe(400);

    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/feishu/callback?code=code-1&state=state-1",
      cookies: { codexplatform_oauth_binding: "binding-1" },
    });
    expect(callback.statusCode).toBe(302);
    const cookies = callback.headers["set-cookie"];
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "codexplatform_session=valid-session; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict",
        ),
        expect.stringContaining(
          "codexplatform_csrf=valid-csrf; Max-Age=2592000; Path=/; SameSite=Strict",
        ),
        expect.stringContaining(
          "codexplatform_oauth_binding=; Max-Age=0; Path=/api/auth/feishu/callback; HttpOnly; SameSite=Lax",
        ),
      ]),
    );
    expect(auth.completeLogin).toHaveBeenCalledWith({
      code: "code-1",
      state: "state-1",
      browserBinding: "binding-1",
    });

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { codexplatform_session: "valid-session" },
    });
    expect(session.json()).toMatchObject({
      expiresAt: "2099-01-01T00:00:00.000Z",
      persistent: false,
      feishuConnectionStatus: "CONNECTED",
    });

    const persist = await app.inject({
      method: "POST",
      url: "/api/auth/session/persist",
      headers: { "x-csrf-token": "valid-csrf" },
      cookies: {
        codexplatform_session: "valid-session",
        codexplatform_csrf: "valid-csrf",
      },
    });
    expect(persist.statusCode).toBe(200);
    expect(auth.persistSession).toHaveBeenCalledWith("valid-session");
    expect(persist.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("codexplatform_session=valid-session; Max-Age=2592000"),
        expect.stringContaining("codexplatform_csrf=valid-csrf; Max-Age=2592000"),
      ]),
    );

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { "x-csrf-token": "valid-csrf" },
      cookies: {
        codexplatform_session: "valid-session",
        codexplatform_csrf: "valid-csrf",
      },
    });
    expect(logout.statusCode).toBe(204);
    expect(auth.revokeSession).toHaveBeenCalledWith("valid-session");
    expect(logout.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("codexplatform_session=; Max-Age=0"),
        expect.stringContaining("codexplatform_csrf=; Max-Age=0"),
      ]),
    );

    const replay = await app.inject({
      method: "GET",
      url: "/api/auth/feishu/callback?code=code-1&state=state-1",
      cookies: { codexplatform_oauth_binding: "binding-1" },
    });
    expect(replay.statusCode).toBe(400);
  });

  test("clears stale authentication cookies when the server session is invalid", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform, webOrigin: "http://127.0.0.1:5173" });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { codexplatform_session: "expired-session" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("codexplatform_session=; Max-Age=0"),
        expect.stringContaining("codexplatform_csrf=; Max-Age=0"),
      ]),
    );
  });

  test("marks authentication cookies Secure for an HTTPS web origin", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform, webOrigin: "https://localhost:5173" });
    apps.push(app);

    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/feishu/callback?code=code-1&state=state-1",
      cookies: { codexplatform_oauth_binding: "binding-1" },
    });

    expect(callback.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "codexplatform_session=valid-session; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Strict",
        ),
        expect.stringContaining(
          "codexplatform_csrf=valid-csrf; Max-Age=2592000; Path=/; Secure; SameSite=Strict",
        ),
      ]),
    );
  });

  test("buffers events published during replay and emits every sequence once", async () => {
    const event = (sequence: number) => ({
      taskId: "task-1",
      threadId: "thread-1",
      turnId: "turn-1",
      sequence,
      timestamp: "2026-07-21T12:00:00.000Z",
      type: "AGENT_MESSAGE_DELTA" as const,
      payload: { delta: `chunk-${sequence}` },
    });
    const emitted: number[] = [];
    let listener: ((value: ReturnType<typeof event>) => void) | undefined;
    const unsubscribe = vi.fn();

    const stop = await subscribeWithReplay({
      afterSequence: 4,
      subscribe(next) {
        listener = next;
        return unsubscribe;
      },
      async loadReplay() {
        listener?.(event(6));
        return [event(5), event(6)];
      },
      emit(value) {
        emitted.push(value.sequence);
      },
    });
    listener?.(event(7));

    expect(emitted).toEqual([5, 6, 7]);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("closes an SSE subscription when its session expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    try {
      const raw = Object.assign(new EventEmitter(), {
        writeHead: vi.fn(),
        write: vi.fn(() => true),
        end: vi.fn(function (this: EventEmitter) {
          this.emit("close");
        }),
        destroy: vi.fn(),
      });
      const unsubscribe = vi.fn();

      await streamTaskEvents({ hijack: vi.fn(), raw } as never, {
        afterSequence: 0,
        loadReplay: async () => [],
        subscribe: () => unsubscribe,
        sessionExpiresAt: new Date("2026-07-21T12:00:01.000Z"),
        isSessionValid: () => true,
      });
      await vi.advanceTimersByTimeAsync(1_001);

      expect(raw.end).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not overflow the SSE expiry timer for a 30 day trusted session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
    try {
      const raw = Object.assign(new EventEmitter(), {
        destroyed: false,
        writableEnded: false,
        writeHead: vi.fn(),
        write: vi.fn(() => true),
        end: vi.fn(),
        destroy: vi.fn(),
      });

      await streamTaskEvents({ hijack: vi.fn(), raw } as never, {
        afterSequence: 0,
        loadReplay: async () => [],
        subscribe: () => vi.fn(),
        sessionExpiresAt: new Date("2026-08-20T12:00:00.000Z"),
        isSessionValid: () => true,
      });
      await vi.advanceTimersByTimeAsync(1);

      expect(raw.end).not.toHaveBeenCalled();
      raw.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });

  test("redacts a shared account alias from live SSE events", async () => {
    const raw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    let listener: ((event: never) => void) | undefined;
    const unsubscribe = vi.fn();

    await streamTaskEvents({ hijack: vi.fn(), raw } as never, {
      afterSequence: 0,
      loadReplay: async () => [],
      subscribe: (next) => {
        listener = next as (event: never) => void;
        return unsubscribe;
      },
      sessionExpiresAt: new Date(Date.now() + 60_000),
      isSessionValid: () => true,
      hideAccountAlias: true,
    });
    listener?.({
      taskId: "task-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "lease:turn-1",
      sequence: 1,
      timestamp: "2026-07-21T12:00:00.000Z",
      type: "LEASE_ACQUIRED",
      payload: { accountAlias: "Codex A" },
    } as never);

    expect(raw.write).toHaveBeenCalledWith(
      expect.stringContaining('event: LEASE_ACQUIRED\ndata: {"taskId":"task-1"'),
    );
    expect(raw.write).toHaveBeenCalledWith(expect.stringContaining('"payload":{}'));
    expect(raw.write).not.toHaveBeenCalledWith(expect.stringContaining("Codex A"));
    raw.emit("close");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("projects nested reasoning envelopes safely across Thread REST and SSE replay", async () => {
    const rawReasoningCanary = "RAW_REASONING_CANARY_HTTP_f8c2";
    const event = {
      taskId: "thread-1",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "tool-1",
      sequence: 1,
      timestamp: "2026-07-21T12:00:00.000Z",
      type: "TOOL_COMPLETED",
      payload: {
        itemId: "tool-1",
        tool: "business_read",
        result: {
          reasoning: {
            summary: "Readable execution summary.",
            content: [{ type: "reasoning_text", text: rawReasoningCanary }],
            reasoningTextDelta: rawReasoningCanary,
            encrypted_content: rawReasoningCanary,
          },
        },
        durationMs: 17,
      },
    } as const;
    const { auth, platform } = services();
    platform.getThread.mockResolvedValueOnce({
      id: "thread-1",
      projectId: "project-1",
      title: "Safe Thread",
      status: "COMPLETED",
      updatedAt: "2026-07-21T12:00:00.000Z",
      archivedAt: null,
      currentTurn: null,
      turns: [],
      queue: null,
      items: [
        {
          id: "tool-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: event.type,
          timestamp: event.timestamp,
          payload: event.payload,
        },
      ],
    } as never);
    platform.listThreadEvents.mockResolvedValueOnce([event] as never);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const threadResponse = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1",
      cookies: { codexplatform_session: "valid-session" },
    });
    const eventResponse = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/events",
      cookies: { codexplatform_session: "valid-session" },
      headers: { accept: "application/json" },
    });

    const raw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn((_chunk: string) => true),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const unsubscribe = vi.fn();
    await streamTaskEvents({ hijack: vi.fn(), raw } as never, {
      afterSequence: 0,
      loadReplay: async () => [event] as never,
      subscribe: () => unsubscribe,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      isSessionValid: () => true,
      hideAccountAlias: true,
    });
    const sseReplay = raw.write.mock.calls.map(([chunk]) => String(chunk)).join("");
    raw.emit("close");

    const serialized = [threadResponse.body, eventResponse.body, sseReplay].join("\n");
    expect(threadResponse.statusCode).toBe(200);
    expect(eventResponse.statusCode).toBe(200);
    expect(serialized).toContain("Readable execution summary.");
    expect(serialized).not.toContain(rawReasoningCanary);
    expect(serialized).not.toMatch(/reasoningTextDelta|encrypted_content/);
  });

  test("requires a session and CSRF token for writes", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);

    const anonymous = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Platform" },
    });
    expect(anonymous.statusCode).toBe(401);

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { codexplatform_session: "valid-session" },
      payload: { name: "Platform" },
    });
    expect(noCsrf.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { name: "Platform" },
    });
    expect(created.statusCode).toBe(201);
    expect(platform.createProject).toHaveBeenCalledWith("user-1", { name: "Platform" });
  });

  test("returns the current user's public model catalog without account metadata", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);

    const anonymous = await app.inject({ method: "GET", url: "/api/models" });
    expect(anonymous.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/models?threadId=thread-1",
      cookies: { codexplatform_session: "valid-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(platform.listModels).toHaveBeenCalledWith("user-1", "thread-1");
    expect(response.json()).toMatchObject({
      scope: "SINGLE_ACCOUNT",
      accountCount: 1,
      models: [expect.objectContaining({ model: "fake-codex-standard" })],
    });
    expect(response.body).not.toMatch(/accountId|accountAlias|codexHome|Codex A/i);
  });

  test("fails model catalog reads with 503 instead of inventing a fallback model", async () => {
    const { auth, platform } = services();
    platform.listModels.mockRejectedValueOnce(
      new ModelCatalogUnavailableError(
        "Runtime said /private/codex-home/account-1 and Codex A are unavailable",
      ),
    );
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/models",
      cookies: { codexplatform_session: "valid-session" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "MODEL_CATALOG_UNAVAILABLE",
      message: "Runtime model catalog is unavailable",
    });
    expect(response.body).not.toMatch(/private|account-1|Codex A/i);
  });

  test("replays task events after Last-Event-ID without exposing another user's task", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/events",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "last-event-id": "4", accept: "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(platform.listTaskEvents).toHaveBeenCalledWith("task-1", "user-1", 4);
    expect(response.json()).toEqual([
      expect.objectContaining({ taskId: "task-1", sequence: 5, type: "TURN_COMPLETED" }),
    ]);
  });

  test("redacts the internal recovery source Turn from browser event replay", async () => {
    const { auth, platform } = services();
    platform.listTaskEvents.mockResolvedValueOnce([
      {
        taskId: "task-1",
        threadId: "thread-visible",
        turnId: "turn-visible",
        sequence: 7,
        timestamp: "2026-07-21T12:00:01.000Z",
        type: "RECOVERY_REQUIRED",
        payload: {
          reason: "Explicit recovery is required.",
          sourceRuntimeTurnId: "runtime-turn-internal",
        },
      },
    ] as never);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/events",
      cookies: { codexplatform_session: "valid-session" },
      headers: { accept: "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        type: "RECOVERY_REQUIRED",
        payload: { reason: "Explicit recovery is required." },
      }),
    ]);
    expect(response.body).not.toContain("sourceRuntimeTurnId");
    expect(response.body).not.toContain("runtime-turn-internal");
  });

  test("projects internal scheduling and approval records before returning browser DTOs", async () => {
    const { auth, platform } = services();
    platform.startTurn.mockResolvedValueOnce({
      status: "QUEUED",
      ticket: 91,
      position: 2,
      etaMs: 300_000,
      etaEstimated: true,
      userId: "user-1",
      taskId: "task-1",
      turnId: "scheduler-turn-secret",
      leaseId: "lease-secret",
    } as never);
    platform.listTaskEvents.mockResolvedValueOnce([
      {
        taskId: "task-1",
        threadId: "thread-visible",
        turnId: "turn-visible",
        sequence: 6,
        timestamp: "2026-07-21T12:00:01.000Z",
        type: "LEASE_ACQUIRED",
        payload: { accountAlias: "Codex A", leaseId: "lease-secret" },
      },
    ] as never);
    platform.listApprovals.mockResolvedValueOnce([
      {
        id: "approval-platform-1",
        requestId: "raw-rpc-secret",
        taskId: "task-1",
        turnId: "turn-visible",
        itemId: "item-visible",
        approvalType: "COMMAND",
        status: "PENDING",
        payload: { command: "echo secret", bearer: "credential-secret" },
        decision: null,
        requestedAt: "2026-07-21T12:00:01.000Z",
        decidedAt: null,
      },
    ] as never);
    platform.decideApproval.mockResolvedValueOnce({
      id: "approval-platform-1",
      requestId: "raw-rpc-secret",
      payload: { bearer: "credential-secret" },
      status: "DELIVERED",
      decision: "accept",
    } as never);
    platform.listAudit.mockResolvedValueOnce([
      {
        id: "audit-1",
        actorUserId: "user-1",
        actorName: "林可",
        accountAlias: "Codex A",
        leaseId: "audit-lease-secret",
        taskId: "task-1",
        threadId: "audit-thread-secret",
        turnId: "audit-turn-secret",
        toolCallId: "audit-tool-secret",
        approvalId: "audit-approval-secret",
        action: "LEASE_ACQUIRED",
        outcome: "SUCCESS",
        summary: "Lease acquired",
        createdAt: "2026-07-21T12:00:02.000Z",
      },
    ] as never);
    const app = buildApp({ auth, platform });
    apps.push(app);
    const write = (url: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url,
        cookies: { codexplatform_session: "valid-session" },
        headers: { "x-csrf-token": "valid-csrf" },
        payload,
      });

    const started = await write("/api/tasks/task-1/turns", { prompt: "Build it" });
    const events = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/events",
      cookies: { codexplatform_session: "valid-session" },
      headers: { accept: "application/json" },
    });
    const approvals = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/approvals",
      cookies: { codexplatform_session: "valid-session" },
    });
    const decided = await write("/api/approvals/approval-platform-1/decision", {
      decision: "accept",
    });
    const audit = await app.inject({
      method: "GET",
      url: "/api/admin/audit",
      cookies: { codexplatform_session: "valid-session" },
    });

    expect(started.json()).toEqual({
      status: "QUEUED",
      position: 2,
      etaMs: 300_000,
      etaEstimated: true,
    });
    expect(events.json()).toEqual([
      expect.objectContaining({
        threadId: "thread-visible",
        turnId: "turn-visible",
        payload: {},
      }),
    ]);
    expect(approvals.json()).toEqual([
      {
        id: "approval-platform-1",
        taskId: "task-1",
        turnId: "turn-visible",
        itemId: "item-visible",
        approvalType: "COMMAND",
        status: "PENDING",
        decision: null,
        requestedAt: "2026-07-21T12:00:01.000Z",
        decidedAt: null,
      },
    ]);
    expect(decided.json()).toEqual({
      id: "approval-platform-1",
      status: "DELIVERED",
      decision: "accept",
    });
    expect(audit.json()).toEqual([
      {
        id: "audit-1",
        actorUserId: "user-1",
        actorName: "林可",
        accountAlias: "Codex A",
        taskId: "task-1",
        action: "LEASE_ACQUIRED",
        outcome: "SUCCESS",
        summary: "Lease acquired",
        createdAt: "2026-07-21T12:00:02.000Z",
      },
    ]);
    for (const response of [started, events, approvals, decided, audit]) {
      expect(response.body).not.toContain("raw-rpc-secret");
      expect(response.body).not.toContain("lease-secret");
      expect(response.body).not.toContain("credential-secret");
      expect(response.body).not.toContain("scheduler-turn-secret");
      expect(response.body).not.toContain("audit-thread-secret");
      expect(response.body).not.toContain("audit-turn-secret");
      expect(response.body).not.toContain("audit-tool-secret");
      expect(response.body).not.toContain("audit-approval-secret");
    }
  });

  test("rejects session-wide approval grants at the browser boundary", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/approvals/approval-1/decision",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { decision: "acceptForSession" },
    });

    expect(response.statusCode).toBe(400);
    expect(platform.decideApproval).not.toHaveBeenCalled();
  });

  test("restricts account administration and audit to administrators", async () => {
    const { auth, platform } = services("MEMBER");
    const app = buildApp({ auth, platform });
    apps.push(app);

    const denied = await app.inject({
      method: "GET",
      url: "/api/admin/accounts",
      cookies: { codexplatform_session: "valid-session" },
    });
    expect(denied.statusCode).toBe(403);
    expect(platform.listAccounts).not.toHaveBeenCalled();
  });

  test("routes an administrator quota refresh through the account service", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/accounts/account-1/refresh-quota",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
    });

    expect(response.statusCode).toBe(200);
    expect(platform.refreshAccountQuotaNow).toHaveBeenCalledWith("account-1", "user-1");
  });

  test("routes turns, steer, interrupt and approval decisions through the actor-aware service", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);
    const request = (url: string, payload: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url,
        cookies: { codexplatform_session: "valid-session" },
        headers: { "x-csrf-token": "valid-csrf" },
        payload,
      });

    expect((await request("/api/tasks/task-1/turns", { prompt: "Build it" })).statusCode).toBe(202);
    expect((await request("/api/tasks/task-1/steer", { prompt: "Focus on auth" })).statusCode).toBe(
      202,
    );
    expect((await request("/api/tasks/task-1/interrupt", {})).statusCode).toBe(202);
    expect(
      (await request("/api/approvals/approval-1/decision", { decision: "accept" })).statusCode,
    ).toBe(200);
    expect(platform.startTurn).toHaveBeenCalledWith("task-1", "user-1", "Build it");
    expect(platform.decideApproval).toHaveBeenCalledWith("approval-1", "user-1", "accept");
  });

  test("returns stable HTTP errors without leaking runtime credentials", async () => {
    const { auth, platform } = services();
    platform.startTurn.mockRejectedValueOnce(
      new Error("spawn failed with Bearer secret_token_value_abcdefghijklmnopqrstuvwxyz"),
    );
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/turns",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { prompt: "Build it" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    expect(response.body).not.toContain("secret_token_value");
    expect(response.body).not.toContain("Bearer");
  });

  test("returns 409 when the task already has an active Turn", async () => {
    const { auth, platform } = services();
    platform.startTurn.mockRejectedValueOnce(new Error("Task already has an active Turn"));
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/turns",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { prompt: "Build it again" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Task already has an active Turn" });
  });

  test.each([
    [
      new ActiveTurnResumeConflictError("thread-internal", "turn-internal"),
      "ACTIVE_TURN_RESUME_CONFLICT",
      "Thread already has an active Turn; the new prompt was not accepted",
    ],
    [
      new InvalidThreadResumeResponseError("thread-internal"),
      "INVALID_THREAD_RESUME_RESPONSE",
      "Thread resume response is unsafe; the new prompt was not accepted",
    ],
  ])("returns a safe structured 409 for %s", async (runtimeError, code, message) => {
    const { auth, platform } = services();
    platform.startTurn.mockRejectedValueOnce(runtimeError);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/turns",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { prompt: "Resume safely" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: code,
      code,
      message,
      promptAccepted: false,
      rejoined: false,
    });
    expect(response.body).not.toContain("thread-internal");
    expect(response.body).not.toContain("turn-internal");
  });

  test("serves the 1.1 bootstrap and actor-aware Thread routes while preserving task routes", async () => {
    const { auth, platform } = services();
    const baseThread = await platform.getThread();
    const projectedThread: Thread = {
      ...baseThread,
      currentTurn: {
        id: "platform-turn-1",
        threadId: "thread-1",
        prompt: "Continue",
        status: "RUNNING",
        startedAt: "2026-07-21T12:00:00.000Z",
        completedAt: null,
        durationMs: null,
        model: null,
        effort: "MEDIUM",
        permissionMode: "DEFAULT",
        configSnapshot: {
          model: null,
          reasoningEffort: "MEDIUM",
          permissionMode: "DEFAULT",
          approvalMode: "ASK",
          personality: "PRAGMATIC",
          instructions: "",
          sourceVersion: "test",
        },
      },
      turns: [],
    };
    platform.getThread.mockResolvedValue(projectedThread as never);
    platform.startThreadTurn.mockResolvedValueOnce({
      status: "RUNNING",
      accountAlias: "Codex A",
      threadId: "runtime-thread-secret",
      turnId: "runtime-turn-secret",
    } as never);
    platform.startTurn.mockResolvedValueOnce({
      status: "RUNNING",
      accountAlias: "Codex A",
      threadId: "legacy-runtime-thread-secret",
      turnId: "legacy-turn-secret",
    } as never);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const threads = await app.inject({
      method: "GET",
      url: "/api/threads?projectId=project-1",
      cookies: { codexplatform_session: "valid-session" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/threads",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { projectId: "project-1", title: "New thread" },
    });
    const detail = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1",
      cookies: { codexplatform_session: "valid-session" },
    });
    const started = await app.inject({
      method: "POST",
      url: "/api/threads/thread-1/turns",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { prompt: "Continue" },
    });
    const legacy = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1",
      cookies: { codexplatform_session: "valid-session" },
    });
    const legacyStarted = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/turns",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { prompt: "Continue through legacy route" },
    });

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({ enabledModes: ["CODEX"] });
    expect(threads.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    expect(detail.statusCode).toBe(200);
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ status: "RUNNING", turnId: "platform-turn-1" });
    expect(started.body).not.toMatch(
      /Codex A|accountAlias|runtime-thread-secret|runtime-turn-secret/,
    );
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toMatchObject({ accountAlias: null });
    expect(legacy.body).not.toContain("Codex A");
    expect(legacyStarted.json()).toEqual({ status: "RUNNING" });
    expect(legacyStarted.body).not.toMatch(
      /Codex A|accountAlias|legacy-runtime-thread-secret|legacy-turn-secret/,
    );
    expect(platform.listThreads).toHaveBeenCalledWith("user-1", "project-1");
    expect(platform.createThread).toHaveBeenCalledWith("user-1", {
      projectId: "project-1",
      title: "New thread",
    });
    expect(platform.startThreadTurn).toHaveBeenCalledWith("thread-1", "user-1", "Continue");
    expect(platform.getTask).toHaveBeenCalledWith("task-1", "user-1");
  });

  test("serves actor-scoped Composer capabilities for a Thread", async () => {
    const { auth, platform } = services();
    platform.listComposerCapabilities.mockResolvedValueOnce([
      {
        id: "files-and-folders",
        kind: "FILE_PICKER",
        section: "ADD",
        label: "Files and folders",
        description: "Attach files from this device",
        availability: "POLICY_BLOCKED",
        unavailableReason: "File staging is not enabled",
      },
    ]);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/composer/capabilities?threadId=thread-1",
      cookies: { codexplatform_session: "valid-session" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({ id: "files-and-folders", availability: "POLICY_BLOCKED" }),
    ]);
    expect(platform.listComposerCapabilities).toHaveBeenCalledWith("user-1", "thread-1");
  });

  test("keeps Thread, subagent and settings access fail-closed by actor and CSRF", async () => {
    const { auth, platform } = services();
    platform.getThread.mockResolvedValueOnce(null as never);
    platform.getSubagent.mockResolvedValueOnce(null as never);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const missingThread = await app.inject({
      method: "GET",
      url: "/api/threads/other-thread",
      cookies: { codexplatform_session: "valid-session" },
    });
    const missingSubagent = await app.inject({
      method: "GET",
      url: "/api/subagents/other-agent",
      cookies: { codexplatform_session: "valid-session" },
    });
    const settingsWithoutCsrf = await app.inject({
      method: "PATCH",
      url: "/api/me/settings",
      cookies: { codexplatform_session: "valid-session" },
      payload: { general: { theme: "DARK" } },
    });
    const settings = await app.inject({
      method: "PATCH",
      url: "/api/me/settings",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { general: { theme: "DARK" } },
    });

    expect(missingThread.statusCode).toBe(404);
    expect(missingSubagent.statusCode).toBe(404);
    expect(settingsWithoutCsrf.statusCode).toBe(403);
    expect(settings.statusCode).toBe(200);
    expect(platform.patchMySettings).toHaveBeenCalledWith("user-1", {
      general: { theme: "DARK" },
    });
  });

  test("exposes owner-scoped local Thread archive routes with CSRF protection", async () => {
    const { auth, platform } = services();
    platform.listArchivedThreads.mockResolvedValueOnce([
      {
        id: "thread-archived",
        projectId: "project-1",
        title: "Archived",
        status: "COMPLETED",
        updatedAt: "2026-07-21T12:00:00.000Z",
        archivedAt: "2026-07-21T12:00:00.000Z",
        currentTurn: null,
        turns: [],
        queue: null,
        items: [],
      },
    ]);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const archived = await app.inject({
      method: "GET",
      url: "/api/threads/archived",
      cookies: { codexplatform_session: "valid-session" },
    });
    const archiveWithoutCsrf = await app.inject({
      method: "POST",
      url: "/api/threads/thread-1/archive",
      cookies: { codexplatform_session: "valid-session" },
    });
    const archive = await app.inject({
      method: "POST",
      url: "/api/threads/thread-1/archive",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
    });
    const unarchive = await app.inject({
      method: "POST",
      url: "/api/threads/thread-1/unarchive",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
    });

    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toEqual([
      expect.objectContaining({ id: "thread-archived", title: "Archived" }),
    ]);
    expect(archiveWithoutCsrf.statusCode).toBe(403);
    expect(archive.statusCode).toBe(200);
    expect(archive.json()).toEqual({ ok: true });
    expect(unarchive.statusCode).toBe(200);
    expect(unarchive.json()).toEqual({ ok: true });
    expect(platform.listArchivedThreads).toHaveBeenCalledWith("user-1");
    expect(platform.archiveThread).toHaveBeenCalledWith("thread-1", "user-1");
    expect(platform.unarchiveThread).toHaveBeenCalledWith("thread-1", "user-1");
  });

  test("exposes owner-scoped Goal CRUD and protects every mutation with CSRF", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);
    const cookies = { codexplatform_session: "valid-session" };
    const write = { ...cookies, codexplatform_csrf: "valid-csrf" };
    const headers = { "x-csrf-token": "valid-csrf" };

    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/threads/thread-1/goal",
          cookies,
          payload: { objective: "持续完成" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/threads/thread-1/goal",
          cookies: write,
          headers,
          payload: { objective: "持续完成" },
        })
      ).statusCode,
    ).toBe(200);
    expect(platform.putThreadGoal).toHaveBeenCalledWith("thread-1", "user-1", {
      objective: "持续完成",
      tokenBudget: 200_000,
      timeBudgetSeconds: 3_600,
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/threads/thread-1/goal",
          cookies: write,
          headers,
          payload: { action: "PAUSE" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/threads/thread-1/goal",
          cookies: write,
          headers,
        })
      ).statusCode,
    ).toBe(204);
  });

  test("returns not found when archive routes target a Draft or expired Draft", async () => {
    const { auth, platform } = services();
    platform.archiveThread.mockRejectedValue(new Error("Thread not found"));
    platform.unarchiveThread.mockRejectedValue(new Error("Thread not found"));
    const app = buildApp({ auth, platform });
    apps.push(app);

    const responses = await Promise.all(
      ["draft-1", "expired-1"].flatMap((threadId) =>
        ["archive", "unarchive"].map((action) =>
          app.inject({
            method: "POST",
            url: `/api/threads/${threadId}/${action}`,
            cookies: { codexplatform_session: "valid-session" },
            headers: { "x-csrf-token": "valid-csrf" },
          }),
        ),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404]);
    expect(responses.map((response) => response.json())).toEqual([
      { error: "Thread not found" },
      { error: "Thread not found" },
      { error: "Thread not found" },
      { error: "Thread not found" },
    ]);
  });

  test("creates and deletes hidden Drafts through owner-scoped CSRF routes", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/threads/drafts",
      cookies: { codexplatform_session: "valid-session" },
      payload: { projectId: "project-1" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/threads/drafts",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { projectId: "project-1" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/threads/draft-1/draft",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
    });

    expect(missingCsrf.statusCode).toBe(403);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "draft-1", lifecycleState: "DRAFT" });
    expect(deleted.statusCode).toBe(204);
    expect(platform.createDraft).toHaveBeenCalledWith("user-1", { projectId: "project-1" });
    expect(platform.deleteDraft).toHaveBeenCalledWith("draft-1", "user-1");
  });

  test("does not expose a Draft through legacy task detail or event routes", async () => {
    const { auth, platform } = services();
    platform.getTask.mockResolvedValue(null);
    platform.listTaskEvents.mockResolvedValue(null);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const detail = await app.inject({
      method: "GET",
      url: "/api/tasks/draft-1",
      cookies: { codexplatform_session: "valid-session" },
    });
    const replay = await app.inject({
      method: "GET",
      url: "/api/tasks/draft-1/events",
      cookies: { codexplatform_session: "valid-session" },
      headers: { accept: "application/json" },
    });
    const stream = await app.inject({
      method: "GET",
      url: "/api/tasks/draft-1/events",
      cookies: { codexplatform_session: "valid-session" },
      headers: { accept: "text/event-stream" },
    });

    expect(detail.statusCode).toBe(404);
    expect(replay.statusCode).toBe(404);
    expect(stream.statusCode).toBe(404);
    expect(`${detail.body}${replay.body}${stream.body}`).not.toContain("DRAFT");
  });

  test("accepts an attachment-only Steer on Thread and legacy task routes", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);

    const thread = await app.inject({
      method: "POST",
      url: "/api/threads/thread-1/steer",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { prompt: "", attachmentIds: ["attachment-1"] },
    });
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/steer",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { prompt: "", attachmentIds: ["attachment-2"] },
    });

    expect(thread.statusCode).toBe(202);
    expect(task.statusCode).toBe(202);
    expect(platform.steerThread).toHaveBeenCalledWith("thread-1", "user-1", "", ["attachment-1"]);
    expect(platform.steerTask).toHaveBeenCalledWith("task-1", "user-1", "", ["attachment-2"]);
  });

  test("stops reading multipart content as soon as the aggregate limit is exceeded", async () => {
    let yielded = 0;
    async function* chunks() {
      for (const value of ["1234", "5678", "must-not-read"]) {
        yielded += 1;
        yield Buffer.from(value);
      }
    }

    await expect(readMultipartStream(chunks(), 5)).rejects.toThrow(
      "Attachments exceed the aggregate upload limit",
    );
    expect(yielded).toBe(2);
  });

  test("accepts multipart attachment uploads without exposing an absolute path", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);
    const boundary = "codexplatform-test-boundary";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="notes.txt"',
      "Content-Type: text/plain",
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const response = await app.inject({
      method: "POST",
      url: "/api/threads/draft-1/attachments",
      cookies: { codexplatform_session: "valid-session" },
      headers: {
        "x-csrf-token": "valid-csrf",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: "attachment-1",
      relativePath: ".codexplatform/attachments/attachment-1/notes.txt",
      scanStatus: "READY",
    });
    expect(response.body).not.toContain("/private/");
    expect(platform.uploadAttachment).toHaveBeenCalledWith(
      "draft-1",
      "user-1",
      expect.objectContaining({
        files: [
          {
            name: "notes.txt",
            relativePath: "notes.txt",
            mimeType: "text/plain",
            content: Buffer.from("hello"),
          },
        ],
      }),
    );
  });

  test("maps attachment validation errors to 400 and size limits to 413", async () => {
    const { auth, platform } = services();
    platform.uploadAttachment
      .mockRejectedValueOnce(new Error("Attachment root limit exceeded"))
      .mockRejectedValueOnce(new Error("Attachments exceed the 200 MiB Turn limit"));
    const app = buildApp({ auth, platform });
    apps.push(app);
    const boundary = "codexplatform-error-boundary";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="notes.txt"',
      "Content-Type: text/plain",
      "",
      "hello",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const upload = () =>
      app.inject({
        method: "POST",
        url: "/api/threads/draft-1/attachments",
        cookies: { codexplatform_session: "valid-session" },
        headers: {
          "x-csrf-token": "valid-csrf",
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

    const invalid = await upload();
    const tooLarge = await upload();

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "Attachment root limit exceeded" });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({ error: "Attachments exceed the 200 MiB Turn limit" });
  });

  test("preserves a multipart folder tree as one attachment root", async () => {
    const { auth, platform } = services();
    const app = buildApp({ auth, platform });
    apps.push(app);
    const boundary = "codexplatform-folder-boundary";
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="research/a.txt"',
      "Content-Type: text/plain",
      "",
      "a",
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="research/nested/b.txt"',
      "Content-Type: text/plain",
      "",
      "b",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const response = await app.inject({
      method: "POST",
      url: "/api/threads/draft-1/attachments",
      cookies: { codexplatform_session: "valid-session" },
      headers: {
        "x-csrf-token": "valid-csrf",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(201);
    expect(platform.uploadAttachment).toHaveBeenCalledWith(
      "draft-1",
      "user-1",
      expect.objectContaining({
        files: [
          expect.objectContaining({ relativePath: "research/a.txt", content: Buffer.from("a") }),
          expect.objectContaining({
            relativePath: "research/nested/b.txt",
            content: Buffer.from("b"),
          }),
        ],
      }),
    );
  });

  test("returns conflict when an active Thread cannot be archived", async () => {
    const { auth, platform } = services();
    platform.archiveThread.mockRejectedValueOnce(
      new Error("Thread has active work and cannot be archived"),
    );
    platform.startThreadTurn.mockRejectedValueOnce(new Error("Thread is archived"));
    const app = buildApp({ auth, platform });
    apps.push(app);

    const archive = await app.inject({
      method: "POST",
      url: "/api/threads/thread-1/archive",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/threads/thread-1/turns",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { prompt: "Bypass archived state" },
    });

    expect(archive.statusCode).toBe(409);
    expect(archive.json()).toEqual({
      error: "Thread has active work and cannot be archived",
    });
    expect(start.statusCode).toBe(409);
    expect(start.json()).toEqual({ error: "Thread is archived" });
  });

  test("returns 400 when a default Settings project is unknown or not owned", async () => {
    const { auth, platform } = services();
    platform.patchMySettings.mockRejectedValueOnce(new Error("Invalid default project"));
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/settings",
      cookies: { codexplatform_session: "valid-session" },
      headers: { "x-csrf-token": "valid-csrf" },
      payload: { general: { defaultProjectId: "other-users-project" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid default project" });
  });

  test("projects Thread events without raw reasoning or shared account aliases", async () => {
    const { auth, platform } = services();
    platform.listThreadEvents.mockResolvedValueOnce([
      {
        taskId: "thread-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reason-1",
        sequence: 1,
        timestamp: "2026-07-21T12:00:00.000Z",
        type: "REASONING_SUMMARY_DELTA",
        payload: {
          itemId: "reason-1",
          delta: "Inspect the repository.",
          reasoningTextDelta: "raw secret",
          content: "raw content",
          encrypted_content: "ciphertext",
        },
      },
      {
        taskId: "thread-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "lease:turn-1",
        sequence: 2,
        timestamp: "2026-07-21T12:00:01.000Z",
        type: "LEASE_ACQUIRED",
        payload: { accountAlias: "Codex A" },
      },
    ] as never);
    const app = buildApp({ auth, platform });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1/events",
      cookies: { codexplatform_session: "valid-session" },
      headers: { accept: "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        payload: { itemId: "reason-1", delta: "Inspect the repository." },
      }),
      expect.objectContaining({ payload: {} }),
    ]);
    expect(response.body).not.toMatch(
      /raw secret|raw content|ciphertext|reasoningTextDelta|encrypted_content|Codex A/,
    );
  });

  test("redacts configured runtime paths from Thread REST and SSE replay", async () => {
    const runtimeDataDir = "/private/var/runtime/CODEX_HOME_SENTINEL_HTTP_71c4";
    const accountHome = `${runtimeDataDir}/codex-accounts/codex-private`;
    const workspaceDir = `${runtimeDataDir}/workspaces/thread-1`;
    const commandEvent = {
      taskId: "thread-1",
      threadId: "runtime-thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      sequence: 1,
      timestamp: "2026-07-21T12:00:00.000Z",
      type: "COMMAND_COMPLETED" as const,
      payload: {
        itemId: "command-1",
        command: `CODEX_HOME=${accountHome} node ${workspaceDir}/script.js packages/app/src/index.ts`,
        aggregatedOutput: `failed in ${runtimeDataDir}`,
        exitCode: 1,
        durationMs: 5,
      },
    };
    const { auth, platform } = services();
    platform.getThread.mockResolvedValueOnce({
      id: "thread-1",
      projectId: "project-1",
      title: "Runtime path safety",
      status: "RUNNING",
      updatedAt: "2026-07-21T12:00:00.000Z",
      archivedAt: null,
      currentTurn: null,
      turns: [],
      queue: null,
      items: [
        {
          id: "command-1",
          threadId: "thread-1",
          turnId: "turn-1",
          sequence: 1,
          type: "COMMAND_COMPLETED",
          timestamp: "2026-07-21T12:00:00.000Z",
          payload: commandEvent.payload,
        },
      ],
    } as never);
    const app = buildApp({ auth, platform, runtimeDataDir });
    apps.push(app);

    const thread = await app.inject({
      method: "GET",
      url: "/api/threads/thread-1",
      cookies: { codexplatform_session: "valid-session" },
    });

    const raw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    const unsubscribe = vi.fn();
    await streamTaskEvents({ hijack: vi.fn(), raw } as never, {
      afterSequence: 0,
      loadReplay: async () => [commandEvent],
      subscribe: () => unsubscribe,
      sessionExpiresAt: new Date(Date.now() + 60_000),
      isSessionValid: () => true,
      runtimeDataDir,
    });
    raw.emit("close");

    const serialized = `${thread.body}\n${raw.write.mock.calls.flat().join("\n")}`;
    expect(thread.statusCode).toBe(200);
    expect(serialized).not.toContain(runtimeDataDir);
    expect(serialized).not.toContain("CODEX_HOME_SENTINEL_HTTP_71c4");
    expect(serialized).toContain("[RUNTIME_DATA]");
    expect(serialized).toContain("packages/app/src/index.ts");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("serves personal projections and keeps every new admin endpoint admin-only", async () => {
    const adminServices = services("ADMIN");
    const admin = buildApp(adminServices);
    apps.push(admin);
    const memberServices = services("MEMBER");
    const member = buildApp(memberServices);
    apps.push(member);

    for (const url of [
      "/api/me/settings",
      "/api/me/usage",
      "/api/me/connections",
      "/api/me/plugins",
    ]) {
      expect(
        (
          await admin.inject({
            method: "GET",
            url,
            cookies: { codexplatform_session: "valid-session" },
          })
        ).statusCode,
      ).toBe(200);
    }
    for (const url of [
      "/api/admin/policies",
      "/api/admin/connectors",
      "/api/admin/usage",
      "/api/admin/runtime-health",
    ]) {
      expect(
        (
          await member.inject({
            method: "GET",
            url,
            cookies: { codexplatform_session: "valid-session" },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(memberServices.platform.getAdminPolicies).not.toHaveBeenCalled();
  });

  test("serves a member-owned Thread through the administrator-only read projection", async () => {
    const adminServices = services("ADMIN");
    const admin = buildApp(adminServices);
    apps.push(admin);
    const memberServices = services("MEMBER");
    const member = buildApp(memberServices);
    apps.push(member);

    const adminResponse = await admin.inject({
      method: "GET",
      url: "/api/admin/threads/member-thread",
      cookies: { codexplatform_session: "valid-session" },
    });
    const memberResponse = await member.inject({
      method: "GET",
      url: "/api/admin/threads/member-thread",
      cookies: { codexplatform_session: "valid-session" },
    });

    expect(adminResponse.statusCode).toBe(200);
    expect(adminServices.platform.getAdminThread).toHaveBeenCalledWith("member-thread", "user-1");
    expect(memberResponse.statusCode).toBe(403);
    expect(memberServices.platform.getAdminThread).not.toHaveBeenCalled();
  });
});

function services(role: "ADMIN" | "MEMBER" = "ADMIN") {
  let loginConsumed = false;
  const user = {
    id: "user-1",
    tenantKey: "tenant-1",
    openId: "ou_1",
    unionId: null,
    name: "User",
    avatarUrl: null,
    role,
  };
  const auth: AuthApi = {
    startLogin: () => ({
      state: "state-1",
      browserBinding: "binding-1",
      authorizationUrl: "https://auth.example.test/start",
    }),
    completeLogin: vi.fn(async (input) => {
      if (input.browserBinding !== "binding-1") {
        throw new Error("OAuth state is invalid, expired, or already used");
      }
      if (loginConsumed) throw new Error("OAuth state is invalid, expired, or already used");
      loginConsumed = true;
      return {
        user,
        sessionToken: "valid-session",
        csrfToken: "valid-csrf",
      };
    }),
    resolveSession: (token) =>
      token === "valid-session"
        ? {
            user,
            csrfHash: "csrf-hash",
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            persistent: false,
            feishuConnectionStatus: "CONNECTED" as const,
          }
        : null,
    verifyCsrf: (_hash, token) => token === "valid-csrf",
    persistSession: vi.fn((token) =>
      token === "valid-session"
        ? {
            user,
            csrfHash: "csrf-hash",
            expiresAt: new Date("2099-01-01T00:00:00.000Z"),
            persistent: true,
            feishuConnectionStatus: "CONNECTED" as const,
          }
        : null,
    ),
    revokeSession: vi.fn(),
    refreshExpiringCredentials: vi.fn(async () => undefined),
  };
  const event = {
    taskId: "task-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sequence: 5,
    timestamp: "2026-07-21T12:00:00.000Z",
    type: "TURN_COMPLETED" as const,
    payload: { status: "completed" as const },
  };
  const platform = {
    getBootstrap: vi.fn(
      async (): Promise<Bootstrap> => ({
        platformVersion: "0.1.0",
        defaultMode: "CODEX",
        enabledModes: ["CODEX"],
        capabilities: {
          threads: true as const,
          settings: true as const,
          subagents: true as const,
          reasoningSummaries: true as const,
        },
      }),
    ),
    listModels: vi.fn(
      async (): Promise<ModelCatalog> => ({
        models: [STANDARD_MODEL],
        scope: "SINGLE_ACCOUNT",
        accountCount: 1,
        observedAt: "2026-07-21T12:00:00.000Z",
        stale: false,
      }),
    ),
    listComposerCapabilities: vi.fn(async (): Promise<ComposerCapability[]> => []),
    createProject: vi.fn(async () => ({ id: "project-1" })),
    listProjects: vi.fn(async () => []),
    createTask: vi.fn(async () => ({ id: "task-1" })),
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(
      async (): Promise<TaskDetail | null> => ({
        id: "task-1",
        projectId: "project-1",
        title: "Build it",
        status: "RUNNING" as const,
        updatedAt: "2026-07-21T12:00:00.000Z",
        prompt: "Build it",
        accountAlias: "Codex A",
        queue: null,
      }),
    ),
    createThread: vi.fn(async () => ({
      id: "thread-new",
      projectId: "project-1",
      title: "New thread",
      status: "READY" as const,
      updatedAt: "2026-07-21T12:00:00.000Z",
      archivedAt: null,
      currentTurn: null,
      turns: [],
      queue: null,
      items: [],
    })),
    createDraft: vi.fn(async () => ({
      id: "draft-1",
      projectId: "project-1",
      lifecycleState: "DRAFT" as const,
      expiresAt: "2026-07-28T13:00:00.000Z",
    })),
    deleteDraft: vi.fn(async () => undefined),
    uploadAttachment: vi.fn(async () => ({
      id: "attachment-1",
      threadId: "draft-1",
      kind: "FILE" as const,
      name: "notes.txt",
      relativePath: ".codexplatform/attachments/attachment-1/notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      fileCount: 1,
      scanStatus: "READY" as const,
      createdAt: "2026-07-28T12:00:00.000Z",
    })),
    deleteAttachment: vi.fn(async () => undefined),
    getThreadGoal: vi.fn(async () => ({
      threadId: "thread-1",
      objective: "持续完成",
      status: "ACTIVE" as const,
      tokenBudget: 200_000,
      tokensUsed: 0,
      timeBudgetSeconds: 3_600,
      timeUsedSeconds: 0,
      runtimeSyncState: "SYNCED" as const,
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
    })),
    putThreadGoal: vi.fn(async (_threadId, _userId, input) => ({
      threadId: "thread-1",
      ...input,
      status: "ACTIVE" as const,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      runtimeSyncState: "PENDING" as const,
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
    })),
    patchThreadGoal: vi.fn(async () => ({
      threadId: "thread-1",
      objective: "持续完成",
      status: "PAUSED" as const,
      tokenBudget: 200_000,
      tokensUsed: 0,
      timeBudgetSeconds: 3_600,
      timeUsedSeconds: 0,
      runtimeSyncState: "PENDING" as const,
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:01.000Z",
    })),
    deleteThreadGoal: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => []),
    listArchivedThreads: vi.fn(async (): Promise<Thread[]> => []),
    archiveThread: vi.fn(async () => ({ ok: true as const })),
    unarchiveThread: vi.fn(async () => ({ ok: true as const })),
    getThread: vi.fn(async () => ({
      id: "thread-1",
      projectId: "project-1",
      title: "Build it",
      status: "RUNNING" as const,
      updatedAt: "2026-07-21T12:00:00.000Z",
      archivedAt: null,
      currentTurn: null,
      turns: [],
      queue: null,
      items: [],
    })),
    getAdminThread: vi.fn(async () => ({
      id: "member-thread",
      projectId: "project-1",
      title: "Member Thread",
      status: "COMPLETED" as const,
      updatedAt: "2026-07-21T12:00:00.000Z",
      archivedAt: null,
      currentTurn: null,
      turns: [],
      queue: null,
      items: [],
    })),
    startThreadTurn: vi.fn(async () => ({ status: "RUNNING" })),
    steerThread: vi.fn(async () => ({ status: "RUNNING" })),
    interruptThread: vi.fn(async () => ({ status: "INTERRUPTING" })),
    listThreadEvents: vi.fn(async () => [event]),
    subscribeThreadEvents: vi.fn(() => () => undefined),
    listSubagents: vi.fn(async () => []),
    getSubagent: vi.fn(async () => ({
      threadId: "agent-thread-1",
      parentThreadId: "thread-1",
      parentTurnId: "turn-1",
      sessionId: null,
      name: "Research",
      role: "subagent",
      model: null,
      effort: null,
      status: "DONE" as const,
      startedAt: "2026-07-21T12:00:00.000Z",
      completedAt: "2026-07-21T12:00:01.000Z",
      elapsedMs: 1_000,
      resultSummary: "Done",
      tokenUsage: null,
      items: [],
    })),
    getMySettings: vi.fn(
      async (): Promise<UserSettingsView> => ({
        general: {
          language: "zh-CN",
          theme: "SYSTEM" as const,
          defaultProjectId: null,
          notificationsEnabled: true,
        },
        execution: {
          model: null,
          reasoningEffort: "MEDIUM" as const,
          permissionMode: "DEFAULT" as const,
          approvalPreference: "ASK" as const,
        },
        personalization: { personality: "PRAGMATIC" as const, instructions: "" },
        updatedAt: "2026-07-21T12:00:00.000Z",
        policy: {
          allowedModels: null,
          allowedReasoningEfforts: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
          allowedPermissionModes: ["DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"],
          allowedApprovalPreferences: ["ASK"],
          lockedFields: [],
        },
      }),
    ),
    patchMySettings: vi.fn(
      async (): Promise<UserSettingsView> => ({
        general: {
          language: "zh-CN",
          theme: "DARK" as const,
          defaultProjectId: null,
          notificationsEnabled: true,
        },
        execution: {
          model: null,
          reasoningEffort: "MEDIUM" as const,
          permissionMode: "DEFAULT" as const,
          approvalPreference: "ASK" as const,
        },
        personalization: { personality: "PRAGMATIC" as const, instructions: "" },
        updatedAt: "2026-07-21T12:00:00.000Z",
        policy: {
          allowedModels: null,
          allowedReasoningEfforts: ["LOW", "MEDIUM", "HIGH", "XHIGH"],
          allowedPermissionModes: ["DEFAULT", "READ_ONLY", "WORKSPACE_WRITE"],
          allowedApprovalPreferences: ["ASK"],
          lockedFields: [],
        },
      }),
    ),
    getMyUsage: vi.fn(async () => ({
      threads: 0,
      turns: 0,
      toolCalls: 0,
      subagents: 0,
      tokenUsage: null,
      tokenUsageStatus: "UNKNOWN" as const,
    })),
    getMyConnections: vi.fn(async () => []),
    getMyPlugins: vi.fn(async () => []),
    startTurn: vi.fn(async () => ({ status: "RUNNING" })),
    steerTask: vi.fn(async () => ({ status: "RUNNING" })),
    interruptTask: vi.fn(async () => ({ status: "INTERRUPTING" })),
    listTaskEvents: vi.fn(async (): Promise<TaskEvent[] | null> => [event]),
    subscribeTaskEvents: vi.fn(() => () => undefined),
    listApprovals: vi.fn(async () => []),
    decideApproval: vi.fn(async () => ({ id: "approval-1", status: "DECIDED" })),
    listAccounts: vi.fn(async () => []),
    addAccount: vi.fn(async () => ({ id: "account-1" })),
    loginAccount: vi.fn(async () => ({ authUrl: "https://auth.example.test/codex" })),
    refreshAccountQuotaNow: vi.fn(async () => ({ id: "account-1", weeklyRemaining: 55 })),
    setAccountState: vi.fn(async () => ({ id: "account-1" })),
    listAudit: vi.fn(async () => []),
    getAdminPolicies: vi.fn(async () => ({})),
    getAdminConnectors: vi.fn(async () => []),
    getAdminUsage: vi.fn(async () => ({})),
    getAdminRuntimeHealth: vi.fn(async () => ({})),
  } satisfies PlatformApi;
  return { auth, platform };
}
