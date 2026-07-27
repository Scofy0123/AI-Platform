import { EventEmitter } from "node:events";
import type { ActorContext, EffectiveThreadConfigSnapshot } from "@codexplatform/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  ActiveTurnResumeConflictError,
  type ApprovalDraft,
  InvalidThreadResumeResponseError,
} from "../../domain/platform-service.js";
import { ActorRegistry } from "../../tools/actor-registry.js";
import {
  AppServerExecutionAdapter,
  type ManagedRuntimePort,
  type RuntimeSupervisorPort,
} from "./app-server-execution-adapter.js";
import type { Model } from "./generated/v2/Model.js";
import type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse.js";

const TEST_EXECUTION_CONTEXT: {
  effectiveConfig: EffectiveThreadConfigSnapshot;
  actorContext: ActorContext;
} = {
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
    toolScopes: ["demo"],
    approvalPolicy: "ASK",
  },
};

describe("AppServerExecutionAdapter", () => {
  test("maps the runtime model catalog to the public model option contract", async () => {
    const rpc = new FakeRpc();
    const runtime = {
      ...runtimePort(),
      listModels: vi.fn(
        async (): Promise<Model[]> => [
          {
            id: "runtime-model-1",
            model: "provider-model-1",
            upgrade: null,
            upgradeInfo: null,
            availabilityNux: null,
            displayName: "Runtime Model One",
            description: "Runtime supplied model",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "high", description: "Deep" },
            ],
            defaultReasoningEffort: "high",
            inputModalities: ["text", "image"],
            supportsPersonality: true,
            additionalSpeedTiers: [],
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: true,
          },
        ],
      ),
    };
    const startAccount = vi.fn(async () => ({
      accountId: "account-secret-id",
      rpc,
      runtime,
    }));
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount,
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });

    const result = await adapter.listModels({
      id: "account-secret-id",
      alias: "Private Account Alias",
      codexHome: "/private/codex-home",
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
    });
    expect(result).toEqual([
      {
        id: "runtime-model-1",
        model: "provider-model-1",
        displayName: "Runtime Model One",
        description: "Runtime supplied model",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { value: "low", description: "Fast" },
          { value: "high", description: "Deep" },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: true,
      },
    ]);
    expect(startAccount).toHaveBeenCalledWith({
      accountId: "account-secret-id",
      codexHome: "/private/codex-home",
    });
    expect(JSON.stringify(result)).not.toContain("Private Account Alias");
    expect(JSON.stringify(result)).not.toContain("/private/codex-home");
  });

  test("fails closed when resume rejoins an active Turn and never starts another Turn", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    vi.mocked(runtime.resumeThread).mockResolvedValue(
      resumeResponse("thread-1", { type: "active", activeFlags: [] }, [
        { id: "turn-active", status: "inProgress" },
      ]),
    );
    const registry = new ActorRegistry();
    const stopAccount = vi.fn(async () => undefined);
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAccount,
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: registry,
    });
    const events: unknown[] = [];
    const crashes: unknown[] = [];
    adapter.on("taskEvent", (event) => events.push(event));
    adapter.on("accountCrashed", (event) => crashes.push(event));

    const error = await adapter
      .startTask({
        accountId: "account-1",
        codexHome: "/tmp/account-1",
        taskId: "task-1",
        userId: "user-1",
        cwd: "/workspace",
        prompt: "This prompt must not attach to the active Turn",
        existingThreadId: "thread-1",
        ...TEST_EXECUTION_CONTEXT,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActiveTurnResumeConflictError);
    expect(error).toMatchObject({
      code: "ACTIVE_TURN_RESUME_CONFLICT",
      promptAccepted: false,
      rejoined: false,
      threadId: "thread-1",
      turnId: "turn-active",
    });
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(stopAccount).toHaveBeenCalledWith("account-1");
    expect(crashes).toEqual([
      {
        accountId: "account-1",
        reason: "Thread already has an active Turn; the new prompt was not accepted",
        sourceTaskId: "task-1",
        sourceRuntimeTurnId: "turn-active",
      },
    ]);
    expect(
      registry.resolve({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "thread-1",
        turnId: "turn-active",
      }),
    ).toBeNull();

    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-active",
        itemId: "message-active",
        delta: "Still running",
      },
    });
    expect(events).toEqual([]);
  });

  test("starts a new Turn after resuming an idle Thread", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    vi.mocked(runtime.resumeThread).mockResolvedValue(
      resumeResponse("thread-1", { type: "idle" }, [{ id: "turn-completed", status: "completed" }]),
    );
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });

    await expect(
      adapter.startTask({
        accountId: "account-1",
        codexHome: "/tmp/account-1",
        taskId: "task-1",
        userId: "user-1",
        cwd: "/workspace",
        prompt: "Start the next Turn",
        existingThreadId: "thread-1",
        ...TEST_EXECUTION_CONTEXT,
      }),
    ).resolves.toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(runtime.resumeThread).toHaveBeenCalledOnce();
    expect(runtime.disableThreadMemory).toHaveBeenCalledWith("thread-1");
    expect(runtime.startTurn).toHaveBeenCalledOnce();
    expect(vi.mocked(runtime.resumeThread).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtime.disableThreadMemory).mock.invocationCallOrder[0] as number,
    );
    expect(vi.mocked(runtime.disableThreadMemory).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtime.startTurn).mock.invocationCallOrder[0] as number,
    );
  });

  test("disables native memory after creating a Thread and before starting its Turn", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });

    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Start safely",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });

    expect(runtime.disableThreadMemory).toHaveBeenCalledWith("thread-1");
    expect(vi.mocked(runtime.startThread).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtime.disableThreadMemory).mock.invocationCallOrder[0] as number,
    );
    expect(vi.mocked(runtime.disableThreadMemory).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runtime.startTurn).mock.invocationCallOrder[0] as number,
    );
  });

  test.each([
    ["new", null],
    ["resumed", "thread-1"],
  ] as const)(
    "fails closed when native memory cannot be disabled on a %s Thread",
    async (_kind, existingThreadId) => {
      const rpc = new FakeRpc();
      const runtime = runtimePort();
      vi.mocked(runtime.disableThreadMemory).mockRejectedValueOnce(
        new Error("memory mode unavailable"),
      );
      const stopAccount = vi.fn(async () => undefined);
      const adapter = new AppServerExecutionAdapter({
        supervisor: {
          startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
          stopAccount,
          stopAll: async () => undefined,
        },
        tools: {
          definitions: () => [],
          invoke: async () => ({ success: true, contentItems: [] }),
        },
        actors: new ActorRegistry(),
      });
      const crashes: unknown[] = [];
      adapter.on("accountCrashed", (event) => crashes.push(event));

      await expect(
        adapter.startTask({
          accountId: "account-1",
          codexHome: "/tmp/account-1",
          taskId: "task-1",
          userId: "user-1",
          cwd: "/workspace",
          prompt: "Must not run",
          existingThreadId,
          ...TEST_EXECUTION_CONTEXT,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_THREAD_RESUME_RESPONSE",
        promptAccepted: false,
        rejoined: false,
      });
      expect(runtime.startTurn).not.toHaveBeenCalled();
      expect(stopAccount).toHaveBeenCalledWith("account-1");
      expect(crashes).toEqual([
        expect.objectContaining({
          accountId: "account-1",
          reason: expect.stringContaining("unsafe"),
        }),
      ]);
    },
  );

  test.each([null, [], { accepted: true }])(
    "fails closed on a malformed native memory response: %j",
    async (memoryResponse) => {
      const rpc = new FakeRpc();
      const runtime = runtimePort();
      vi.mocked(runtime.disableThreadMemory).mockResolvedValueOnce(memoryResponse);
      const stopAccount = vi.fn(async () => undefined);
      const adapter = new AppServerExecutionAdapter({
        supervisor: {
          startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
          stopAccount,
          stopAll: async () => undefined,
        },
        tools: {
          definitions: () => [],
          invoke: async () => ({ success: true, contentItems: [] }),
        },
        actors: new ActorRegistry(),
      });
      const crashes: unknown[] = [];
      adapter.on("accountCrashed", (event) => crashes.push(event));

      await expect(
        adapter.startTask({
          accountId: "account-1",
          codexHome: "/tmp/account-1",
          taskId: "task-1",
          userId: "user-1",
          cwd: "/workspace",
          prompt: "Must not run",
          existingThreadId: null,
          ...TEST_EXECUTION_CONTEXT,
        }),
      ).rejects.toMatchObject({ code: "INVALID_THREAD_RESUME_RESPONSE" });
      expect(runtime.startTurn).not.toHaveBeenCalled();
      expect(stopAccount).toHaveBeenCalledWith("account-1");
      expect(crashes).toEqual([
        expect.objectContaining({
          accountId: "account-1",
          reason: expect.stringContaining("unsafe"),
        }),
      ]);
    },
  );

  test("detaches every same-account Turn and pending approval before intentionally stopping", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    vi.mocked(runtime.startThread)
      .mockResolvedValueOnce({ thread: { id: "thread-a" } })
      .mockResolvedValueOnce({ thread: { id: "thread-b" } });
    vi.mocked(runtime.startTurn)
      .mockResolvedValueOnce({ turn: { id: "turn-a" } })
      .mockResolvedValueOnce({ turn: { id: "turn-b" } });
    const stopAccount = vi.fn(async () => undefined);
    const registry = new ActorRegistry();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAccount,
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: registry,
    });
    const approvals: ApprovalDraft[] = [];
    const events: unknown[] = [];
    const crashes: unknown[] = [];
    adapter.on("approval", (approval) => approvals.push(approval));
    adapter.on("taskEvent", (event) => events.push(event));
    adapter.on("accountCrashed", (event) => crashes.push(event));

    for (const suffix of ["a", "b"]) {
      await adapter.startTask({
        accountId: "account-1",
        codexHome: "/tmp/account-1",
        taskId: `task-${suffix}`,
        userId: `user-${suffix}`,
        cwd: `/workspace/${suffix}`,
        prompt: `Build ${suffix}`,
        existingThreadId: null,
        ...TEST_EXECUTION_CONTEXT,
      });
    }
    rpc.emit("serverRequest", {
      id: "approval-b",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-b",
        turnId: "turn-b",
        itemId: "command-b",
        command: "pnpm test",
      },
    });
    await nextTick();
    expect(approvals).toHaveLength(1);

    vi.mocked(runtime.resumeThread).mockResolvedValueOnce(
      resumeResponse("thread-a", { type: "active", activeFlags: [] }, [
        { id: "turn-a", status: "inProgress" },
      ]),
    );
    await expect(
      adapter.startTask({
        accountId: "account-1",
        codexHome: "/tmp/account-1",
        taskId: "task-resume",
        userId: "user-a",
        cwd: "/workspace/a",
        prompt: "Resume",
        existingThreadId: "thread-a",
        ...TEST_EXECUTION_CONTEXT,
      }),
    ).rejects.toBeInstanceOf(ActiveTurnResumeConflictError);

    expect(stopAccount).toHaveBeenCalledWith("account-1");
    expect(crashes).toEqual([
      expect.objectContaining({
        accountId: "account-1",
        reason: "Thread already has an active Turn; the new prompt was not accepted",
        sourceTaskId: "task-resume",
        sourceRuntimeTurnId: "turn-a",
      }),
    ]);
    for (const suffix of ["a", "b"]) {
      expect(
        registry.resolve({
          accountId: "account-1",
          connectionGeneration: 1,
          threadId: `thread-${suffix}`,
          turnId: `turn-${suffix}`,
        }),
      ).toBeNull();
      await expect(
        adapter.steerTask(`thread-${suffix}`, `turn-${suffix}`, "continue"),
      ).rejects.toThrow("not attached");
    }
    const approval = approvals[0] as ApprovalDraft;
    await expect(
      adapter.respondApproval(approval.requestId, "accept", {
        approvalType: approval.approvalType,
        transport: {
          accountId: approval.accountId,
          connectionGeneration: approval.connectionGeneration,
          threadId: approval.threadId,
          turnId: approval.turnId,
          requestId: approval.requestId,
          rawRpcId: approval.rawRpcId,
        },
      }),
    ).rejects.toThrow("no longer attached");

    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-b",
        turnId: "turn-b",
        itemId: "late-message",
        delta: "must be ignored",
      },
    });
    expect(events).toEqual([]);
  });

  test("fails closed when an idle resume response still contains an in-progress Turn", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    vi.mocked(runtime.resumeThread).mockResolvedValue(
      resumeResponse("thread-1", { type: "idle" }, [
        { id: "turn-inconsistent", status: "inProgress" },
      ]),
    );
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });

    await expect(
      adapter.startTask({
        accountId: "account-1",
        codexHome: "/tmp/account-1",
        taskId: "task-1",
        userId: "user-1",
        cwd: "/workspace",
        prompt: "Do not attach this prompt",
        existingThreadId: "thread-1",
        ...TEST_EXECUTION_CONTEXT,
      }),
    ).rejects.toThrow("inconsistent with an in-progress Turn");
    expect(runtime.startTurn).not.toHaveBeenCalled();
  });

  test.each([
    [
      "unknown thread status",
      {
        thread: {
          id: "thread-1",
          status: { type: "futureStatus" },
          turns: [],
        },
      },
    ],
    [
      "missing turns",
      {
        thread: {
          id: "thread-1",
          status: { type: "idle" },
        },
      },
    ],
    [
      "unknown turn status",
      {
        thread: {
          id: "thread-1",
          status: { type: "idle" },
          turns: [{ id: "turn-1", status: "futureTurnStatus" }],
        },
      },
    ],
    [
      "idle status with active flags",
      {
        thread: {
          id: "thread-1",
          status: { type: "idle", activeFlags: [] },
          turns: [{ id: "turn-1", status: "completed" }],
        },
      },
    ],
    [
      "malformed active flags",
      {
        thread: {
          id: "thread-1",
          status: { type: "active", activeFlags: "waitingOnApproval" },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      },
    ],
    [
      "unknown active flag",
      {
        thread: {
          id: "thread-1",
          status: { type: "active", activeFlags: ["futureFlag"] },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      },
    ],
    [
      "missing thread id",
      {
        thread: {
          status: { type: "idle" },
          turns: [],
        },
      },
    ],
  ])("stops and quarantines malformed resume payloads: %s", async (_name, payload) => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    vi.mocked(runtime.resumeThread).mockResolvedValue(payload as unknown as ThreadResumeResponse);
    const stopAccount = vi.fn(async () => undefined);
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAccount,
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const crashes: unknown[] = [];
    adapter.on("accountCrashed", (event) => crashes.push(event));

    const error = await adapter
      .startTask({
        accountId: "account-1",
        codexHome: "/tmp/account-1",
        taskId: "task-1",
        userId: "user-1",
        cwd: "/workspace",
        prompt: "Do not start",
        existingThreadId: "thread-1",
        ...TEST_EXECUTION_CONTEXT,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidThreadResumeResponseError);
    expect(error).toMatchObject({
      code: "INVALID_THREAD_RESUME_RESPONSE",
      promptAccepted: false,
      rejoined: false,
      threadId: "thread-1",
    });
    expect(runtime.startTurn).not.toHaveBeenCalled();
    expect(stopAccount).toHaveBeenCalledWith("account-1");
    expect(crashes).toEqual([
      expect.objectContaining({
        accountId: "account-1",
        reason: expect.stringContaining("unsafe"),
      }),
    ]);
  });

  test("starts one thread/turn, normalizes notifications and binds dynamic tools to its actor", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const supervisor: RuntimeSupervisorPort = {
      startAccount: vi.fn(async () => ({ accountId: "account-1", rpc, runtime })),
      stopAll: vi.fn(async () => undefined),
    };
    const tools = {
      definitions: vi.fn(() => [
        { type: "function" as const, name: "demo", description: "demo", inputSchema: {} },
      ]),
      invoke: vi.fn(async () => ({
        success: true,
        contentItems: [{ type: "inputText" as const, text: "ok" }],
      })),
    };
    const registry = new ActorRegistry();
    const adapter = new AppServerExecutionAdapter({ supervisor, tools, actors: registry });
    const events: unknown[] = [];
    adapter.on("taskEvent", (event) => events.push(event));

    await expect(
      adapter.startTask({
        accountId: "account-1",
        codexHome: "/tmp/account-1",
        taskId: "task-1",
        userId: "user-1",
        cwd: "/workspace",
        prompt: "Build it",
        existingThreadId: null,
        ...TEST_EXECUTION_CONTEXT,
      }),
    ).resolves.toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(runtime.startThread).toHaveBeenCalledWith({
      cwd: "/workspace",
      dynamicTools: tools.definitions(),
      effectiveConfig: TEST_EXECUTION_CONTEXT.effectiveConfig,
    });
    expect(
      registry.resolve({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toMatchObject({
      taskId: "task-1",
      actorContext: { userId: "user-1" },
    });

    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Hi" },
    });
    expect(events).toEqual([
      expect.objectContaining({ taskId: "task-1", type: "AGENT_MESSAGE_DELTA" }),
    ]);

    rpc.emit("serverRequest", {
      id: 7,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: null,
        tool: "demo",
        arguments: {},
      },
    });
    await nextTick();
    expect(tools.invoke).toHaveBeenCalled();
    expect(rpc.respond).toHaveBeenCalledWith(7, {
      success: true,
      contentItems: [{ type: "inputText", text: "ok" }],
    });
  });

  test("inherits the parent actor for observable subagent threads and clears it with the parent", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const registry = new ActorRegistry();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: registry,
    });
    const events: Array<{
      type: string;
      threadId: string | null;
      subagentThreadId?: string;
      payload: unknown;
    }> = [];
    const approvals: unknown[] = [];
    adapter.on("taskEvent", (event) => events.push(event));
    adapter.on("approval", (approval) => approvals.push(approval));
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Delegate",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });

    rpc.emit("notification", {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "subagent-activity-1",
          kind: "started",
          agentThreadId: "agent-thread-1",
          agentPath: "research",
        },
      },
    });
    rpc.emit("notification", {
      method: "turn/started",
      params: { threadId: "agent-thread-1", turn: { id: "agent-turn-1" } },
    });
    expect(
      registry.resolve({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "agent-thread-1",
        turnId: "agent-turn-1",
      }),
    ).toMatchObject({
      taskId: "task-1",
      accountId: "account-1",
      actorContext: { userId: "user-1" },
    });
    rpc.emit("serverRequest", {
      id: "child-approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "agent-thread-1",
        turnId: "agent-turn-1",
        itemId: "child-command-1",
        command: "pnpm test",
      },
    });
    expect(approvals).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        threadId: "agent-thread-1",
        turnId: "agent-turn-1",
        parentTurnId: "turn-1",
      }),
    ]);
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "agent-thread-1",
        turnId: "agent-turn-1",
        itemId: "child-message-1",
        delta: "child detail",
      },
    });
    rpc.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "agent-thread-1",
        turn: { id: "agent-turn-1", status: "completed" },
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      "SUBAGENT_ACTIVITY",
      "TURN_STARTED",
      "AGENT_MESSAGE_DELTA",
      "TURN_COMPLETED",
    ]);
    expect(events[0]).not.toHaveProperty("subagentThreadId");
    expect(events.slice(1)).toEqual([
      expect.objectContaining({ subagentThreadId: "agent-thread-1" }),
      expect.objectContaining({
        subagentThreadId: "agent-thread-1",
        payload: expect.objectContaining({ delta: "child detail" }),
      }),
      expect.objectContaining({ subagentThreadId: "agent-thread-1" }),
    ]);
    expect(
      registry.resolve({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "agent-thread-1",
        turnId: "agent-turn-1",
      }),
    ).toBeNull();

    rpc.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    expect(
      registry.resolve({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "agent-thread-1",
        turnId: "agent-turn-1",
      }),
    ).toBeNull();
  });

  test("persists the exact approval RPC id and replies only after a user decision", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const approvals: unknown[] = [];
    adapter.on("approval", (approval) => approvals.push(approval));
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });

    rpc.emit("serverRequest", {
      id: "rpc-approval-1",
      method: "item/fileChange/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "change-1",
        reason: "write",
      },
    });
    expect(approvals).toEqual([
      expect.objectContaining({
        requestId: "rpc-approval-1",
        rawRpcId: "rpc-approval-1",
        accountId: "account-1",
        connectionGeneration: 1,
        approvalType: "FILE_CHANGE",
      }),
    ]);
    expect(rpc.respond).not.toHaveBeenCalled();

    await adapter.respondApproval("rpc-approval-1", "accept", {
      approvalType: "FILE_CHANGE",
      transport: {
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "thread-1",
        turnId: "turn-1",
        requestId: "rpc-approval-1",
        rawRpcId: "rpc-approval-1",
      },
    });
    expect(rpc.respond).toHaveBeenCalledWith("rpc-approval-1", { decision: "accept" });
  });

  test("buffers an approval until the starting Turn identity is attached", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const turnStarted = deferred<unknown>();
    vi.mocked(runtime.startTurn).mockReturnValueOnce(turnStarted.promise);
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const approvals: unknown[] = [];
    adapter.on("approval", (approval) => approvals.push(approval));

    const start = adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    await nextTick();
    rpc.emit("serverRequest", {
      id: 21,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-early",
        command: "pnpm test",
      },
    });
    await nextTick();
    expect(approvals).toEqual([]);

    turnStarted.resolve({ turn: { id: "turn-1" } });
    await expect(start).resolves.toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(approvals).toEqual([expect.objectContaining({ requestId: "21", turnId: "turn-1" })]);
    expect(rpc.respondError).not.toHaveBeenCalled();
  });

  test("does not resurrect an actor after a terminal notification arrives during start", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const turnStarted = deferred<unknown>();
    vi.mocked(runtime.startTurn).mockReturnValueOnce(turnStarted.promise);
    const actors = new ActorRegistry();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors,
    });
    const approvals: unknown[] = [];
    adapter.on("approval", (approval) => approvals.push(approval));

    const start = adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    await nextTick();
    rpc.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    turnStarted.resolve({ turn: { id: "turn-1" } });
    await start;

    expect(
      actors.resolve({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toBeNull();
    rpc.emit("serverRequest", {
      id: 22,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-late",
        command: "pnpm publish",
      },
    });
    await nextTick();
    expect(approvals).toEqual([]);
    expect(rpc.respondError).toHaveBeenCalledWith(22, {
      code: -32_601,
      message: "Approval Turn is no longer active",
    });
  });

  test("quarantines the account when rejecting a buffered request cannot be delivered", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const turnStarted = deferred<unknown>();
    vi.mocked(runtime.startTurn).mockReturnValueOnce(turnStarted.promise);
    rpc.respondError.mockRejectedValueOnce(new Error("transport write failed"));
    const stopAccount = vi.fn(async () => undefined);
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAccount,
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const crashes: unknown[] = [];
    adapter.on("accountCrashed", (event) => crashes.push(event));

    const start = adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    await nextTick();
    rpc.emit("serverRequest", {
      id: 23,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-start-failed",
        command: "pnpm test",
      },
    });
    turnStarted.reject(new Error("turn start failed"));

    await expect(start).rejects.toThrow("turn start failed");
    await nextTick();
    expect(crashes).toEqual([
      {
        accountId: "account-1",
        reason: "Codex response delivery failed; recovery is required.",
      },
    ]);
    expect(stopAccount).toHaveBeenCalledWith("account-1");
  });

  test("keeps an approval pending until its response write is acknowledged", async () => {
    const rpc = new FakeRpc();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime: runtimePort() }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    const transport = {
      accountId: "account-1",
      connectionGeneration: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "7",
      rawRpcId: 7,
    };
    rpc.emit("serverRequest", {
      id: 7,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "change-1" },
    });
    const acknowledgement = deferred<void>();
    rpc.respond.mockReturnValueOnce(acknowledgement.promise);
    let settled = false;

    const delivery = adapter
      .respondApproval("7", "accept", { approvalType: "FILE_CHANGE", transport })
      .finally(() => {
        settled = true;
      });
    await nextTick();
    expect(settled).toBe(false);

    acknowledgement.resolve();
    await expect(delivery).resolves.toBeUndefined();

    rpc.emit("serverRequest", {
      id: 8,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "change-2" },
    });
    const retryTransport = { ...transport, requestId: "8", rawRpcId: 8 };
    rpc.respond.mockRejectedValueOnce(new Error("async write failed"));
    await expect(
      adapter.respondApproval("8", "accept", {
        approvalType: "FILE_CHANGE",
        transport: retryTransport,
      }),
    ).rejects.toThrow("async write failed");
    await expect(
      adapter.respondApproval("8", "accept", {
        approvalType: "FILE_CHANGE",
        transport: retryTransport,
      }),
    ).resolves.toBeUndefined();
  });

  test("awaits dynamic-tool and unsupported-request response writes", async () => {
    const rpc = new FakeRpc();
    const tools = {
      definitions: () => [],
      invoke: async () => ({ success: true, contentItems: [] }),
    };
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime: runtimePort() }),
        stopAll: async () => undefined,
      },
      tools,
      actors: new ActorRegistry(),
    });
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    const toolAck = deferred<void>();
    rpc.respond.mockReturnValueOnce(toolAck.promise);
    let toolSettled = false;

    const toolResponse = invokeServerRequest(adapter, rpc, {
      id: 10,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "demo",
        arguments: {},
      },
    }).finally(() => {
      toolSettled = true;
    });
    await nextTick();
    expect(toolSettled).toBe(false);
    toolAck.resolve();
    await expect(toolResponse).resolves.toBeUndefined();

    const errorAck = deferred<void>();
    rpc.respondError.mockReturnValueOnce(errorAck.promise);
    let errorSettled = false;
    const unsupportedResponse = invokeServerRequest(adapter, rpc, {
      id: 11,
      method: "unsupported/request",
      params: {},
    }).finally(() => {
      errorSettled = true;
    });
    await nextTick();
    expect(errorSettled).toBe(false);
    errorAck.resolve();
    await expect(unsupportedResponse).resolves.toBeUndefined();
  });

  test("rejects a dynamic Tool request from a stale or different App Server connection", async () => {
    const rpc = new FakeRpc();
    const invoke = vi.fn(async () => ({ success: true, contentItems: [] }));
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime: runtimePort() }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke },
      actors: new ActorRegistry(),
    });
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    const message = {
      id: 77,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-stale",
        tool: "demo",
        arguments: {},
      },
    };
    const handle = (
      adapter as unknown as {
        handleServerRequest(
          accountId: string,
          connectionGeneration: number,
          rpc: FakeRpc,
          message: unknown,
        ): Promise<void>;
      }
    ).handleServerRequest.bind(adapter);

    await handle("account-other", 1, rpc, message);
    await handle("account-1", 99, rpc, message);
    const replacedRpc = new FakeRpc();
    await handle("account-1", 1, replacedRpc, message);

    expect(invoke).not.toHaveBeenCalled();
    expect(rpc.respondError).toHaveBeenCalledTimes(2);
    expect(rpc.respondError).toHaveBeenCalledWith(77, {
      code: -32_601,
      message: "Tool call is not bound to this App Server connection",
    });
    expect(replacedRpc.respondError).toHaveBeenCalledWith(77, {
      code: -32_601,
      message: "Tool call is not bound to this App Server connection",
    });
  });

  test("contains an asynchronous server-response failure at the real event listener", async () => {
    const rpc = new FakeRpc();
    const stopAccount = vi.fn(async () => undefined);
    const actors = new ActorRegistry();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime: runtimePort() }),
        stopAccount,
        stopAll: async () => undefined,
      },
      tools: {
        definitions: () => [],
        invoke: async () => ({ success: true, contentItems: [] }),
      },
      actors,
    });
    const events: unknown[] = [];
    const quarantined: unknown[] = [];
    adapter.on("taskEvent", (event) => events.push(event));
    adapter.on("accountCrashed", (event) => quarantined.push(event));
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    rpc.respond.mockRejectedValueOnce(new Error("transport write failed"));

    rpc.emit("serverRequest", {
      id: 10,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "demo",
        arguments: {},
      },
    });
    await nextTick();
    await nextTick();

    expect(events).toEqual([]);
    expect(quarantined).toEqual([
      {
        accountId: "account-1",
        reason: "Codex response delivery failed; recovery is required.",
      },
    ]);
    expect(stopAccount).toHaveBeenCalledWith("account-1");
    expect(
      actors.resolve({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toBeNull();
    await expect(adapter.steerTask("thread-1", "turn-1", "continue")).rejects.toThrow(
      "not attached",
    );
  });

  test("routes the same raw RPC id to its exact runtime connection", async () => {
    const rpcA = new FakeRpc();
    const rpcB = new FakeRpc();
    const runtimeA = runtimePort("thread-a", "turn-a");
    const runtimeB = runtimePort("thread-b", "turn-b");
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async ({ accountId }) =>
          accountId === "account-a"
            ? { accountId, rpc: rpcA, runtime: runtimeA }
            : { accountId, rpc: rpcB, runtime: runtimeB },
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const approvals: Array<Record<string, unknown>> = [];
    adapter.on("approval", (approval) =>
      approvals.push(approval as unknown as Record<string, unknown>),
    );
    await adapter.startTask({
      accountId: "account-a",
      codexHome: "/tmp/account-a",
      taskId: "task-a",
      userId: "user-a",
      cwd: "/workspace/a",
      prompt: "A",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    await adapter.startTask({
      accountId: "account-b",
      codexHome: "/tmp/account-b",
      taskId: "task-b",
      userId: "user-b",
      cwd: "/workspace/b",
      prompt: "B",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });

    rpcA.emit("serverRequest", {
      id: 7,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-a", turnId: "turn-a", itemId: "change-a" },
    });
    rpcB.emit("serverRequest", {
      id: 7,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-b", turnId: "turn-b", itemId: "change-b" },
    });
    const approvalA = approvals.find((approval) => approval.accountId === "account-a");
    const approvalB = approvals.find((approval) => approval.accountId === "account-b");

    await adapter.respondApproval("7", "accept", {
      approvalType: "FILE_CHANGE",
      transport: approvalA as never,
    });
    await adapter.respondApproval("7", "decline", {
      approvalType: "FILE_CHANGE",
      transport: approvalB as never,
    });

    expect(rpcA.respond).toHaveBeenCalledWith(7, { decision: "accept" });
    expect(rpcB.respond).toHaveBeenCalledWith(7, { decision: "decline" });
  });

  test("uses the generated v2 permissions response shape for grants and denials", async () => {
    const rpc = new FakeRpc();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime: runtimePort() }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const approvals: Array<Record<string, unknown>> = [];
    adapter.on("approval", (approval) =>
      approvals.push(approval as unknown as Record<string, unknown>),
    );
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "permissions-1",
      environmentId: null,
      startedAtMs: 1,
      cwd: "/workspace",
      reason: "network",
      permissions: { network: { enabled: true }, fileSystem: null },
    };
    rpc.emit("serverRequest", { id: 7, method: "item/permissions/requestApproval", params });

    await adapter.respondApproval("7", "acceptForSession", {
      approvalType: "PERMISSIONS",
      transport: approvals[0] as never,
    });
    expect(rpc.respond).toHaveBeenLastCalledWith(7, {
      permissions: { network: { enabled: true } },
      scope: "session",
    });

    rpc.emit("serverRequest", { id: 8, method: "item/permissions/requestApproval", params });
    await adapter.respondApproval("8", "decline", {
      approvalType: "PERMISSIONS",
      transport: approvals[1] as never,
    });
    expect(rpc.respond).toHaveBeenLastCalledWith(8, { permissions: {}, scope: "turn" });

    rpc.emit("serverRequest", { id: 9, method: "item/permissions/requestApproval", params });
    await adapter.respondApproval("9", "cancel", {
      approvalType: "PERMISSIONS",
      transport: approvals[2] as never,
    });
    expect(rpc.respond).toHaveBeenLastCalledWith(9, { permissions: {}, scope: "turn" });
  });

  test("maps account login completion and exact quota reads", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const authenticated = vi.fn();
    adapter.on("accountAuthenticated", authenticated);
    const account = {
      id: "account-1",
      alias: "Codex A",
      codexHome: "/tmp/account-1",
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

    await expect(adapter.startAccountLogin(account)).resolves.toEqual({
      loginId: "login-1",
      authUrl: "https://auth.example.test/codex",
    });
    rpc.emit("notification", {
      method: "account/login/completed",
      params: { loginId: "login-1", success: true, error: null },
    });
    expect(authenticated).toHaveBeenCalledWith({ accountId: "account-1" });
    await expect(adapter.refreshWeeklyQuota(account)).resolves.toMatchObject({ status: "KNOWN" });
  });

  test("detaches a crashed account boundary and delegates persisted recovery once", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const registry = new ActorRegistry();
    const supervisor = Object.assign(new EventEmitter(), {
      startAccount: vi.fn(async () => ({ accountId: "account-1", rpc, runtime })),
      stopAll: vi.fn(async () => undefined),
    });
    const adapter = new AppServerExecutionAdapter({
      supervisor,
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: registry,
    });
    const taskEvents: unknown[] = [];
    const crashes: unknown[] = [];
    const approvals: ApprovalDraft[] = [];
    adapter.on("taskEvent", (event) => taskEvents.push(event));
    adapter.on("accountCrashed", (event) => crashes.push(event));
    adapter.on("approval", (approval) => approvals.push(approval));
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    rpc.emit("serverRequest", {
      id: "crash-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-before-crash",
        command: "pnpm test",
      },
    });
    await nextTick();
    expect(approvals).toHaveLength(1);

    supervisor.emit("accountCrashed", { accountId: "account-1", exitCode: 9, signal: null });

    expect(crashes).toEqual([
      {
        accountId: "account-1",
        reason: "Codex App Server exited; recovery is required.",
      },
    ]);
    expect(
      registry.resolve({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toBeNull();
    await expect(adapter.steerTask("thread-1", "turn-1", "continue")).rejects.toThrow(
      "not attached",
    );
    const approval = approvals[0] as ApprovalDraft;
    await expect(
      adapter.respondApproval(approval.requestId, "accept", {
        approvalType: approval.approvalType,
        transport: {
          accountId: approval.accountId,
          connectionGeneration: approval.connectionGeneration,
          threadId: approval.threadId,
          turnId: approval.turnId,
          requestId: approval.requestId,
          rawRpcId: approval.rawRpcId,
        },
      }),
    ).rejects.toThrow("no longer attached");
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "late-after-crash",
        delta: "must be ignored",
      },
    });
    expect(taskEvents).toEqual([]);
  });

  test("detaches pending approvals when their Turn becomes terminal", async () => {
    const rpc = new FakeRpc();
    const adapter = new AppServerExecutionAdapter({
      supervisor: {
        startAccount: async () => ({ accountId: "account-1", rpc, runtime: runtimePort() }),
        stopAll: async () => undefined,
      },
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const approvals: unknown[] = [];
    adapter.on("approval", (approval) => approvals.push(approval));
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });
    rpc.emit("serverRequest", {
      id: 17,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        command: "pnpm test",
      },
    });
    rpc.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
    });
    rpc.emit("serverRequest", {
      id: 18,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-late",
        command: "pnpm publish",
      },
    });
    await nextTick();

    await expect(
      adapter.respondApproval("17", "accept", {
        approvalType: "COMMAND",
        transport: {
          accountId: "account-1",
          connectionGeneration: 1,
          threadId: "thread-1",
          turnId: "turn-1",
          requestId: "17",
          rawRpcId: 17,
        },
      }),
    ).rejects.toThrow("no longer attached");
    expect(approvals).toHaveLength(1);
    expect(rpc.respondError).toHaveBeenCalledWith(18, {
      code: -32_601,
      message: "Approval Turn is no longer active",
    });
    expect(rpc.respond).not.toHaveBeenCalled();
  });

  test("does not report a completed turn as failed when its worker later exits", async () => {
    const rpc = new FakeRpc();
    const runtime = runtimePort();
    const supervisor = Object.assign(new EventEmitter(), {
      startAccount: vi.fn(async () => ({ accountId: "account-1", rpc, runtime })),
      stopAll: vi.fn(async () => undefined),
    });
    const adapter = new AppServerExecutionAdapter({
      supervisor,
      tools: { definitions: () => [], invoke: async () => ({ success: true, contentItems: [] }) },
      actors: new ActorRegistry(),
    });
    const taskEvents: Array<{ type: string }> = [];
    adapter.on("taskEvent", (event) => taskEvents.push(event));
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
      ...TEST_EXECUTION_CONTEXT,
    });

    rpc.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    supervisor.emit("accountCrashed", { accountId: "account-1", exitCode: 9, signal: null });

    expect(taskEvents.map((event) => event.type)).toEqual(["TURN_COMPLETED"]);
  });
});

