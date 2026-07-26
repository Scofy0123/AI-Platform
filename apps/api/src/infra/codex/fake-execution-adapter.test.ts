import { describe, expect, test, vi } from "vitest";
import { FakeExecutionAdapter } from "./fake-execution-adapter.js";

describe("FakeExecutionAdapter", () => {
  test("simulates the full visible Codex workflow for local UI and scheduler tests", async () => {
    const adapter = new FakeExecutionAdapter();
    const listener = vi.fn();
    adapter.on("taskEvent", listener);

    await expect(
      adapter.startTask({
        accountId: "account-1",
        codexHome: "/tmp/fake",
        taskId: "task-1",
        userId: "user-1",
        cwd: "/tmp/workspace",
        prompt: "Build it",
        existingThreadId: null,
      }),
    ).resolves.toEqual({
      threadId: expect.stringMatching(/^fake-thread-/),
      turnId: expect.stringMatching(/^fake-turn-/),
    });
    await nextTick();

    expect(listener.mock.calls.map((call) => call[0].type)).toEqual([
      "TURN_STARTED",
      "PLAN_UPDATED",
      "COMMAND_STARTED",
      "COMMAND_OUTPUT",
      "COMMAND_COMPLETED",
      "TOOL_STARTED",
      "TOOL_COMPLETED",
      "DIFF_UPDATED",
      "AGENT_MESSAGE_DELTA",
      "TURN_COMPLETED",
    ]);
  });

  test("simulates account login and a known weekly quota", async () => {
    const adapter = new FakeExecutionAdapter();
    const authenticated = vi.fn();
    adapter.on("accountAuthenticated", authenticated);
    const account = {
      id: "account-1",
      alias: "Fake Codex",
      codexHome: "/tmp/fake",
      status: "REAUTH_REQUIRED" as const,
      authStatus: "UNAUTHENTICATED",
      activeUsers: 0,
      activeTurns: 0,
      maxActiveUsers: 4,
      weeklyRemaining: null,
      quotaUpdatedAt: null,
      quotaResetsAt: null,
      allowUnknownQuota: false,
      healthScore: 100,
    };

    await expect(adapter.startAccountLogin(account)).resolves.toMatchObject({
      authUrl: "http://127.0.0.1:4310/fake-codex-login-complete",
    });
    await nextTick();
    expect(authenticated).toHaveBeenCalledWith({ accountId: "account-1" });
    await expect(adapter.refreshWeeklyQuota(account)).resolves.toMatchObject({
      status: "KNOWN",
      remainingPercent: 90,
    });
  });
});

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
