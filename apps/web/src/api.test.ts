// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { httpApi } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.set(document, "cookie", "codexplatform_csrf=; Max-Age=0; Path=/");
});

describe("HTTP API adapter", () => {
  test("upgrades an existing non-persistent session once without another OAuth login", async () => {
    Reflect.set(document, "cookie", "codexplatform_csrf=csrf-1; Path=/");
    const session = {
      user: { id: "user-1", name: "林可", role: "ADMIN", avatarUrl: null },
      expiresAt: "2026-07-21T22:00:00.000Z",
      persistent: false,
      feishuConnectionStatus: "CONNECTED",
    };
    const persisted = {
      ...session,
      expiresAt: "2026-08-20T10:00:00.000Z",
      persistent: true,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(session))
      .mockResolvedValueOnce(jsonResponse(persisted));
    vi.stubGlobal("fetch", fetcher);

    await expect(httpApi.getSession()).resolves.toMatchObject({
      authenticated: true,
      persistent: true,
      expiresAt: "2026-08-20T10:00:00.000Z",
    });
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/auth/session",
      "/api/auth/session/persist",
    ]);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });

  test("revokes the server session when the user logs out", async () => {
    Reflect.set(document, "cookie", "codexplatform_csrf=csrf-1; Path=/");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await httpApi.logout?.();

    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  test("reads account-independent model catalogs for new and bound Threads", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ models: [], stale: false }))
      .mockResolvedValueOnce(jsonResponse({ models: [], stale: false }));
    vi.stubGlobal("fetch", fetcher);

    await httpApi.listModels?.();
    await httpApi.listModels?.("thread / 1");

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/models",
      "/api/models?threadId=thread%20%2F%201",
    ]);
  });

  test("stages files and folders with multipart requests without forcing JSON content type", async () => {
    const attachment = {
      id: "attachment-1",
      threadId: "draft-1",
      kind: "FOLDER",
      name: "reports",
      relativePath: ".codexplatform/attachments/attachment-1/reports",
      mimeType: "application/x-directory",
      sizeBytes: 8,
      fileCount: 2,
      scanStatus: "READY",
      createdAt: "2026-07-28T10:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "draft-1" }))
      .mockResolvedValueOnce(jsonResponse(attachment))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const first = new File(["one"], "one.txt", { type: "text/plain" });
    Object.defineProperty(first, "webkitRelativePath", { value: "reports/one.txt" });
    const second = new File(["two"], "two.txt", { type: "text/plain" });
    Object.defineProperty(second, "webkitRelativePath", { value: "reports/two.txt" });

    await expect(httpApi.createDraft?.({ projectId: "project-1" })).resolves.toEqual({
      id: "draft-1",
    });
    await expect(httpApi.uploadAttachments?.("draft-1", [first, second])).resolves.toEqual(
      attachment,
    );
    await httpApi.deleteAttachment?.("draft-1", "attachment-1");

    const uploadInit = fetcher.mock.calls[1]?.[1];
    expect(uploadInit?.body).toBeInstanceOf(FormData);
    expect(new Headers(uploadInit?.headers).has("Content-Type")).toBe(false);
    const uploadBody = uploadInit?.body as FormData;
    expect(
      uploadBody.getAll("files").map((entry) => (entry instanceof File ? entry.name : entry)),
    ).toEqual(["reports/one.txt", "reports/two.txt"]);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/threads/drafts",
      "/api/threads/draft-1/attachments",
      "/api/threads/draft-1/attachments/attachment-1",
    ]);
  });

  test("reloads unclaimed attachments for an existing Thread", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetcher);

    await expect(httpApi.listThreadAttachments?.("thread / 1")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/threads/thread%20%2F%201/attachments",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("uses Goal and sticky Composer endpoints and carries attachments into Turn and Steer", async () => {
    const goal = {
      threadId: "thread-1",
      objective: "持续完成平台验收",
      status: "ACTIVE",
      tokenBudget: 200_000,
      tokensUsed: 0,
      timeBudgetSeconds: 3_600,
      timeUsedSeconds: 0,
      runtimeSyncState: "SYNCED",
      createdAt: "2026-07-28T10:00:00.000Z",
      updatedAt: "2026-07-28T10:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(goal))
      .mockResolvedValueOnce(jsonResponse(goal))
      .mockResolvedValueOnce(jsonResponse({ ...goal, status: "PAUSED" }))
      .mockResolvedValueOnce(jsonResponse({ cleared: true, runtimeSyncState: "SYNCED" }))
      .mockResolvedValueOnce(jsonResponse({ planMode: true, revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ status: "RUNNING" }))
      .mockResolvedValueOnce(jsonResponse({ status: "RUNNING" }));
    vi.stubGlobal("fetch", fetcher);

    await httpApi.getThreadGoal?.("thread-1");
    await httpApi.putThreadGoal?.("thread-1", {
      objective: "持续完成平台验收",
      tokenBudget: 200_000,
      timeBudgetSeconds: 3_600,
    });
    await httpApi.patchThreadGoal?.("thread-1", { action: "PAUSE" });
    await httpApi.deleteThreadGoal?.("thread-1");
    await httpApi.patchThreadComposer?.("thread-1", { planMode: true, revision: 1 });
    await httpApi.startThreadTurn?.("thread-1", "", { model: "gpt", reasoningEffort: "high" }, [
      "attachment-1",
    ]);
    await httpApi.threadAction?.("thread-1", "steer", "", ["attachment-2"]);

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/threads/thread-1/goal",
      "/api/threads/thread-1/goal",
      "/api/threads/thread-1/goal",
      "/api/threads/thread-1/goal",
      "/api/threads/thread-1/composer",
      "/api/threads/thread-1/turns",
      "/api/threads/thread-1/steer",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[5]?.[1]?.body))).toMatchObject({
      prompt: "",
      attachmentIds: ["attachment-1"],
    });
    expect(JSON.parse(String(fetcher.mock.calls[6]?.[1]?.body))).toEqual({
      prompt: "",
      attachmentIds: ["attachment-2"],
    });
  });

  test("uses the actor-aware 1.1 Thread, settings and Subagent endpoints", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ enabledModes: ["CODEX"] }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ id: "thread-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "RUNNING", turnId: "turn-1" }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ execution: { reasoningEffort: "MEDIUM" } }))
      .mockResolvedValueOnce(jsonResponse({ execution: { reasoningEffort: "HIGH" } }));
    vi.stubGlobal("fetch", fetcher);

    await httpApi.getBootstrap?.();
    await httpApi.listThreads?.();
    await httpApi.createThread?.({ projectId: "project-1", title: "Thread" });
    await httpApi.startThreadTurn?.("thread-1", "Continue");
    await httpApi.listSubagents?.("thread-1");
    await httpApi.getMySettings?.();
    await httpApi.patchMySettings?.({ execution: { reasoningEffort: "HIGH" } });

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/bootstrap",
      "/api/threads",
      "/api/threads",
      "/api/threads/thread-1/turns",
      "/api/threads/thread-1/subagents",
      "/api/me/settings",
      "/api/me/settings",
    ]);
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(fetcher.mock.calls[6]?.[1]).toMatchObject({ method: "PATCH" });
  });

  test("uses the read-only administrator governance endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetcher);
    const adminApi = httpApi as typeof httpApi & {
      getAdminThread(threadId: string): Promise<unknown>;
      getAdminPolicies(): Promise<unknown>;
      listAdminConnectors(): Promise<unknown>;
      getAdminUsage(): Promise<unknown>;
      getAdminRuntimeHealth(): Promise<unknown>;
    };

    await adminApi.getAdminThread("member-thread");
    await adminApi.getAdminPolicies();
    await adminApi.listAdminConnectors();
    await adminApi.getAdminUsage();
    await adminApi.getAdminRuntimeHealth();

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/threads/member-thread",
      "/api/admin/policies",
      "/api/admin/connectors",
      "/api/admin/usage",
      "/api/admin/runtime-health",
    ]);
  });

  test("uses the platform-owned Thread archive endpoints", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    const archiveApi = httpApi as typeof httpApi & {
      listArchivedThreads(): Promise<unknown>;
      archiveThread(threadId: string): Promise<unknown>;
      unarchiveThread(threadId: string): Promise<unknown>;
    };

    expect(archiveApi.listArchivedThreads).toBeTypeOf("function");
    expect(archiveApi.archiveThread).toBeTypeOf("function");
    expect(archiveApi.unarchiveThread).toBeTypeOf("function");
    await archiveApi.listArchivedThreads();
    await archiveApi.archiveThread("thread / 1");
    await archiveApi.unarchiveThread("thread / 1");

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/threads/archived",
      "/api/threads/thread%20%2F%201/archive",
      "/api/threads/thread%20%2F%201/unarchive",
    ]);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
  });

  test("normalizes the real API session and account shapes for the UI", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ user: { id: "user-1", name: "林可", role: "ADMIN", avatarUrl: null } }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "account-1",
            alias: "Codex 01",
            status: "AVAILABLE",
            activeUsers: 2,
            maxActiveUsers: 4,
            weeklyRemaining: 73,
            healthScore: 98,
            authStatus: "AUTHENTICATED",
            quotaUpdatedAt: "2026-07-21T12:00:00.000Z",
            quotaResetsAt: "2026-07-28T12:00:00.000Z",
          },
        ]),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(httpApi.getSession()).resolves.toMatchObject({ authenticated: true });
    await expect(httpApi.listAccounts()).resolves.toEqual([
      expect.objectContaining({
        maxUsers: 4,
        weeklyRemainingPercent: 73,
        authStatus: "AUTHENTICATED",
        quotaUpdatedAt: "2026-07-21T12:00:00.000Z",
        quotaResetsAt: "2026-07-28T12:00:00.000Z",
      }),
    ]);
  });

  test("preserves the structured backend error code for safe resume handling", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "CONFLICT",
          code: "ACTIVE_TURN_RESUME_CONFLICT",
          message: "The current Turn is still active.",
          promptAccepted: false,
          rejoined: false,
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(httpApi.startThreadTurn?.("thread-1", "继续")).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      code: "ACTIVE_TURN_RESUME_CONFLICT",
      message: "The current Turn is still active.",
    });
  });

  test("maps project and audit records and sends steer input as prompt", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "project-1",
            name: "工作台",
            createdAt: "2026-07-21T00:00:00.000Z",
            updatedAt: "2026-07-21T00:00:00.000Z",
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "audit-1",
            actorUserId: "user-1",
            actorName: "林可",
            accountAlias: "Codex 01",
            taskId: "thread-1",
            action: "LEASE_ACQUIRED",
            outcome: "SUCCESS",
            summary: "Codex account lease acquired",
            createdAt: "2026-07-21T00:00:00.000Z",
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "RUNNING" }));
    vi.stubGlobal("fetch", fetcher);

    await expect(httpApi.listProjects()).resolves.toEqual([
      expect.objectContaining({ id: "project-1", taskCount: 0 }),
    ]);
    await expect(httpApi.listAudit()).resolves.toEqual([
      expect.objectContaining({
        actorName: "林可",
        resource: "Codex account lease acquired",
        result: "SUCCESS",
        taskId: "thread-1",
      }),
    ]);
    await httpApi.taskAction("task-1", "steer", "优先处理权限");
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({ prompt: "优先处理权限" }),
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