class FakeRpc extends EventEmitter {
  readonly respond = vi.fn(async (): Promise<void> => undefined);
  readonly respondError = vi.fn(async (): Promise<void> => undefined);
}

function runtimePort(threadId = "thread-1", turnId = "turn-1"): ManagedRuntimePort["runtime"] {
  return {
    startThread: vi.fn(async () => ({ thread: { id: threadId } })),
    resumeThread: vi.fn(async () => resumeResponse(threadId, { type: "idle" }, [])),
    startTurn: vi.fn(async () => ({ turn: { id: turnId } })),
    disableThreadMemory: vi.fn(async () => ({})),
    steerTurn: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
    startChatGptLogin: vi.fn(async () => ({
      loginId: "login-1",
      authUrl: "https://auth.example.test/codex",
    })),
    listModels: vi.fn(async () => []),
    readWeeklyQuota: vi.fn(async () => ({
      status: "KNOWN" as const,
      limitId: "codex",
      usedPercent: 20,
      remainingPercent: 80,
      windowDurationMins: 10_080 as const,
      resetsAt: 1_785_225_600,
    })),
  };
}

function resumeResponse(
  threadId: string,
  status: ThreadResumeResponse["thread"]["status"],
  turns: Array<{ id: string; status: ThreadResumeResponse["thread"]["turns"][number]["status"] }>,
): ThreadResumeResponse {
  return {
    thread: {
      id: threadId,
      status,
      turns: turns.map((turn) => ({
        ...turn,
        items: [],
        itemsView: { type: "full" },
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      })),
    },
  } as unknown as ThreadResumeResponse;
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function invokeServerRequest(
  adapter: AppServerExecutionAdapter,
  rpc: FakeRpc,
  message: unknown,
): Promise<void> {
  return (
    adapter as unknown as {
      handleServerRequest(
        accountId: string,
        connectionGeneration: number,
        rpc: FakeRpc,
        message: unknown,
      ): Promise<void>;
    }
  ).handleServerRequest("account-1", 1, rpc, message);
}
