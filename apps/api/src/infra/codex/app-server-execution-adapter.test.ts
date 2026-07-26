import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { ActorRegistry } from "../../tools/actor-registry.js";
import {
  AppServerExecutionAdapter,
  type ManagedRuntimePort,
  type RuntimeSupervisorPort,
} from "./app-server-execution-adapter.js";

describe("AppServerExecutionAdapter", () => {
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
      }),
    ).resolves.toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(runtime.startThread).toHaveBeenCalledWith({
      cwd: "/workspace",
      dynamicTools: tools.definitions(),
    });
    expect(registry.resolve("thread-1", "turn-1")).toMatchObject({
      taskId: "task-1",
      userId: "user-1",
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
    });
    await nextTick();
    rpc.emit("notification", {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
    });
    turnStarted.resolve({ turn: { id: "turn-1" } });
    await start;

    expect(actors.resolve("thread-1", "turn-1")).toBeNull();
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
    expect(crashes).toEqual([{ accountId: "account-1" }]);
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

    expect(events).toContainEqual(
      expect.objectContaining({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        type: "RECOVERY_REQUIRED",
        payload: { reason: "Codex response delivery failed; recovery is required." },
      }),
    );
    expect(quarantined).toEqual([{ accountId: "account-1" }]);
    expect(stopAccount).toHaveBeenCalledWith("account-1");
    expect(actors.resolve("thread-1", "turn-1")).toBeNull();
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
    });
    await adapter.startTask({
      accountId: "account-b",
      codexHome: "/tmp/account-b",
      taskId: "task-b",
      userId: "user-b",
      cwd: "/workspace/b",
      prompt: "B",
      existingThreadId: null,
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

  test("quarantines a crashed account boundary and marks every attached turn for recovery", async () => {
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
    const taskEvents: unknown[] = [];
    const crashes: unknown[] = [];
    adapter.on("taskEvent", (event) => taskEvents.push(event));
    adapter.on("accountCrashed", (event) => crashes.push(event));
    await adapter.startTask({
      accountId: "account-1",
      codexHome: "/tmp/account-1",
      taskId: "task-1",
      userId: "user-1",
      cwd: "/workspace",
      prompt: "Build it",
      existingThreadId: null,
    });

    supervisor.emit("accountCrashed", { accountId: "account-1", exitCode: 9, signal: null });

    expect(crashes).toEqual([expect.objectContaining({ accountId: "account-1" })]);
    expect(taskEvents).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        type: "RECOVERY_REQUIRED",
        payload: { reason: "Codex App Server exited; recovery is required." },
      }),
    ]);
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
    resumeThread: vi.fn(async () => ({ thread: { id: threadId } })),
    startTurn: vi.fn(async () => ({ turn: { id: turnId } })),
    steerTurn: vi.fn(async () => undefined),
    interruptTurn: vi.fn(async () => undefined),
    startChatGptLogin: vi.fn(async () => ({
      loginId: "login-1",
      authUrl: "https://auth.example.test/codex",
    })),
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
