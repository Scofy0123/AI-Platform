import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type PlatformDatabase } from "../infra/db/database.js";
import { migrateDatabase } from "../infra/db/migrate.js";
import { SQLitePlatformStore } from "./platform-store.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");

describe("SQLitePlatformStore", () => {
  let database: PlatformDatabase;
  let store: SQLitePlatformStore;

  beforeEach(() => {
    database = createDatabase(":memory:");
    migrateDatabase(database.sqlite);
    seedUser(database, "user-1", "ou_1", "ADMIN");
    seedUser(database, "user-2", "ou_2", "MEMBER");
    store = new SQLitePlatformStore(database.sqlite);
  });

  afterEach(() => database.sqlite.close());

  test("keeps projects and tasks private to their Feishu owner", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Build scheduler",
      now: NOW,
    });

    expect(project).toMatchObject({ taskCount: 0 });
    expect(store.listProjects("user-1")).toEqual([
      expect.objectContaining({ id: project.id, taskCount: 1 }),
    ]);
    expect(store.getTaskForUser(task.id, "user-1")).toMatchObject({ title: "Build scheduler" });
    expect(store.listProjects("user-2")).toEqual([]);
    expect(store.getTaskForUser(task.id, "user-2")).toBeNull();
  });

  test("appends monotonically sequenced events and replays from Last-Event-ID", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Stream events",
      now: NOW,
    });

    store.appendTaskEvent({
      taskId: task.id,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "TURN_STARTED",
      payload: { status: "inProgress" },
      now: NOW,
    });
    store.appendTaskEvent({
      taskId: task.id,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "AGENT_MESSAGE_DELTA",
      payload: { itemId: "item-1", delta: "hello" },
      now: new Date(NOW.getTime() + 1),
    });

    expect(store.listTaskEvents(task.id, "user-1", 1)).toEqual([
      expect.objectContaining({ sequence: 2, type: "AGENT_MESSAGE_DELTA" }),
    ]);
    expect(store.listTaskEvents(task.id, "user-2", 0)).toBeNull();
  });

  test("persists queued turn prompts so FIFO promotion survives process memory loss", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Queued work",
      now: NOW,
    });

    store.createTurn({
      id: "scheduler-turn-1",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Run after the first task",
      status: "QUEUED",
      now: NOW,
    });

    expect(store.getTurn("scheduler-turn-1")).toMatchObject({
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Run after the first task",
      status: "QUEUED",
    });
    expect(() =>
      store.createTurn({
        id: "other-user-turn",
        taskId: task.id,
        ownerId: "user-2",
        prompt: "Steal work",
        status: "QUEUED",
        now: NOW,
      }),
    ).toThrow("Task not found");
  });

  test("atomically rejects a second active Turn for the same task", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "One active Turn",
      now: NOW,
    });
    store.createTurn({
      id: "scheduler-turn-1",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "First prompt",
      status: "ALLOCATING",
      now: NOW,
    });

    expect(() =>
      store.createTurn({
        id: "scheduler-turn-2",
        taskId: task.id,
        ownerId: "user-1",
        prompt: "Second prompt",
        status: "ALLOCATING",
        now: NOW,
      }),
    ).toThrow("Task already has an active Turn");
    expect(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM turns WHERE task_id = ?").get(task.id),
    ).toEqual({ count: 1 });
  });

  test("returns the latest persisted prompt after an earlier Turn is terminal", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Prompt history",
      now: NOW,
    });
    store.createTurn({
      id: "scheduler-turn-1",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "First prompt",
      status: "ALLOCATING",
      now: NOW,
    });
    store.completeTurn("scheduler-turn-1", "TURN_COMPLETED", new Date(NOW.getTime() + 1));
    store.createTurn({
      id: "scheduler-turn-2",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Second prompt",
      status: "QUEUED",
      now: new Date(NOW.getTime() + 2),
    });

    expect(store.getLatestTurnPrompt(task.id, "user-1")).toBe("Second prompt");
    expect(store.getLatestTurnPrompt(task.id, "user-2")).toBeNull();
  });

  test("persists approvals and audit linkage without exposing account internals", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Approve change",
      now: NOW,
    });
    store.bindTaskRuntime(task.id, {
      accountId: "account-1",
      accountAlias: "Codex A",
      leaseId: "lease-1",
      threadId: "thread-1",
      now: NOW,
    });
    const approval = store.createApproval({
      requestId: "request-1",
      rawRpcId: 7,
      accountId: "account-1",
      connectionGeneration: 2,
      threadId: "thread-1",
      taskId: task.id,
      turnId: "turn-1",
      itemId: "item-1",
      approvalType: "FILE_CHANGE",
      payload: { reason: "write file" },
      now: NOW,
    });
    const claim = store.claimApprovalDelivery({
      approvalId: approval.id,
      userId: "user-1",
      decision: "accept",
    });
    expect(claim).toMatchObject({
      kind: "CLAIMED",
      transport: {
        accountId: "account-1",
        connectionGeneration: 2,
        threadId: "thread-1",
        turnId: "turn-1",
        rawRpcId: 7,
      },
    });
    store.completeApprovalDelivery({
      approvalId: approval.id,
      userId: "user-1",
      decision: "accept",
      now: new Date(NOW.getTime() + 1),
    });

    expect(store.listApprovals(task.id, "user-1")).toEqual([
      expect.objectContaining({ status: "DELIVERED", decision: "accept" }),
    ]);
    expect(store.listAudit({ actorUserId: "user-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: "user-1",
          accountAlias: "Codex A",
          taskId: task.id,
          action: "APPROVAL_DECIDED",
        }),
      ]),
    );
    expect(JSON.stringify(store.listAudit({ actorUserId: "user-1" }))).not.toContain("codex_home");
  });

  test("records tool provenance and hashes payloads instead of storing sensitive arguments", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Read enterprise data",
      now: NOW,
    });
    store.bindTaskRuntime(task.id, {
      accountId: "account-1",
      accountAlias: "Codex A",
      leaseId: "lease-1",
      threadId: "thread-1",
      now: NOW,
    });

    store.recordToolInvocation({
      callId: "call-1",
      taskId: task.id,
      turnId: "turn-1",
      userId: "user-1",
      tool: "feishu_wiki_search",
      arguments: { query: "confidential-project-name" },
      response: { success: true, contentItems: [] },
      success: true,
      startedAt: NOW,
      completedAt: new Date(NOW.getTime() + 12),
    });

    const persisted = database.sqlite
      .prepare("SELECT * FROM tool_calls WHERE call_id = 'call-1'")
      .get();
    expect(persisted).toMatchObject({
      user_id: "user-1",
      tool: "feishu_wiki_search",
      status: "SUCCEEDED",
    });
    expect(JSON.stringify(persisted)).not.toContain("confidential-project-name");
    expect(store.listAudit({ actorUserId: "user-1" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "TOOL_INVOKED",
          accountAlias: "Codex A",
          toolCallId: expect.any(String),
        }),
      ]),
    );
  });
});

function seedUser(
  database: PlatformDatabase,
  id: string,
  openId: string,
  role: "ADMIN" | "MEMBER",
): void {
  database.sqlite
    .prepare(
      `INSERT INTO users (
        id, tenant_key, open_id, name, role, created_at, updated_at
       ) VALUES (?, 'tenant-1', ?, ?, ?, ?, ?)`,
    )
    .run(id, openId, id, role, NOW.getTime(), NOW.getTime());
}
