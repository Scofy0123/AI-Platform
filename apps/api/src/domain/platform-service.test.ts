import { EventEmitter } from "node:events";
import { TaskDetailSchema, TaskSummarySchema } from "@codexplatform/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type PlatformDatabase } from "../infra/db/database.js";
import { migrateDatabase } from "../infra/db/migrate.js";
import { AccountAdminStore } from "./account-admin-store.js";
import { SQLiteLeaseStore } from "./lease-store.js";
import {
  type ApprovalDraft,
  ApprovalTransportUnavailableError,
  LocalPlatformService,
  type RuntimeSafetyPort,
  type TaskEventDraft,
  type TaskExecutionAdapter,
} from "./platform-service.js";
import { SQLitePlatformStore } from "./platform-store.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");

describe("LocalPlatformService", () => {
  let database: PlatformDatabase;
  let store: SQLitePlatformStore;
  let leases: SQLiteLeaseStore;
  let accounts: AccountAdminStore;
  let execution: FakeExecution;
  let gate: RuntimeSafetyPort;
  let service: LocalPlatformService;

  beforeEach(() => {
    database = createDatabase(":memory:");
    migrateDatabase(database.sqlite);
    seedUser(database, "user-1", "ADMIN");
    seedUser(database, "user-2", "MEMBER");
    store = new SQLitePlatformStore(database.sqlite);
    leases = new SQLiteLeaseStore(database.sqlite);
    accounts = new AccountAdminStore(database.sqlite);
    leases.addAccount({
      id: "account-1",
      alias: "Codex A",
      codexHome: "/tmp/codexplatform-test/account-1",
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
      maxActiveUsers: 4,
      weeklyRemaining: 80,
      quotaUpdatedAt: NOW,
      allowUnknownQuota: false,
      healthScore: 100,
    });
    execution = new FakeExecution();
    gate = { authorize: vi.fn(() => ({ allowed: true, mode: "SIMULATED_MULTI_USER" })) };
    service = new LocalPlatformService({
      store,
      leases,
      accounts,
      execution,
      safety: gate,
      dataDir: "/tmp/codexplatform-test",
      now: () => NOW,
    });
  });

  afterEach(async () => {
    await service.close();
    database.sqlite.close();
  });

  test("acquires a lease, starts the real adapter boundary and persists streamed events", async () => {
    const project = await service.createProject("user-1", { name: "Platform" });
    const task = await service.createTask("user-1", {
      projectId: project.id,
      title: "Build it",
    });
    const streamed: unknown[] = [];
    const unsubscribe = service.subscribeTaskEvents(task.id, (event) => streamed.push(event));

    await expect(
      service.startTurn(task.id, "user-1", "Implement the scheduler"),
    ).resolves.toMatchObject({
      status: "RUNNING",
      accountAlias: "Codex A",
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
    });
    expect(execution.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-1",
        userId: "user-1",
        taskId: task.id,
        prompt: "Implement the scheduler",
      }),
    );

    execution.emitTaskEvent({
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      type: "AGENT_MESSAGE_DELTA",
      payload: { itemId: "item-1", delta: "Working" },
    });
    expect(await service.listTaskEvents(task.id, "user-1", 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "LEASE_ACQUIRED" }),
        expect.objectContaining({ type: "AGENT_MESSAGE_DELTA" }),
      ]),
    );
    expect(streamed).toHaveLength(2);
    unsubscribe();
  });

  test("returns strict public task DTOs with the latest prompt and live queue state", async () => {
    const project = await service.createProject("user-1", { name: "Public DTO" });
    const tasks = await Promise.all(
      ["First", "Second", "Queued"].map((title) =>
        service.createTask("user-1", { projectId: project.id, title }),
      ),
    );
    await service.startTurn(tasks[0]?.id ?? "missing", "user-1", "First prompt");
    await service.startTurn(tasks[1]?.id ?? "missing", "user-1", "Second prompt");
    await service.startTurn(tasks[2]?.id ?? "missing", "user-1", "Queued prompt");

    const summaries = await service.listTasks("user-1");
    const detail = await service.getTask(tasks[2]?.id ?? "missing", "user-1");

    expect(summaries.map((summary) => TaskSummarySchema.parse(summary))).toHaveLength(3);
    expect(Object.keys(summaries[0] ?? {}).sort()).toEqual(
      ["id", "projectId", "status", "title", "updatedAt"].sort(),
    );
    expect(TaskDetailSchema.parse(detail)).toMatchObject({
      id: tasks[2]?.id,
      prompt: "Queued prompt",
      accountAlias: null,
      queue: { position: 1, etaMs: 600_000, etaEstimated: true },
    });
    expect(JSON.stringify(detail)).not.toMatch(
      /ownerId|leaseId|currentTurnId|threadId|queueTicket/,
    );
  });

  test("rejects a second active Turn for the same task before taking another slot", async () => {
    const project = await service.createProject("user-1", { name: "One active Turn" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "First prompt");

    await expect(service.startTurn(task.id, "user-1", "Second prompt")).rejects.toThrow(
      "Task already has an active Turn",
    );
    expect(execution.startTask).toHaveBeenCalledTimes(1);
    expect(accounts.list()[0]).toMatchObject({ activeUsers: 1, activeTurns: 1 });
  });

  test("fails closed before leasing when the runtime safety gate rejects a second user", async () => {
    gate.authorize = vi.fn(() => ({
      allowed: false,
      mode: "SINGLE_OPERATOR",
      reason: "Credential isolation probe failed",
    }));
    const project = await service.createProject("user-2", { name: "Member" });
    const task = await service.createTask("user-2", { projectId: project.id, title: "Blocked" });

    await expect(service.startTurn(task.id, "user-2", "Run it")).rejects.toThrow(
      "Credential isolation probe failed",
    );
    expect(accounts.list()[0]).toMatchObject({ activeUsers: 0, activeTurns: 0 });
    expect(execution.startTask).not.toHaveBeenCalled();
  });

  test("publishes the platform approval UUID and delivers the exact transport identity", async () => {
    const project = await service.createProject("user-1", { name: "Platform" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Approval" });
    await service.startTurn(task.id, "user-1", "Change a file");
    const streamed: unknown[] = [];
    service.subscribeTaskEvents(task.id, (event) => streamed.push(event));
    execution.emitApproval({
      requestId: "7",
      rawRpcId: 7,
      accountId: "account-1",
      connectionGeneration: 3,
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      itemId: "item-7",
      approvalType: "FILE_CHANGE",
      payload: { reason: "write" },
    });
    const approvals = (await service.listApprovals(task.id, "user-1")) as Array<{
      id: string;
      status: string;
    }>;
    const approvalId = approvals[0]?.id ?? "missing";

    expect(approvalId).not.toBe("7");
    expect(streamed).toEqual([
      expect.objectContaining({
        type: "APPROVAL_REQUESTED",
        payload: expect.objectContaining({ approvalId }),
      }),
    ]);

    await service.decideApproval(approvalId, "user-1", "accept");

    expect(execution.respondApproval).toHaveBeenCalledWith("7", "accept", {
      approvalType: "FILE_CHANGE",
      transport: {
        accountId: "account-1",
        connectionGeneration: 3,
        rawRpcId: 7,
        requestId: "7",
        threadId: `thread-${task.id}`,
        turnId: `codex-turn-${task.id}`,
      },
    });
    expect(await service.listApprovals(task.id, "user-1")).toEqual([
      expect.objectContaining({ id: approvalId, status: "DELIVERED", decision: "accept" }),
    ]);
    expect(await service.listTaskEvents(task.id, "user-1", 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "APPROVAL_DECIDED",
          payload: expect.objectContaining({ approvalId, decision: "accept" }),
        }),
      ]),
    );
  });

  test("projects command approval details into the requested event", async () => {
    const project = await service.createProject("user-1", { name: "Command approval" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Approval" });
    await service.startTurn(task.id, "user-1", "Run the tests");
    const streamed: TaskEventDraft[] = [];
    service.subscribeTaskEvents(task.id, (event) => streamed.push(event));

    execution.emitApproval({
      requestId: "command-7",
      rawRpcId: "command-7",
      accountId: "account-1",
      connectionGeneration: 3,
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      itemId: "command-item-7",
      approvalType: "COMMAND",
      payload: { reason: "run tests", command: "pnpm test", cwd: "/repo" },
    });

    expect(streamed).toEqual([
      expect.objectContaining({
        type: "APPROVAL_REQUESTED",
        payload: expect.objectContaining({
          approvalType: "COMMAND",
          command: "pnpm test",
          cwd: "/repo",
        }),
      }),
    ]);
  });

  test("does not mark an approval delivered before the response write is acknowledged", async () => {
    const project = await service.createProject("user-1", { name: "Delayed approval" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Approval" });
    await service.startTurn(task.id, "user-1", "Change a file");
    execution.emitApproval({
      requestId: "7",
      rawRpcId: 7,
      accountId: "account-1",
      connectionGeneration: 1,
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      itemId: "item-7",
      approvalType: "FILE_CHANGE",
      payload: { reason: "write" },
    });
    const approvals = (await service.listApprovals(task.id, "user-1")) as Array<{ id: string }>;
    const approvalId = approvals[0]?.id ?? "missing";
    const acknowledgement = deferred<void>();
    execution.respondApproval.mockReturnValueOnce(acknowledgement.promise);

    const decision = service.decideApproval(approvalId, "user-1", "accept");
    await nextTick();

    expect(await service.listApprovals(task.id, "user-1")).toEqual([
      expect.objectContaining({ status: "DELIVERY_PENDING", decision: "accept" }),
    ]);
    expect(await service.listTaskEvents(task.id, "user-1", 0)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "APPROVAL_DECIDED" })]),
    );

    acknowledgement.resolve();
    await expect(decision).resolves.toMatchObject({ status: "DELIVERED", decision: "accept" });
  });

  test("returns a failed delivery to PENDING so the same decision can be retried", async () => {
    const project = await service.createProject("user-1", { name: "Retry approval" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Approval" });
    await service.startTurn(task.id, "user-1", "Change a file");
    execution.emitApproval({
      requestId: "7",
      rawRpcId: 7,
      accountId: "account-1",
      connectionGeneration: 1,
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      itemId: "item-7",
      approvalType: "FILE_CHANGE",
      payload: { reason: "write" },
    });
    const approvals = (await service.listApprovals(task.id, "user-1")) as Array<{ id: string }>;
    const approvalId = approvals[0]?.id ?? "missing";
    execution.respondApproval.mockRejectedValueOnce(new Error("transport write failed"));

    await expect(service.decideApproval(approvalId, "user-1", "accept")).rejects.toThrow(
      "transport write failed",
    );
    expect(await service.listApprovals(task.id, "user-1")).toEqual([
      expect.objectContaining({ status: "PENDING", decision: null }),
    ]);

    await expect(service.decideApproval(approvalId, "user-1", "accept")).resolves.toMatchObject({
      status: "DELIVERED",
      decision: "accept",
    });
    await expect(service.decideApproval(approvalId, "user-1", "accept")).resolves.toMatchObject({
      status: "DELIVERED",
      decision: "accept",
    });
    await expect(service.decideApproval(approvalId, "user-1", "decline")).rejects.toThrow(
      "different decision",
    );
    expect(execution.respondApproval).toHaveBeenCalledTimes(2);
  });

  test("marks a detached approval as RECOVERY_REQUIRED instead of pretending it was delivered", async () => {
    const project = await service.createProject("user-1", { name: "Detached approval" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Approval" });
    await service.startTurn(task.id, "user-1", "Change a file");
    execution.emitApproval({
      requestId: "7",
      rawRpcId: 7,
      accountId: "account-1",
      connectionGeneration: 1,
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      itemId: "item-7",
      approvalType: "FILE_CHANGE",
      payload: { reason: "write" },
    });
    const approvals = (await service.listApprovals(task.id, "user-1")) as Array<{ id: string }>;
    const approvalId = approvals[0]?.id ?? "missing";
    execution.respondApproval.mockRejectedValueOnce(new ApprovalTransportUnavailableError());

    await expect(service.decideApproval(approvalId, "user-1", "accept")).rejects.toThrow(
      "not attached",
    );
    expect(await service.listApprovals(task.id, "user-1")).toEqual([
      expect.objectContaining({ status: "RECOVERY_REQUIRED", decision: "accept" }),
    ]);
    await expect(service.decideApproval(approvalId, "user-1", "accept")).rejects.toThrow(
      "requires recovery",
    );
    expect(execution.respondApproval).toHaveBeenCalledTimes(1);
  });

  test("starts the FIFO head automatically when a running turn releases capacity", async () => {
    const tasks: Array<{ id: string }> = [];
    const project = await service.createProject("user-1", { name: "Concurrent turns" });
    for (let index = 1; index <= 3; index += 1) {
      tasks.push(
        await service.createTask("user-1", {
          projectId: project.id,
          title: `Task ${index}`,
        }),
      );
    }

    await service.startTurn(tasks[0]?.id ?? "missing", "user-1", "Prompt 1");
    await service.startTurn(tasks[1]?.id ?? "missing", "user-1", "Prompt 2");
    const queued = await service.startTurn(tasks[2]?.id ?? "missing", "user-1", "Prompt 3");
    expect(queued).toMatchObject({ status: "QUEUED", position: 1 });

    execution.emitTaskEvent({
      taskId: tasks[0]?.id ?? "missing",
      threadId: `thread-${tasks[0]?.id}`,
      turnId: `codex-turn-${tasks[0]?.id}`,
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });
    await vi.waitFor(() => {
      expect(execution.startTask).toHaveBeenCalledTimes(3);
    });
    expect(execution.startTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        taskId: tasks[2]?.id,
        userId: "user-1",
        prompt: "Prompt 3",
      }),
    );
    expect(leases.getQueue()).toEqual([]);
  });

  test("never returns the private CODEX_HOME from account administration", async () => {
    const added = await service.addAccount({ alias: "Codex B" }, "user-1");
    const restored = await service.setAccountState("account-1", "AVAILABLE", "user-1");

    expect(JSON.stringify(added)).not.toContain("codexHome");
    expect(JSON.stringify(restored)).not.toContain("codexHome");
    expect(JSON.stringify(added)).not.toContain("/tmp/codexplatform-test");
  });

  test("attributes account lifecycle actions to the Feishu administrator", async () => {
    const added = await service.addAccount({ alias: "Codex B" }, "user-1");
    const accountId = added?.id ?? "missing";
    await service.loginAccount("account-1", "user-1");
    await service.setAccountState("account-1", "DRAINING", "user-1");
    execution.startAccountLogin.mockRejectedValueOnce(
      new Error("Bearer secret_login_failure_must_not_reach_audit"),
    );

    await expect(service.loginAccount(accountId, "user-1")).rejects.toThrow("secret_login");

    const audit = (await service.listAudit()) as Array<{
      actorUserId: string;
      action: string;
      outcome: string;
      summary: string;
    }>;
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: "user-1",
          action: "ACCOUNT_ADDED",
          outcome: "SUCCESS",
        }),
        expect.objectContaining({
          actorUserId: "user-1",
          action: "ACCOUNT_LOGIN_STARTED",
          outcome: "SUCCESS",
        }),
        expect.objectContaining({
          actorUserId: "user-1",
          action: "ACCOUNT_LOGIN_STARTED",
          outcome: "FAILED",
        }),
        expect.objectContaining({
          actorUserId: "user-1",
          action: "ACCOUNT_STATE_CHANGED",
          outcome: "SUCCESS",
        }),
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain("secret_login_failure_must_not_reach_audit");
  });

  test("releases an idle account-user slot after 30 minutes and starts the fifth user", async () => {
    for (let index = 3; index <= 5; index += 1) seedUser(database, `user-${index}`, "MEMBER");
    const tasks: Array<{ id: string }> = [];
    for (let index = 1; index <= 5; index += 1) {
      const project = await service.createProject(`user-${index}`, { name: `Project ${index}` });
      tasks.push(
        await service.createTask(`user-${index}`, {
          projectId: project.id,
          title: `Task ${index}`,
        }),
      );
    }
    for (let index = 0; index < 4; index += 1) {
      await service.startTurn(
        tasks[index]?.id ?? "missing",
        `user-${index + 1}`,
        `Prompt ${index + 1}`,
      );
    }
    await service.startTurn(tasks[4]?.id ?? "missing", "user-5", "Prompt 5");
    execution.emitTaskEvent({
      taskId: tasks[0]?.id ?? "missing",
      threadId: `thread-${tasks[0]?.id}`,
      turnId: `codex-turn-${tasks[0]?.id}`,
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });
    expect(execution.startTask).toHaveBeenCalledTimes(4);

    const maintenanceAt = new Date(NOW.getTime() + 31 * 60_000);
    accounts.updateWeeklyQuota("account-1", {
      remainingPercent: 80,
      resetsAt: null,
      observedAt: maintenanceAt,
    });
    await service.runMaintenance(maintenanceAt);

    await vi.waitFor(() => expect(execution.startTask).toHaveBeenCalledTimes(5));
    expect(execution.startTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskId: tasks[4]?.id, userId: "user-5", prompt: "Prompt 5" }),
    );
  });

  test("marks stale runtime turns for explicit recovery without replaying side effects", async () => {
    const project = await service.createProject("user-1", { name: "Recovery" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Long turn" });
    await service.startTurn(task.id, "user-1", "Perform one external write");

    const recovered = service.recoverStaleTurns(new Date(NOW.getTime() + 46_000));

    expect(recovered).toBe(1);
    expect(execution.startTask).toHaveBeenCalledTimes(1);
    expect(await service.getTask(task.id, "user-1")).toMatchObject({ status: "NEEDS_RECOVERY" });
    expect(await service.listTaskEvents(task.id, "user-1", 0)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "RECOVERY_REQUIRED" })]),
    );

    await service.startTurn(task.id, "user-1", "Continue from the safe Turn boundary");
    expect(execution.startTask).toHaveBeenCalledTimes(2);
    expect(accounts.list()[0]).toMatchObject({ activeUsers: 1, activeTurns: 1 });
  });

  test.each([
    ["TURN_COMPLETED", { status: "completed", durationMs: 10 }, "COMPLETED"],
    ["TURN_FAILED", { status: "failed", error: "Model execution failed" }, "FAILED"],
    ["TURN_INTERRUPTED", { status: "interrupted" }, "INTERRUPTED"],
  ] as const)(
    "maps %s to the explicit terminal task and Turn state",
    async (type, payload, status) => {
      const project = await service.createProject("user-1", { name: type });
      const task = await service.createTask("user-1", { projectId: project.id, title: type });
      await service.startTurn(task.id, "user-1", "Run once");

      execution.emitTaskEvent({
        taskId: task.id,
        threadId: `thread-${task.id}`,
        turnId: `codex-turn-${task.id}`,
        type,
        payload,
      } as TaskEventDraft);

      expect(await service.getTask(task.id, "user-1")).toMatchObject({ status });
      expect(
        database.sqlite
          .prepare("SELECT status, current_turn_id, queue_ticket FROM tasks WHERE id = ?")
          .get(task.id),
      ).toEqual({ status, current_turn_id: null, queue_ticket: null });
      expect(
        database.sqlite.prepare("SELECT status FROM turns WHERE task_id = ?").get(task.id),
      ).toEqual({ status });
      expect(accounts.list()[0]).toMatchObject({ activeTurns: 0 });
    },
  );

  test("maps a runtime recovery event to NEEDS_RECOVERY without treating it as completed", async () => {
    const project = await service.createProject("user-1", { name: "Runtime recovery" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Run once");

    execution.emitTaskEvent({
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      type: "RECOVERY_REQUIRED",
      payload: { reason: "Runtime detached" },
    });

    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(
      database.sqlite
        .prepare("SELECT current_turn_id, queue_ticket FROM tasks WHERE id = ?")
        .get(task.id),
    ).toEqual({ current_turn_id: null, queue_ticket: null });
  });

  test.each([
    ["TURN_FAILED", { status: "failed", error: "Delayed old failure" }],
    ["RECOVERY_REQUIRED", { reason: "Delayed old recovery" }],
  ] as const)("does not let a delayed old %s clear the new active Turn", async (type, payload) => {
    const project = await service.createProject("user-1", { name: "Delayed terminal" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    execution.startTask
      .mockResolvedValueOnce({ threadId: "thread-1", turnId: "codex-turn-old" })
      .mockResolvedValueOnce({ threadId: "thread-1", turnId: "codex-turn-new" });
    await service.startTurn(task.id, "user-1", "First Turn");
    execution.emitTaskEvent({
      taskId: task.id,
      threadId: "thread-1",
      turnId: "codex-turn-old",
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });
    await service.startTurn(task.id, "user-1", "Second Turn");

    execution.emitTaskEvent({
      taskId: task.id,
      threadId: "thread-1",
      turnId: "codex-turn-old",
      type,
      payload,
    } as TaskEventDraft);

    expect(await service.getTask(task.id, "user-1")).toMatchObject({ status: "RUNNING" });
    expect(
      database.sqlite
        .prepare("SELECT status, current_turn_id FROM tasks WHERE id = ?")
        .get(task.id),
    ).toEqual({ status: "RUNNING", current_turn_id: "codex-turn-new" });
    expect(accounts.list()[0]).toMatchObject({ activeTurns: 1 });
  });

  test("closes old Turn approvals before a resumed Turn can run", async () => {
    const project = await service.createProject("user-1", { name: "Approval cancellation" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    execution.startTask
      .mockResolvedValueOnce({ threadId: "thread-1", turnId: "codex-turn-old" })
      .mockResolvedValueOnce({ threadId: "thread-1", turnId: "codex-turn-new" });
    await service.startTurn(task.id, "user-1", "First Turn");
    execution.emitApproval({
      requestId: "17",
      rawRpcId: 17,
      accountId: "account-1",
      connectionGeneration: 1,
      taskId: task.id,
      threadId: "thread-1",
      turnId: "codex-turn-old",
      itemId: "item-17",
      approvalType: "COMMAND",
      payload: { command: "pnpm test" },
    });
    const approvals = (await service.listApprovals(task.id, "user-1")) as Array<{ id: string }>;
    const approvalId = approvals[0]?.id ?? "missing";
    execution.emitTaskEvent({
      taskId: task.id,
      threadId: "thread-1",
      turnId: "codex-turn-old",
      type: "TURN_INTERRUPTED",
      payload: { status: "interrupted" },
    });
    await service.startTurn(task.id, "user-1", "Second Turn");

    expect(await service.listApprovals(task.id, "user-1")).toEqual([
      expect.objectContaining({ id: approvalId, status: "RECOVERY_REQUIRED" }),
    ]);
    await expect(service.decideApproval(approvalId, "user-1", "accept")).rejects.toThrow(
      "requires recovery",
    );
    expect(execution.respondApproval).not.toHaveBeenCalled();
    expect(await service.getTask(task.id, "user-1")).toMatchObject({ status: "RUNNING" });
  });

  test("marks an approval arriving after its Turn terminal as recovery-only", async () => {
    const project = await service.createProject("user-1", { name: "Late approval" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Run once");
    execution.emitTaskEvent({
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      type: "TURN_COMPLETED",
      payload: { status: "completed" },
    });
    execution.emitApproval({
      requestId: "late-approval",
      rawRpcId: 92,
      accountId: "account-1",
      connectionGeneration: 1,
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      itemId: "command-late",
      approvalType: "COMMAND",
      payload: { command: "pnpm publish" },
    });

    const approvals = (await service.listApprovals(task.id, "user-1")) as Array<{
      id: string;
      status: string;
    }>;
    expect(approvals).toEqual([
      expect.objectContaining({ requestId: "late-approval", status: "RECOVERY_REQUIRED" }),
    ]);
    await expect(
      service.decideApproval(approvals[0]?.id ?? "missing", "user-1", "accept"),
    ).rejects.toThrow("requires recovery");
    expect(await service.getTask(task.id, "user-1")).toMatchObject({ status: "COMPLETED" });
  });

  test("immediately recovers all persisted running Turns after a process restart", async () => {
    const project = await service.createProject("user-1", { name: "Restart recovery" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Run once");

    expect(service.recoverInterruptedTurns()).toBe(1);
    expect(service.recoverInterruptedTurns()).toBe(0);
    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(
      database.sqlite.prepare("SELECT status FROM turns WHERE task_id = ?").get(task.id),
    ).toEqual({ status: "NEEDS_RECOVERY" });
    expect(
      (await service.listTaskEvents(task.id, "user-1", 0))?.filter(
        (event) => event.type === "RECOVERY_REQUIRED",
      ),
    ).toHaveLength(1);
    expect(accounts.list()[0]).toMatchObject({ activeTurns: 0 });
  });

  test("recovers an orphaned ALLOCATING Turn left before lease acquisition", async () => {
    const project = await service.createProject("user-1", { name: "Allocating recovery" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    store.createTurn({
      id: "orphaned-scheduler-turn",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Start but crash before leasing",
      status: "ALLOCATING",
      now: NOW,
    });

    expect(service.recoverInterruptedTurns()).toBe(1);
    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(store.getTurn("orphaned-scheduler-turn")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(
      (await service.listTaskEvents(task.id, "user-1", 0))?.filter(
        (event) => event.type === "RECOVERY_REQUIRED",
      ),
    ).toHaveLength(1);
  });

  test("cancels an orphaned ALLOCATING Turn that already entered the waiting queue", async () => {
    leases.updateAccount("account-1", { status: "DRAINING" });
    const project = await service.createProject("user-1", { name: "Queued allocation recovery" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    store.createTurn({
      id: "queued-orphan-turn",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Crash after enqueue",
      status: "ALLOCATING",
      now: NOW,
    });
    expect(
      leases.acquireTurn({
        userId: "user-1",
        taskId: task.id,
        turnId: "queued-orphan-turn",
        now: NOW,
      }),
    ).toMatchObject({ kind: "QUEUED" });

    expect(service.recoverInterruptedTurns()).toBe(1);
    expect(leases.getQueue()).toEqual([]);
    expect(store.getTurn("queued-orphan-turn")).toMatchObject({ status: "NEEDS_RECOVERY" });
    expect(execution.startTask).not.toHaveBeenCalled();
  });

  test("releases a NEEDS_RECOVERY slot left by an interrupted reconciliation", async () => {
    const project = await service.createProject("user-1", { name: "Restart idempotency" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Run once");
    const schedulerTurn = database.sqlite
      .prepare("SELECT id FROM turns WHERE task_id = ?")
      .get(task.id) as { id: string };

    expect(leases.markAllRunningTurnsForRecovery()).toEqual([schedulerTurn.id]);
    store.setTurnStatus(schedulerTurn.id, "NEEDS_RECOVERY");
    store.setTaskInactive(task.id, "NEEDS_RECOVERY", NOW);

    expect(service.recoverInterruptedTurns()).toBe(1);
    expect(accounts.list()[0]).toMatchObject({ activeTurns: 0 });
    expect(service.recoverInterruptedTurns()).toBe(0);
  });

  test("cancels a NEEDS_RECOVERY queue entry left by an interrupted reconciliation", async () => {
    leases.updateAccount("account-1", { status: "DRAINING" });
    const project = await service.createProject("user-1", { name: "Queued restart idempotency" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    store.createTurn({
      id: "partly-recovered-queued-turn",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Crash while reconciling",
      status: "ALLOCATING",
      now: NOW,
    });
    expect(
      leases.acquireTurn({
        userId: "user-1",
        taskId: task.id,
        turnId: "partly-recovered-queued-turn",
        now: NOW,
      }),
    ).toMatchObject({ kind: "QUEUED" });
    store.setTurnStatus("partly-recovered-queued-turn", "NEEDS_RECOVERY");
    store.setTaskInactive(task.id, "NEEDS_RECOVERY", NOW);

    expect(service.recoverInterruptedTurns()).toBe(1);
    expect(leases.getQueue()).toEqual([]);
    expect(service.recoverInterruptedTurns()).toBe(0);
  });

  test("reconciles a terminal event emitted before startTask resolves", async () => {
    const project = await service.createProject("user-1", { name: "Early terminal" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    execution.startTask.mockImplementationOnce(async () => {
      execution.emitTaskEvent({
        taskId: task.id,
        threadId: `thread-${task.id}`,
        turnId: `codex-turn-${task.id}`,
        type: "TURN_COMPLETED",
        payload: { status: "completed" },
      });
      return {
        threadId: `thread-${task.id}`,
        turnId: `codex-turn-${task.id}`,
      };
    });

    await expect(service.startTurn(task.id, "user-1", "Finish immediately")).resolves.toMatchObject(
      {
        status: "COMPLETED",
      },
    );
    expect(await service.getTask(task.id, "user-1")).toMatchObject({ status: "COMPLETED" });
    expect(
      database.sqlite.prepare("SELECT status FROM turns WHERE task_id = ?").get(task.id),
    ).toEqual({
      status: "COMPLETED",
    });
    expect(accounts.list()[0]).toMatchObject({ activeTurns: 0 });
    expect(
      (await service.listTaskEvents(task.id, "user-1", 0))?.map((event) => event.type),
    ).toEqual(["LEASE_ACQUIRED", "TURN_COMPLETED"]);
  });

  test("reconciles an approval emitted before startTask resolves", async () => {
    const project = await service.createProject("user-1", { name: "Early approval" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    execution.startTask.mockImplementationOnce(async () => {
      execution.emitApproval({
        requestId: "early-approval",
        rawRpcId: 91,
        accountId: "account-1",
        connectionGeneration: 1,
        taskId: task.id,
        threadId: `thread-${task.id}`,
        turnId: `codex-turn-${task.id}`,
        itemId: "command-early",
        approvalType: "COMMAND",
        payload: { command: "pnpm test" },
      });
      return {
        threadId: `thread-${task.id}`,
        turnId: `codex-turn-${task.id}`,
      };
    });

    await service.startTurn(task.id, "user-1", "Ask before running");
    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "WAITING_APPROVAL",
    });
    expect(await service.listApprovals(task.id, "user-1")).toEqual([
      expect.objectContaining({ requestId: "early-approval", status: "PENDING" }),
    ]);
    expect(
      (await service.listTaskEvents(task.id, "user-1", 0))?.map((event) => event.type),
    ).toEqual(["LEASE_ACQUIRED", "APPROVAL_REQUESTED"]);
  });

  test("moves a directly started Turn to recovery and releases its slot when startup fails", async () => {
    execution.startTask.mockRejectedValueOnce(new Error("Codex process did not start"));
    const project = await service.createProject("user-1", { name: "Direct startup failure" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });

    await expect(service.startTurn(task.id, "user-1", "Run once")).rejects.toThrow(
      "Codex process did not start",
    );

    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(accounts.list()[0]).toMatchObject({ activeTurns: 0 });
    expect(
      database.sqlite.prepare("SELECT status FROM turns WHERE task_id = ?").get(task.id),
    ).toEqual({ status: "NEEDS_RECOVERY" });
    expect(
      (await service.listTaskEvents(task.id, "user-1", 0))?.filter(
        (event) => event.type === "RECOVERY_REQUIRED",
      ),
    ).toHaveLength(1);
    expect(await service.listTaskEvents(task.id, "user-1", 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "RECOVERY_REQUIRED",
          payload: {
            reason: "Codex Turn could not be started; explicit recovery is required.",
          },
        }),
      ]),
    );
  });

  test("moves a promoted Turn to recovery exactly once when startup fails", async () => {
    const project = await service.createProject("user-1", { name: "Promoted startup failure" });
    const tasks = await Promise.all(
      ["First", "Second", "Promoted"].map((title) =>
        service.createTask("user-1", { projectId: project.id, title }),
      ),
    );
    await service.startTurn(tasks[0]?.id ?? "missing", "user-1", "First prompt");
    await service.startTurn(tasks[1]?.id ?? "missing", "user-1", "Second prompt");
    await service.startTurn(tasks[2]?.id ?? "missing", "user-1", "Promoted prompt");
    execution.startTask.mockRejectedValueOnce(new Error("Promoted process did not start"));

    execution.emitTaskEvent({
      taskId: tasks[0]?.id ?? "missing",
      threadId: `thread-${tasks[0]?.id}`,
      turnId: `codex-turn-${tasks[0]?.id}`,
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });

    await vi.waitFor(async () => {
      expect(await service.getTask(tasks[2]?.id ?? "missing", "user-1")).toMatchObject({
        status: "NEEDS_RECOVERY",
      });
    });
    expect(accounts.list()[0]).toMatchObject({ activeTurns: 1 });
    expect(
      (await service.listTaskEvents(tasks[2]?.id ?? "missing", "user-1", 0))?.filter(
        (event) => event.type === "RECOVERY_REQUIRED",
      ),
    ).toHaveLength(1);
  });

  test("treats a Codex worker crash as recovery rather than an ordinary failure", async () => {
    const project = await service.createProject("user-1", { name: "Worker crash" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Run once");

    execution.emit("accountCrashed", { accountId: "account-1" });
    execution.emitTaskEvent({
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      type: "RECOVERY_REQUIRED",
      payload: { reason: "Codex App Server exited; recovery is required." },
    });

    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(accounts.list()[0]).toMatchObject({ status: "QUARANTINED", activeTurns: 0 });
    expect(
      (await service.listTaskEvents(task.id, "user-1", 0))?.filter(
        (event) => event.type === "RECOVERY_REQUIRED",
      ),
    ).toHaveLength(1);
  });

  test("quarantines a crashed Codex account before another task can be assigned", async () => {
    execution.emit("accountCrashed", { accountId: "account-1" });

    expect(accounts.list()[0]).toMatchObject({ status: "QUARANTINED" });
  });
});

class FakeExecution extends EventEmitter implements TaskExecutionAdapter {
  readonly startTask = vi.fn(async (input: { taskId: string }) => ({
    threadId: `thread-${input.taskId}`,
    turnId: `codex-turn-${input.taskId}`,
  }));
  readonly steerTask = vi.fn(async () => undefined);
  readonly interruptTask = vi.fn(async () => undefined);
  readonly respondApproval = vi.fn(async (): Promise<void> => undefined);
  readonly startAccountLogin = vi.fn(async () => ({
    loginId: "login-1",
    authUrl: "https://auth.example.test/codex",
  }));
  readonly refreshWeeklyQuota = vi.fn(async () => ({ status: "WEEKLY_QUOTA_UNKNOWN" as const }));

  emitTaskEvent(event: TaskEventDraft): void {
    this.emit("taskEvent", event);
  }

  emitApproval(approval: ApprovalDraft): void {
    this.emit("approval", approval);
  }

  async close(): Promise<void> {}
}

function seedUser(database: PlatformDatabase, id: string, role: "ADMIN" | "MEMBER"): void {
  database.sqlite
    .prepare(
      `INSERT INTO users (
        id, tenant_key, open_id, name, role, created_at, updated_at
       ) VALUES (?, 'tenant-1', ?, ?, ?, ?, ?)`,
    )
    .run(id, `ou_${id}`, id, role, NOW.getTime(), NOW.getTime());
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
