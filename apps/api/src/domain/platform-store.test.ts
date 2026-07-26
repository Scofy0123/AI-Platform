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
      expect.objectContaining({
        sequence: 2,
        type: "AGENT_MESSAGE_DELTA",
        itemId: "item-1",
      }),
    ]);
    expect(store.listTaskEvents(task.id, "user-2", 0)).toBeNull();
  });

  test("derives stable item boundaries for events without a protocol item id", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Plan boundaries",
      now: NOW,
    });

    const first = store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "PLAN_UPDATED",
      payload: { explanation: null, plan: [] },
      now: NOW,
    });
    const second = store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "PLAN_UPDATED",
      payload: { explanation: "next", plan: [] },
      now: new Date(NOW.getTime() + 1),
    });

    expect(first.itemId).toBe("plan:runtime-turn-1");
    expect(second.itemId).toBe(first.itemId);
  });

  test("fails closed on raw reasoning fields before event persistence", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Reason safely",
      now: NOW,
    });

    store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "REASONING_SUMMARY_DELTA",
      payload: {
        itemId: "reason-1",
        delta: "Inspect the code.",
        reasoningTextDelta: "raw secret",
        content: "raw content",
        encrypted_content: "ciphertext",
      } as never,
      now: NOW,
    });

    const events = store.listTaskEvents(task.id, "user-1", 0);
    expect(events).toEqual([
      expect.objectContaining({
        payload: { itemId: "reason-1", delta: "Inspect the code." },
      }),
    ]);
    const persisted = database.sqlite
      .prepare("SELECT payload_json FROM task_events WHERE task_id = ?")
      .get(task.id);
    expect(JSON.stringify(persisted)).not.toMatch(
      /raw secret|raw content|ciphertext|reasoningTextDelta|encrypted_content/,
    );
  });

  test("isolates personal settings by Feishu user and never stores shared account config", () => {
    const defaults = store.getUserSettings("user-1", NOW);
    const updated = store.patchUserSettings(
      "user-1",
      {
        general: { theme: "DARK" },
        personalization: { instructions: "Answer concisely." },
      },
      new Date(NOW.getTime() + 1),
    );

    expect(defaults).toMatchObject({
      general: { language: "zh-CN", theme: "SYSTEM" },
      execution: { permissionMode: "DEFAULT", approvalPreference: "ASK" },
    });
    expect(updated).toMatchObject({
      general: { theme: "DARK" },
      personalization: { instructions: "Answer concisely." },
    });
    expect(store.getUserSettings("user-2", NOW)).toMatchObject({
      general: { theme: "SYSTEM" },
      personalization: { instructions: "" },
    });
    const persisted = database.sqlite
      .prepare("SELECT settings_json FROM user_settings WHERE user_id = 'user-1'")
      .get();
    expect(JSON.stringify(persisted)).not.toMatch(/codexHome|accountAlias|rawToml|credential/i);
  });

  test("upserts observable subagent summaries and enforces parent ownership", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Delegate",
      now: NOW,
    });

    store.upsertSubagent({
      threadId: "agent-thread-1",
      parentTaskId: task.id,
      parentRuntimeThreadId: "runtime-thread-1",
      parentTurnId: "runtime-turn-1",
      ownerId: "user-1",
      sessionId: null,
      name: "Repository audit",
      role: "subagent",
      model: "gpt-5",
      effort: "HIGH",
      status: "ACTIVE",
      resultSummary: null,
      now: NOW,
    });
    store.upsertSubagent({
      threadId: "agent-thread-1",
      parentTaskId: task.id,
      parentRuntimeThreadId: "runtime-thread-1",
      parentTurnId: "runtime-turn-1",
      ownerId: "user-1",
      sessionId: null,
      name: "Repository audit",
      role: "subagent",
      model: "gpt-5",
      effort: "HIGH",
      status: "DONE",
      resultSummary: "No critical findings",
      now: new Date(NOW.getTime() + 20),
    });
    store.appendSubagentEvent({
      threadId: "agent-thread-1",
      turnId: "agent-turn-1",
      type: "AGENT_MESSAGE_DELTA",
      payload: { itemId: "child-message-1", delta: "Inspecting" },
      now: new Date(NOW.getTime() + 10),
    });

    expect(store.listSubagents(task.id, "user-1", new Date(NOW.getTime() + 30))).toEqual([
      expect.objectContaining({
        threadId: "agent-thread-1",
        parentThreadId: task.id,
        status: "DONE",
        resultSummary: "No critical findings",
      }),
    ]);
    expect(
      store.getSubagentDetail("agent-thread-1", "user-1", new Date(NOW.getTime() + 30)),
    ).toMatchObject({
      items: [
        {
          id: "child-message-1",
          threadId: "agent-thread-1",
          turnId: null,
          sequence: 1,
          type: "AGENT_MESSAGE_DELTA",
          timestamp: new Date(NOW.getTime() + 10).toISOString(),
          payload: { itemId: "child-message-1", delta: "Inspecting" },
        },
      ],
    });
    expect(store.getSubagentDetail("agent-thread-1", "user-2", NOW)).toBeNull();
    expect(store.listSubagents(task.id, "user-2", NOW)).toBeNull();
  });

  test("keeps a subagent owner and parent chain immutable and terminal status monotonic", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Agents", now: NOW });
    const firstTask = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "First parent",
      now: NOW,
    });
    const secondTask = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Second parent",
      now: NOW,
    });
    const base = {
      threadId: "agent-thread-stable",
      parentTaskId: firstTask.id,
      parentRuntimeThreadId: "runtime-parent-1",
      parentTurnId: null,
      ownerId: "user-1",
      sessionId: null,
      name: "Stable child",
      role: "subagent",
      model: null,
      effort: null,
      resultSummary: null,
      now: NOW,
    };
    store.upsertSubagent({ ...base, status: "DONE" });

    expect(() =>
      store.upsertSubagent({
        ...base,
        parentTaskId: secondTask.id,
        parentRuntimeThreadId: "runtime-parent-2",
        parentTurnId: "parent-turn-2",
        status: "ACTIVE",
      }),
    ).toThrow(/conflict/i);
    store.upsertSubagent({
      ...base,
      status: "ACTIVE",
      now: new Date(NOW.getTime() + 1),
    });
    expect(store.getSubagent("agent-thread-stable", "user-1", NOW)).toMatchObject({
      parentThreadId: firstTask.id,
      parentTurnId: null,
      status: "DONE",
    });
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

  test("recovers an account atomically and is idempotent after an interrupted transaction", () => {
    database.sqlite
      .prepare(
        `INSERT INTO codex_accounts (
          id, alias, codex_home, status, auth_status, weekly_remaining,
          quota_updated_at, allow_unknown_quota, created_at
        ) VALUES ('account-atomic', 'Atomic', '/tmp/atomic', 'AVAILABLE', 'AUTHENTICATED',
          80, ?, 0, ?)`,
      )
      .run(NOW.getTime(), NOW.getTime());
    const project = store.createProject({ ownerId: "user-1", name: "Recovery", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Recover me",
      now: NOW,
    });
    store.createTurn({
      id: "platform-turn-atomic",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Run",
      status: "ALLOCATING",
      now: NOW,
    });
    store.bindTurnRuntime("platform-turn-atomic", "runtime-turn-secret", NOW);
    store.bindTaskRuntime(task.id, {
      accountId: "account-atomic",
      accountAlias: "Atomic",
      leaseId: "lease-atomic",
      threadId: "runtime-thread-secret",
      now: NOW,
    });
    store.setCurrentTurn(task.id, "runtime-turn-secret", "RUNNING", NOW);
    database.sqlite
      .prepare(
        `INSERT INTO user_turn_slots (
          account_id, user_id, slot_index, task_id, turn_id, status, acquired_at, heartbeat_at
        ) VALUES ('account-atomic', 'user-1', 0, ?, 'platform-turn-atomic', 'RUNNING', ?, ?)`,
      )
      .run(task.id, NOW.getTime(), NOW.getTime());
    database.sqlite
      .prepare(
        `INSERT INTO turns (
          id, task_id, codex_turn_id, prompt, status, config_snapshot_json, started_at
        )
        SELECT 'platform-turn-slot-only', task_id, 'runtime-turn-slot-only',
               'Damaged second slot', 'RUNNING', config_snapshot_json, started_at
        FROM turns WHERE id = 'platform-turn-atomic'`,
      )
      .run();
    database.sqlite
      .prepare(
        `INSERT INTO user_turn_slots (
          account_id, user_id, slot_index, task_id, turn_id, status, acquired_at, heartbeat_at
        ) VALUES ('account-atomic', 'user-1', 1, ?, 'platform-turn-slot-only', 'RUNNING', ?, ?)`,
      )
      .run(task.id, NOW.getTime(), NOW.getTime());
    const approval = store.createApproval({
      requestId: "atomic-approval",
      rawRpcId: 9,
      accountId: "account-atomic",
      connectionGeneration: 1,
      threadId: "runtime-thread-secret",
      taskId: task.id,
      turnId: "runtime-turn-secret",
      itemId: "atomic-command",
      approvalType: "COMMAND",
      payload: { command: "pnpm test" },
      now: NOW,
    });
    database.sqlite.exec(`
      CREATE TRIGGER fail_atomic_recovery
      BEFORE UPDATE OF status ON approvals
      WHEN NEW.status = 'RECOVERY_REQUIRED'
      BEGIN
        SELECT RAISE(ABORT, 'simulated crash');
      END;
    `);

    expect(() =>
      store.recoverAccountRuntimeState("account-atomic", new Date(NOW.getTime() + 1)),
    ).toThrow("simulated crash");
    expect(
      database.sqlite
        .prepare("SELECT status FROM codex_accounts WHERE id = 'account-atomic'")
        .get(),
    ).toEqual({ status: "AVAILABLE" });
    expect(store.getTaskForUser(task.id, "user-1")).toMatchObject({ status: "RUNNING" });
    expect(store.getTurn("platform-turn-atomic")).toMatchObject({ status: "RUNNING" });
    expect(store.getTurn("platform-turn-slot-only")).toMatchObject({ status: "RUNNING" });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM user_turn_slots").get()).toEqual({
      count: 2,
    });
    expect(
      database.sqlite.prepare("SELECT status FROM approvals WHERE id = ?").get(approval.id),
    ).toEqual({ status: "PENDING" });

    database.sqlite.exec("DROP TRIGGER fail_atomic_recovery");
    expect(store.recoverAccountRuntimeState("account-atomic", new Date(NOW.getTime() + 2))).toEqual(
      [
        expect.objectContaining({
          taskId: task.id,
          platformTurnId: "platform-turn-atomic",
        }),
      ],
    );
    expect(store.recoverAccountRuntimeState("account-atomic", new Date(NOW.getTime() + 3))).toEqual(
      [],
    );
    expect(
      database.sqlite
        .prepare("SELECT status FROM codex_accounts WHERE id = 'account-atomic'")
        .get(),
    ).toEqual({ status: "QUARANTINED" });
    expect(store.getTaskForUser(task.id, "user-1")).toMatchObject({ status: "NEEDS_RECOVERY" });
    expect(store.getTurn("platform-turn-atomic")).toMatchObject({ status: "NEEDS_RECOVERY" });
    expect(store.getTurn("platform-turn-slot-only")).toMatchObject({ status: "NEEDS_RECOVERY" });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM user_turn_slots").get()).toEqual({
      count: 0,
    });
    expect(
      database.sqlite.prepare("SELECT status FROM approvals WHERE id = ?").get(approval.id),
    ).toEqual({ status: "RECOVERY_REQUIRED" });
  });

  test("records tool provenance and hashes payloads instead of storing sensitive arguments", () => {
    database.sqlite.prepare("UPDATE users SET name = ? WHERE id = ?").run("林可", "user-1");
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
          actorName: "林可",
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
