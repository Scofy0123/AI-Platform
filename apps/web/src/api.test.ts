// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { httpApi } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP API adapter", () => {
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
            quotaUpdatedAt: null,
          },
        ]),
      );
    vi.stubGlobal("fetch", fetcher);

    await expect(httpApi.getSession()).resolves.toMatchObject({ authenticated: true });
    await expect(httpApi.listAccounts()).resolves.toEqual([
      expect.objectContaining({ maxUsers: 4, weeklyRemainingPercent: 73, health: 98 }),
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
