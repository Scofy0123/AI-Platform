import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type PlatformDatabase } from "../infra/db/database.js";
import { migrateDatabase } from "../infra/db/migrate.js";
import { SQLiteLeaseStore } from "./lease-store.js";
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

  test("keeps Draft Threads out of every list and project count until activation", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Drafts", now: NOW });
    const draft = store.createDraft({
      ownerId: "user-1",
      projectId: project.id,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });

    expect(draft.lifecycleState).toBe("DRAFT");
    expect(store.listTasks("user-1")).toEqual([]);
    expect(store.listArchivedTasks("user-1")).toEqual([]);
    expect(store.listProjects("user-1")).toEqual([
      expect.objectContaining({ id: project.id, taskCount: 0 }),
    ]);
    expect(store.getUserUsage("user-1")).toMatchObject({ threads: 0, turns: 0 });
    expect(store.getTaskForUser(draft.id, "user-2")).toBeNull();

    store.activateDraft(draft.id, "user-1", new Date(NOW.getTime() + 1));
    expect(store.listTasks("user-1")).toEqual([
      expect.objectContaining({ id: draft.id, lifecycleState: "ACTIVE" }),
    ]);
    expect(store.listProjects("user-1")).toEqual([
      expect.objectContaining({ id: project.id, taskCount: 1 }),
    ]);
  });

  test("deletes only an owned unactivated Draft and expires stale Drafts", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Drafts", now: NOW });
    const mine = store.createDraft({
      ownerId: "user-1",
      projectId: project.id,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const stale = store.createDraft({
      ownerId: "user-1",
      projectId: project.id,
      now: NOW,
      expiresAt: new Date(NOW.getTime() - 1),
    });

    expect(() => store.deleteDraft(mine.id, "user-2")).toThrow("Thread not found");
    expect(store.deleteDraft(mine.id, "user-1")).toEqual({ attachmentRefs: [] });
    expect(store.expireDrafts(NOW)).toEqual([
      expect.objectContaining({ threadId: stale.id, attachmentRefs: [] }),
    ]);
    expect(store.getTaskForUser(stale.id, "user-1")).toBeNull();
  });

  test("atomically activates a Draft, claims READY attachments, and snapshots Turn input", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Inputs", now: NOW });
    const draft = store.createDraft({
      ownerId: "user-1",
      projectId: project.id,
      now: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const attachment = store.createAttachment({
      id: "attachment-1",
      threadId: draft.id,
      ownerId: "user-1",
      kind: "FILE",
      name: "diagram.png",
      relativePath: ".codexplatform/attachments/attachment-1/diagram.png",
      mimeType: "image/png",
      sizeBytes: 128,
      fileCount: 1,
      scanStatus: "READY",
      now: NOW,
    });
    const turn = store.createTurn({
      id: "turn-with-input",
      taskId: draft.id,
      ownerId: "user-1",
      prompt: "",
      status: "ALLOCATING",
      attachmentIds: [attachment.id],
      now: NOW,
    });

    expect(store.getReadyAttachments(draft.id, "user-1", [attachment.id])).toEqual([attachment]);
    expect(store.getTurnInputSnapshot(turn.id)).toEqual({
      prompt: "",
      attachments: [attachment],
      capturedAt: NOW.toISOString(),
    });
    expect(store.getTaskForUser(draft.id, "user-1")).toMatchObject({
      lifecycleState: "ACTIVE",
    });
    expect(() => store.deleteAttachment(attachment.id, draft.id, "user-1")).toThrow(
      "Attachment is already claimed by a Turn",
    );
    expect(JSON.stringify(store.getTurnInputSnapshot(turn.id))).not.toContain("/private/");
  });

  test("claims only owned, READY, unclaimed attachments into immutable Steer snapshots", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Steer", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Steer",
      now: NOW,
    });
    const turn = store.createTurn({
      id: "active-turn",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Initial",
      status: "ALLOCATING",
      now: NOW,
    });
    store.setTurnStatus(turn.id, "RUNNING");
    store.setCurrentTurn(task.id, "runtime-active-turn", "RUNNING", NOW);
    const ready = store.createAttachment({
      id: "steer-ready",
      threadId: task.id,
      ownerId: "user-1",
      kind: "FILE",
      name: "ready.txt",
      relativePath: ".codexplatform/attachments/steer-ready/ready.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      fileCount: 1,
      scanStatus: "READY",
      now: NOW,
    });
    const blocked = store.createAttachment({
      id: "steer-blocked",
      threadId: task.id,
      ownerId: "user-1",
      kind: "FILE",
      name: "blocked.txt",
      relativePath: ".codexplatform/attachments/steer-blocked/blocked.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      fileCount: 1,
      scanStatus: "BLOCKED",
      now: NOW,
    });

    expect(
      store.claimSteerInput({
        id: "steer-input-1",
        taskId: task.id,
        turnId: turn.id,
        ownerId: "user-1",
        prompt: "",
        attachmentIds: [ready.id],
        now: NOW,
      }),
    ).toEqual({
      prompt: "",
      attachments: [ready],
      capturedAt: NOW.toISOString(),
    });
    expect(() =>
      store.claimSteerInput({
        id: "steer-input-repeat",
        taskId: task.id,
        turnId: turn.id,
        ownerId: "user-1",
        prompt: "",
        attachmentIds: [ready.id],
        now: NOW,
      }),
    ).toThrow("Attachments must exist, be owned, unclaimed, and READY");
    expect(() =>
      store.claimSteerInput({
        id: "steer-input-blocked",
        taskId: task.id,
        turnId: turn.id,
        ownerId: "user-1",
        prompt: "",
        attachmentIds: [blocked.id],
        now: NOW,
      }),
    ).toThrow("Attachments must exist, be owned, unclaimed, and READY");
    expect(() =>
      store.claimSteerInput({
        id: "steer-input-owner",
        taskId: task.id,
        turnId: turn.id,
        ownerId: "user-2",
        prompt: "steal",
        attachmentIds: [],
        now: NOW,
      }),
    ).toThrow("Task not found");
    expect(() =>
      store.claimSteerInput({
        id: "steer-input-empty",
        taskId: task.id,
        turnId: turn.id,
        ownerId: "user-1",
        prompt: "",
        attachmentIds: [],
        now: NOW,
      }),
    ).toThrow("Invalid Steer input");
  });

  test("enforces attachment root, aggregate-size, and folder-file limits", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Limits", now: NOW });
    const thread = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Limits",
      now: NOW,
    });
    for (let index = 0; index < 32; index += 1) {
      store.createAttachment({
        id: `attachment-${index}`,
        threadId: thread.id,
        ownerId: "user-1",
        kind: "FILE",
        name: `file-${index}.txt`,
        relativePath: `.codexplatform/attachments/attachment-${index}/file-${index}.txt`,
        mimeType: "text/plain",
        sizeBytes: 1,
        fileCount: 1,
        scanStatus: "READY",
        now: NOW,
      });
    }
    expect(() =>
      store.createAttachment({
        id: "attachment-33",
        threadId: thread.id,
        ownerId: "user-1",
        kind: "FILE",
        name: "extra.txt",
        relativePath: ".codexplatform/attachments/attachment-33/extra.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        fileCount: 1,
        scanStatus: "READY",
        now: NOW,
      }),
    ).toThrow("Attachment root limit");
    expect(() =>
      store.createAttachment({
        id: "folder-too-large",
        threadId: thread.id,
        ownerId: "user-1",
        kind: "FOLDER",
        name: "folder",
        relativePath: ".codexplatform/attachments/folder-too-large/folder",
        mimeType: "application/x-directory",
        sizeBytes: 1,
        fileCount: 501,
        scanStatus: "READY",
        now: NOW,
      }),
    ).toThrow("Folder exceeds the 500 file limit");
  });

  test("separates active and archived Thread lists by owner and project", () => {
    const firstProject = store.createProject({
      ownerId: "user-1",
      name: "First",
      now: NOW,
    });
    const secondProject = store.createProject({
      ownerId: "user-1",
      name: "Second",
      now: NOW,
    });
    const visible = store.createTask({
      ownerId: "user-1",
      projectId: firstProject.id,
      title: "Visible",
      now: NOW,
    });
    const archived = store.createTask({
      ownerId: "user-1",
      projectId: firstProject.id,
      title: "Archived",
      now: NOW,
    });
    store.setTaskInactive(archived.id, "COMPLETED", NOW);
    store.archiveThread({
      threadId: archived.id,
      ownerId: "user-1",
      now: new Date(NOW.getTime() + 1),
    });
    const otherProject = store.createTask({
      ownerId: "user-1",
      projectId: secondProject.id,
      title: "Other project",
      now: NOW,
    });

    const visibleThreads = store.listTasks("user-1");
    expect(visibleThreads).toHaveLength(2);
    expect(visibleThreads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: otherProject.id, archivedAt: null }),
        expect.objectContaining({ id: visible.id, archivedAt: null }),
      ]),
    );
    expect(store.listTasks("user-1", firstProject.id)).toEqual([
      expect.objectContaining({ id: visible.id }),
    ]);
    expect(store.listArchivedTasks("user-1")).toEqual([
      expect.objectContaining({
        id: archived.id,
        archivedAt: new Date(NOW.getTime() + 1).toISOString(),
      }),
    ]);
    expect(store.listArchivedTasks("user-2")).toEqual([]);
  });

  test("archives and unarchives an owned inactive Thread atomically with audit", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Archive", now: NOW });
    const thread = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Finished",
      now: NOW,
    });
    store.setTaskInactive(thread.id, "COMPLETED", NOW);
    const archivedAt = new Date(NOW.getTime() + 10);
    const unarchivedAt = new Date(NOW.getTime() + 20);

    expect(
      store.archiveThread({ threadId: thread.id, ownerId: "user-1", now: archivedAt }),
    ).toMatchObject({ id: thread.id, archivedAt: archivedAt.toISOString() });
    expect(store.getTaskForUser(thread.id, "user-1")).toMatchObject({
      archivedAt: archivedAt.toISOString(),
    });
    expect(
      store.unarchiveThread({ threadId: thread.id, ownerId: "user-1", now: unarchivedAt }),
    ).toMatchObject({ id: thread.id, archivedAt: null });

    expect(
      database.sqlite
        .prepare(
          `SELECT actor_user_id, task_id, action, outcome, summary
           FROM audit_events
           WHERE task_id = ?
           ORDER BY created_at`,
        )
        .all(thread.id),
    ).toEqual([
      {
        actor_user_id: "user-1",
        task_id: thread.id,
        action: "THREAD_ARCHIVED",
        outcome: "SUCCESS",
        summary: "Thread archived in CodexPlatform",
      },
      {
        actor_user_id: "user-1",
        task_id: thread.id,
        action: "THREAD_UNARCHIVED",
        outcome: "SUCCESS",
        summary: "Thread unarchived in CodexPlatform",
      },
    ]);
  });

  test("fails closed when another owner archives a Thread or the Thread has active work", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Archive", now: NOW });
    const thread = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Running",
      now: NOW,
    });

    expect(() => store.archiveThread({ threadId: thread.id, ownerId: "user-2", now: NOW })).toThrow(
      "Thread not found",
    );

    for (const status of ["QUEUED", "RUNNING", "WAITING_APPROVAL"]) {
      database.sqlite.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, thread.id);
      expect(() =>
        store.archiveThread({ threadId: thread.id, ownerId: "user-1", now: NOW }),
      ).toThrow("Thread has active work and cannot be archived");
    }

    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({
      count: 0,
    });
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

  test("persists only safe agent message phase metadata", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Message phases",
      now: NOW,
    });

    store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "AGENT_MESSAGE_PHASE",
      payload: {
        itemId: "message-1",
        phase: "final_answer",
        text: "must not persist",
        encrypted_content: "ciphertext",
      } as never,
      now: NOW,
    });

    expect(store.listTaskEvents(task.id, "user-1", 0)).toEqual([
      expect.objectContaining({
        itemId: "message-1",
        payload: { itemId: "message-1", phase: "final_answer" },
      }),
    ]);
    expect(
      JSON.stringify(
        database.sqlite
          .prepare("SELECT payload_json FROM task_events WHERE task_id = ?")
          .get(task.id),
      ),
    ).not.toMatch(/must not persist|ciphertext|encrypted_content/);
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

  test("persists only the readable summary from nested reasoning envelopes", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Keep nested reasoning private",
      now: NOW,
    });
    const rawReasoningCanary = "RAW_REASONING_CANARY_STORE_7d3b";

    store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "TOOL_COMPLETED",
      payload: {
        itemId: "tool-1",
        tool: "business_read",
        result: {
          reasoning: {
            summary: "Readable execution summary.",
            content: [{ type: "reasoning_text", text: rawReasoningCanary }],
            reasoningTextDelta: rawReasoningCanary,
            encrypted_content: rawReasoningCanary,
          },
        },
        durationMs: 17,
      },
      now: NOW,
    });

    const events = store.listTaskEvents(task.id, "user-1", 0);
    expect(events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          result: {
            reasoning: {
              summary: "Readable execution summary.",
            },
          },
        }),
      }),
    ]);
    const persisted = database.sqlite
      .prepare("SELECT payload_json FROM task_events WHERE task_id = ?")
      .get(task.id);
    expect(JSON.stringify({ events, persisted })).toContain("Readable execution summary.");
    expect(JSON.stringify({ events, persisted })).not.toContain(rawReasoningCanary);
  });

  test("persists and replays the final command output snapshot", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Replay command output",
      now: NOW,
    });

    store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "COMMAND_COMPLETED",
      payload: {
        itemId: "command-1",
        command: "printf '01\\n02\\n'",
        aggregatedOutput: "01\n02\n",
        exitCode: 0,
        durationMs: 12,
      },
      now: NOW,
    });

    expect(store.listTaskEvents(task.id, "user-1", 0)).toEqual([
      expect.objectContaining({
        type: "COMMAND_COMPLETED",
        payload: expect.objectContaining({ aggregatedOutput: "01\n02\n" }),
      }),
    ]);
  });

  test("never persists or replays account-home and managed-workspace absolute paths", () => {
    const runtimeDataDir = "/private/var/runtime/CODEX_HOME_SENTINEL_STORE_d42a";
    const codexHome = `${runtimeDataDir}/codex-accounts/codex-private`;
    const leases = new SQLiteLeaseStore(database.sqlite);
    leases.addAccount({
      id: "codex-private",
      alias: "Codex private",
      codexHome,
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
      maxActiveUsers: 4,
      weeklyRemaining: 90,
      quotaUpdatedAt: NOW,
      allowUnknownQuota: false,
      healthScore: 100,
    });
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Redact runtime paths",
      now: NOW,
    });
    const workspaceDir = `${runtimeDataDir}/workspaces/${task.id}`;
    store.bindTaskRuntime(task.id, {
      accountId: "codex-private",
      accountAlias: "Codex private",
      leaseId: "lease-private",
      threadId: "runtime-thread-1",
      now: NOW,
    });

    store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "COMMAND_COMPLETED",
      payload: {
        itemId: "command-private",
        command: `CODEX_HOME=${codexHome} node ${workspaceDir}/script.js packages/app/src/index.ts`,
        aggregatedOutput: `failed while reading ${codexHome}/auth.json`,
        exitCode: 1,
        durationMs: 12,
      },
      now: NOW,
    });
    store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "TURN_FAILED",
      payload: {
        status: "failed",
        error: `runtime failure in ${runtimeDataDir}; source packages/app/src/index.ts`,
      },
      now: new Date(NOW.getTime() + 1),
    });

    const persisted = database.sqlite
      .prepare("SELECT payload_json FROM task_events WHERE task_id = ? ORDER BY sequence")
      .all(task.id);
    const replay = store.listTaskEvents(task.id, "user-1", 0);
    const serialized = JSON.stringify({ persisted, replay });

    expect(serialized).not.toContain(runtimeDataDir);
    expect(serialized).not.toContain("CODEX_HOME_SENTINEL_STORE_d42a");
    expect(serialized).toContain("[CODEX_HOME]");
    expect(serialized).toContain("[WORKSPACE]");
    expect(serialized).toContain("packages/app/src/index.ts");
  });

  test("replays Tool results to the Thread owner through the existing safe payload projection", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Platform", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Replay Tool result",
      now: NOW,
    });

    store.appendTaskEvent({
      taskId: task.id,
      threadId: "runtime-thread-1",
      turnId: "runtime-turn-1",
      type: "TOOL_COMPLETED",
      payload: {
        itemId: "tool-1",
        tool: "business_read",
        result: {
          status: "PAID",
          nested: {
            encrypted_content: "ciphertext",
            reasoningTextDelta: "private reasoning",
          },
        },
        durationMs: 17,
      },
      now: NOW,
    });

    const ownerEvents = store.listTaskEvents(task.id, "user-1", 0);
    expect(ownerEvents).toEqual([
      expect.objectContaining({
        type: "TOOL_COMPLETED",
        payload: {
          itemId: "tool-1",
          tool: "business_read",
          result: { status: "PAID", nested: {} },
          durationMs: 17,
        },
      }),
    ]);
    expect(store.listTaskEvents(task.id, "user-2", 0)).toBeNull();
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

  test("finalizes a deferred model snapshot only before Runtime start", () => {
    const project = store.createProject({ ownerId: "user-1", name: "Deferred model", now: NOW });
    const task = store.createTask({
      ownerId: "user-1",
      projectId: project.id,
      title: "Queued work",
      now: NOW,
    });
    store.createTurn({
      id: "turn-deferred-model",
      taskId: task.id,
      ownerId: "user-1",
      prompt: "Run later",
      status: "ALLOCATING",
      now: NOW,
    });
    const finalized = {
      model: "fake-codex-standard",
      reasoningEffort: "MEDIUM",
      permissionMode: "DEFAULT" as const,
      approvalMode: "ASK" as const,
      personality: "PRAGMATIC" as const,
      instructions: "",
      sourceVersion: "org-policy-1.1a-v1",
    };

    store.updateTurnConfigSnapshot("turn-deferred-model", finalized);
    expect(store.getTurn("turn-deferred-model")?.configSnapshot).toEqual(finalized);

    store.bindTurnRuntime("turn-deferred-model", "runtime-turn", NOW);
    expect(() => store.updateTurnConfigSnapshot("turn-deferred-model", finalized)).toThrow(
      "before Runtime start",
    );
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
