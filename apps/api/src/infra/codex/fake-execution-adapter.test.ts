import { describe, expect, test, vi } from "vitest";
import { FakeExecutionAdapter } from "./fake-execution-adapter.js";

describe("FakeExecutionAdapter", () => {
  test("publishes a deterministic fake-only model catalog", async () => {
    const adapter = new FakeExecutionAdapter();

    await expect(
      adapter.listModels({
        id: "account-1",
        alias: "Fake Codex",
        codexHome: "/tmp/fake",
        status: "AVAILABLE",
        authStatus: "AUTHENTICATED",
        activeUsers: 0,
        activeTurns: 0,
        maxActiveUsers: 4,
        weeklyRemaining: 90,
        quotaUpdatedAt: "2026-07-27T00:00:00.000Z",
        quotaResetsAt: "2026-08-03T00:00:00.000Z",
        allowUnknownQuota: false,
        healthScore: 100,
      }),
    ).resolves.toEqual([
      {
        id: "fake-codex-standard",
        model: "fake-codex-standard",
        displayName: "Fake Standard",
        description: "Deterministic local model fixture for standard test flows.",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { value: "low", description: "Fast fixture response." },
          { value: "medium", description: "Balanced fixture response." },
          { value: "high", description: "Detailed fixture response." },
        ],
        inputModalities: ["text"],
        supportsPersonality: true,
      },
      {
        id: "fake-codex-deep",
        model: "fake-codex-deep",
        displayName: "Fake Deep",
        description: "Deterministic local model fixture for deeper test flows.",
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { value: "medium", description: "Balanced fixture response." },
          { value: "high", description: "Detailed fixture response." },
          { value: "xhigh", description: "Maximum-depth fixture response." },
        ],
        inputModalities: ["text"],
        supportsPersonality: true,
      },
    ]);
  });

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
        effectiveConfig: {
          model: null,
          reasoningEffort: "MEDIUM",
          permissionMode: "WORKSPACE_WRITE",
          approvalMode: "ASK",
          personality: "PRAGMATIC",
          instructions: "",
          sourceVersion: "test-v1",
        },
        actorContext: {
          tenantKey: "tenant-1",
          userId: "user-1",
          role: "MEMBER",
          toolScopes: [],
          approvalPolicy: "ASK",
        },
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
      "AGENT_MESSAGE_PHASE",
      "TURN_COMPLETED",
    ]);
    expect(listener.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "AGENT_MESSAGE_PHASE",
          payload: expect.objectContaining({ phase: "final_answer" }),
        }),
      ]),
    );
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
