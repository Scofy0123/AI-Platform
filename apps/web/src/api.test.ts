// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import { httpApi } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP API adapter", () => {
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
            accountAlias: "Codex 01",
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
        actorName: "user-1",
        resource: "Codex account lease acquired",
        result: "SUCCESS",
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
