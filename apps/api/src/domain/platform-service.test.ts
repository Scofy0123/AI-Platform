import { EventEmitter } from "node:events";
import { access, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  BootstrapSchema,
  ModelCatalogSchema,
  type ModelOption,
  TaskDetailSchema,
  TaskSummarySchema,
  ThreadSchema,
  UserSettingsViewSchema,
} from "@codexplatform/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDatabase, type PlatformDatabase } from "../infra/db/database.js";
import { migrateDatabase } from "../infra/db/migrate.js";
import { encodeSse } from "../server.js";
import { AccountAdminStore } from "./account-admin-store.js";
import { SQLiteLeaseStore } from "./lease-store.js";
import {
  ActiveTurnResumeConflictError,
  type ApprovalDraft,
  ApprovalTransportUnavailableError,
  LocalPlatformService,
  ModelCatalogUnavailableError,
  type RuntimeSafetyPort,
  type TaskEventDraft,
  type TaskExecutionAdapter,
} from "./platform-service.js";
import { SQLitePlatformStore } from "./platform-store.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const STANDARD_MODEL: ModelOption = {
  id: "fake-codex-standard",
  model: "fake-codex-standard",
  displayName: "Fake Codex Standard",
  description: "Deterministic test model",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { value: "low", description: "Fast" },
    { value: "medium", description: "Balanced" },
    { value: "high", description: "Deep" },
  ],
  inputModalities: ["text", "image"],
  supportsPersonality: true,
};
const DEEP_MODEL: ModelOption = {
  ...STANDARD_MODEL,
  id: "fake-codex-deep",
  model: "fake-codex-deep",
  displayName: "Fake Codex Deep",
  isDefault: false,
  defaultReasoningEffort: "high",
  supportedReasoningEfforts: [
    { value: "medium", description: "Balanced" },
    { value: "high", description: "Deep" },
    { value: "xhigh", description: "Extended" },
  ],
};

describe("LocalPlatformService", () => {
  let database: PlatformDatabase;
  let store: SQLitePlatformStore;
  let leases: SQLiteLeaseStore;
  let accounts: AccountAdminStore;
  let execution: FakeExecution;
  let gate: RuntimeSafetyPort;
  let service: LocalPlatformService;
  let currentNow: Date;

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
    currentNow = NOW;
    service = new LocalPlatformService({
      store,
      leases,
      accounts,
      execution,
      safety: gate,
      dataDir: "/tmp/codexplatform-test",
      now: () => currentNow,
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

    const started = await service.startTurn(task.id, "user-1", "Implement the scheduler");
    const platformTurnId = (
      database.sqlite.prepare("SELECT id FROM turns WHERE task_id = ?").get(task.id) as {
        id: string;
      }
    ).id;
    expect(started).toMatchObject({
      status: "RUNNING",
      accountAlias: "Codex A",
      threadId: `thread-${task.id}`,
      turnId: platformTurnId,
    });
    expect(JSON.stringify(started)).not.toContain(`codex-turn-${task.id}`);
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

  test("persists a Steer only after the runtime accepts it and replays it as a platform Turn item", async () => {
    const project = await service.createProject("user-1", { name: "Steer persistence" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Initial");
    const platformTurnId = (
      database.sqlite.prepare("SELECT id FROM turns WHERE task_id = ?").get(task.id) as {
        id: string;
      }
    ).id;
    const streamed: unknown[] = [];
    service.subscribeThreadEvents(task.id, (event) => streamed.push(event));

    await service.steerThread(task.id, "user-1", "优先核对权限边界");

    expect(execution.steerTask).toHaveBeenCalledWith(
      `thread-${task.id}`,
      `codex-turn-${task.id}`,
      "优先核对权限边界",
    );
    expect(streamed).toEqual([
      expect.objectContaining({
        turnId: platformTurnId,
        type: "USER_MESSAGE",
        payload: expect.objectContaining({
          kind: "STEER",
          text: "优先核对权限边界",
        }),
      }),
    ]);
    expect(await service.getThread(task.id, "user-1")).toMatchObject({
      items: [
        expect.anything(),
        expect.objectContaining({
          turnId: platformTurnId,
          type: "USER_MESSAGE",
          payload: expect.objectContaining({ text: "优先核对权限边界" }),
        }),
      ],
    });

    execution.steerTask.mockRejectedValueOnce(new Error("runtime rejected steer"));
    await expect(service.steerThread(task.id, "user-1", "不得落库")).rejects.toThrow(
      "runtime rejected steer",
    );
    expect(JSON.stringify(await service.getThread(task.id, "user-1"))).not.toContain("不得落库");
  });

  test("claims READY attachments into an immutable snapshot before an attachment-only Steer", async () => {
    const project = await service.createProject("user-1", { name: "Steer attachment" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Initial");
    const platformTurnId = (
      database.sqlite.prepare("SELECT id FROM turns WHERE task_id = ?").get(task.id) as {
        id: string;
      }
    ).id;
    const attachment = store.createAttachment({
      id: "steer-attachment-1",
      threadId: task.id,
      ownerId: "user-1",
      kind: "FILE",
      name: "diagram.png",
      relativePath: ".codexplatform/attachments/steer-attachment-1/diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
      fileCount: 1,
      scanStatus: "READY",
      now: NOW,
    });

    await service.steerThread(task.id, "user-1", "", [attachment.id]);

    expect(execution.steerTask).toHaveBeenLastCalledWith(
      `thread-${task.id}`,
      `codex-turn-${task.id}`,
      "",
      [
        {
          name: "diagram.png",
          path: expect.stringContaining("/attachments/steer-attachment-1/diagram.png"),
          mimeType: "image/png",
        },
      ],
    );
    expect(store.listSteerInputSnapshots(platformTurnId)).toEqual([
      {
        prompt: "",
        attachments: [attachment],
        capturedAt: NOW.toISOString(),
      },
    ]);
    expect(() => store.deleteAttachment(attachment.id, task.id, "user-1")).toThrow(
      "Attachment is already claimed by a Turn",
    );
  });

  test("allows Steer only for RUNNING or WAITING_APPROVAL tasks", async () => {
    const project = await service.createProject("user-1", { name: "Steer state" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await expect(service.steerThread(task.id, "user-1", "too early")).rejects.toThrow(
      "does not accept Steer",
    );
    expect(execution.steerTask).not.toHaveBeenCalled();
  });

  test("does not expose an owned Draft through legacy task detail or event reads", async () => {
    const project = await service.createProject("user-1", { name: "Hidden draft" });
    const draft = await service.createDraft("user-1", { projectId: project.id });

    await expect(service.getTask(draft.id, "user-1")).resolves.toBeNull();
    await expect(service.listTaskEvents(draft.id, "user-1", 0)).resolves.toBeNull();
    await expect(service.listThreadEvents(draft.id, "user-1", 0)).resolves.toBeNull();
  });

  test("maintenance expires Drafts with their files idempotently using its supplied clock", async () => {
    const project = await service.createProject("user-1", { name: "Draft maintenance" });
    const draft = await service.createDraft("user-1", { projectId: project.id });
    const attachment = await service.uploadAttachment(draft.id, "user-1", {
      files: [
        {
          name: "notes.txt",
          relativePath: "notes.txt",
          mimeType: "text/plain",
          content: Buffer.from("hello"),
        },
      ],
    });
    const attachmentRoot = join(
      "/tmp/codexplatform-test",
      "workspaces",
      draft.id,
      ".codexplatform",
      "attachments",
      attachment.id,
    );
    const maintenanceAt = new Date(NOW.getTime() + 2 * 60 * 60_000);

    await access(attachmentRoot);
    await service.runMaintenance(maintenanceAt);
    await expect(access(attachmentRoot)).rejects.toThrow();
    expect(store.getTaskForUser(draft.id, "user-1")).toBeNull();

    await expect(service.runMaintenance(maintenanceAt)).resolves.toBeUndefined();
  });

  test("rejects a symlink in the staging ancestry without writing outside the workspace", async () => {
    const project = await service.createProject("user-1", { name: "Symlink safety" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    const workspace = join("/tmp/codexplatform-test", "workspaces", task.id);
    const escapeRoot = join("/tmp", `codexplatform-escape-${task.id}`);
    await mkdir(workspace, { recursive: true });
    await mkdir(escapeRoot, { recursive: true });
    await symlink(escapeRoot, join(workspace, ".codexplatform"));

    try {
      await expect(
        service.uploadAttachment(task.id, "user-1", {
          files: [
            {
              name: "notes.txt",
              relativePath: "notes.txt",
              mimeType: "text/plain",
              content: Buffer.from("must stay contained"),
            },
          ],
        }),
      ).rejects.toThrow("Unsafe attachment staging path");
      expect(await readdir(escapeRoot)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(escapeRoot, { recursive: true, force: true });
    }
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

  test("boots 1.1 with only the real Codex product mode enabled", async () => {
    expect(BootstrapSchema.parse(await service.getBootstrap())).toEqual({
      platformVersion: "0.1.0",
      defaultMode: "CODEX",
      enabledModes: ["CODEX"],
      capabilities: {
        threads: true,
        settings: true,
        subagents: true,
        reasoningSummaries: true,
      },
    });
  });

  test("returns a strict account-independent model catalog for the current user", async () => {
    execution.listModels.mockResolvedValueOnce([STANDARD_MODEL]);

    const catalog = ModelCatalogSchema.parse(await service.listModels("user-1"));

    expect(catalog).toMatchObject({
      models: [expect.objectContaining({ model: "fake-codex-standard" })],
      scope: "ELIGIBLE_ACCOUNT_INTERSECTION",
      accountCount: 1,
      observedAt: NOW.toISOString(),
      stale: false,
    });
    expect(execution.listModels).toHaveBeenCalledWith(
      expect.objectContaining({ id: "account-1", codexHome: expect.any(String) }),
    );
    expect(JSON.stringify(catalog)).not.toMatch(/accountId|accountAlias|codexHome|Codex A/i);
  });

  test("intersects model capabilities across every account eligible for an unbound Thread", async () => {
    leases.addAccount({
      id: "account-2",
      alias: "Codex B",
      codexHome: "/tmp/codexplatform-test/account-2",
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
      maxActiveUsers: 4,
      weeklyRemaining: 70,
      quotaUpdatedAt: NOW,
      allowUnknownQuota: false,
      healthScore: 100,
    });
    execution.listModels.mockImplementation(async (account) =>
      account.id === "account-1"
        ? [STANDARD_MODEL]
        : [
            {
              ...STANDARD_MODEL,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { value: "medium", description: "Balanced" },
                { value: "xhigh", description: "Extended" },
              ],
              inputModalities: ["text"],
              supportsPersonality: false,
            },
          ],
    );

    const catalog = ModelCatalogSchema.parse(await service.listModels("user-1"));

    expect(catalog).toMatchObject({
      scope: "ELIGIBLE_ACCOUNT_INTERSECTION",
      accountCount: 2,
      models: [
        expect.objectContaining({
          model: "fake-codex-standard",
          supportedReasoningEfforts: [{ value: "medium", description: "Balanced" }],
          inputModalities: ["text"],
          supportsPersonality: false,
        }),
      ],
    });
  });

  test("returns an expired cached model catalog as stale when refresh fails", async () => {
    execution.listModels.mockResolvedValueOnce([STANDARD_MODEL]);
    await expect(service.listModels("user-1")).resolves.toMatchObject({ stale: false });

    currentNow = new Date(NOW.getTime() + 60_001);
    execution.listModels.mockRejectedValueOnce(new Error("runtime unavailable"));

    await expect(service.listModels("user-1")).resolves.toMatchObject({
      stale: true,
      observedAt: NOW.toISOString(),
    });
  });

  test("fails closed instead of using a stale model catalog for execution", async () => {
    execution.listModels.mockResolvedValueOnce([STANDARD_MODEL]);
    await service.listModels("user-1");
    currentNow = new Date(NOW.getTime() + 60_001);
    execution.listModels.mockRejectedValueOnce(new Error("runtime unavailable"));
    const project = await service.createProject("user-1", { name: "Fresh catalog" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Must refresh",
    });

    await expect(
      service.startThreadTurn(thread.id, "user-1", "Do not start", {
        model: "fake-codex-standard",
        reasoningEffort: "medium",
      }),
    ).rejects.toBeInstanceOf(ModelCatalogUnavailableError);
    expect(execution.startTask).not.toHaveBeenCalled();
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM turns").get()).toEqual({
      count: 0,
    });
  });

  test("single-flights concurrent account model catalog refreshes", async () => {
    const pending = deferred<ModelOption[]>();
    execution.listModels.mockReturnValueOnce(pending.promise);

    const first = service.listModels("user-1");
    const second = service.listModels("user-1");
    expect(execution.listModels).toHaveBeenCalledTimes(1);
    pending.resolve([STANDARD_MODEL]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ stale: false }),
      expect.objectContaining({ stale: false }),
    ]);
    expect(execution.listModels).toHaveBeenCalledTimes(1);
  });

  test("invalidates an account model cache when its authentication lifecycle changes", async () => {
    execution.listModels
      .mockResolvedValueOnce([STANDARD_MODEL])
      .mockResolvedValueOnce([DEEP_MODEL]);
    await expect(service.listModels("user-1")).resolves.toMatchObject({
      models: [expect.objectContaining({ model: "fake-codex-standard" })],
    });

    execution.emit("accountAuthFailed", { accountId: "account-1" });
    leases.updateAccount("account-1", {
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
    });

    await expect(service.listModels("user-1")).resolves.toMatchObject({
      models: [expect.objectContaining({ model: "fake-codex-deep" })],
    });
    expect(execution.listModels).toHaveBeenCalledTimes(2);
  });

  test("does not return a warm model catalog after its account is quarantined", async () => {
    execution.listModels.mockResolvedValueOnce([STANDARD_MODEL]);
    await expect(service.listModels("user-1")).resolves.toMatchObject({
      stale: false,
      accountCount: 1,
    });

    await service.setAccountState("account-1", "QUARANTINED", "user-1");

    await expect(service.listModels("user-1")).rejects.toBeInstanceOf(ModelCatalogUnavailableError);
    expect(execution.listModels).toHaveBeenCalledTimes(1);
  });

  test("refreshes the model catalog after an account is quarantined and restored", async () => {
    execution.listModels
      .mockResolvedValueOnce([STANDARD_MODEL])
      .mockResolvedValueOnce([DEEP_MODEL]);
    await expect(service.listModels("user-1")).resolves.toMatchObject({
      models: [expect.objectContaining({ model: "fake-codex-standard" })],
    });

    await service.setAccountState("account-1", "QUARANTINED", "user-1");
    await service.setAccountState("account-1", "AVAILABLE", "user-1");

    await expect(service.listModels("user-1")).resolves.toMatchObject({
      models: [expect.objectContaining({ model: "fake-codex-deep" })],
      stale: false,
    });
    expect(execution.listModels).toHaveBeenCalledTimes(2);
  });

  test("rejects a leased Turn when its account is quarantined during model refresh", async () => {
    const allocatedCatalog = deferred<ModelOption[]>();
    execution.listModels
      .mockResolvedValueOnce([STANDARD_MODEL])
      .mockReturnValueOnce(allocatedCatalog.promise);
    const project = await service.createProject("user-1", { name: "Quarantine race" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Must not start",
    });

    const starting = service.startThreadTurn(thread.id, "user-1", "Do not run");
    await vi.waitFor(() => expect(execution.listModels).toHaveBeenCalledTimes(2));
    await service.setAccountState("account-1", "QUARANTINED", "user-1");
    allocatedCatalog.resolve([STANDARD_MODEL]);

    await expect(starting).rejects.toThrow();
    expect(execution.startTask).not.toHaveBeenCalled();
    expect(accounts.list()[0]).toMatchObject({ status: "QUARANTINED" });
    expect(leases.getAccountOccupancy("account-1")).toEqual({
      activeUsers: 0,
      activeTurns: 0,
    });
    expect(await service.getThread(thread.id, "user-1")).toMatchObject({
      status: "FAILED",
      currentTurn: null,
      turns: [expect.objectContaining({ status: "FAILED" })],
    });
  });

  test("returns only the bound account catalog for an existing Runtime Thread", async () => {
    execution.listModels.mockResolvedValue([STANDARD_MODEL]);
    const project = await service.createProject("user-1", { name: "Bound catalog" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Bound",
    });
    await service.startThreadTurn(thread.id, "user-1", "Bind the account");

    await expect(service.listModels("user-1", thread.id)).resolves.toMatchObject({
      scope: "SINGLE_ACCOUNT",
      accountCount: 1,
      models: [expect.objectContaining({ model: "fake-codex-standard" })],
    });
    await expect(service.listModels("user-2", thread.id)).rejects.toThrow("Thread not found");
  });

  test("validates a selected model and effort before persisting or starting a Turn", async () => {
    execution.listModels.mockResolvedValue([STANDARD_MODEL]);
    const project = await service.createProject("user-1", { name: "Model validation" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Validated",
    });

    await expect(
      service.startThreadTurn(thread.id, "user-1", "Reject", {
        model: "fake-codex-standard",
        reasoningEffort: "ultra",
      }),
    ).rejects.toThrow("Reasoning effort is not supported by the selected model");
    expect(execution.startTask).not.toHaveBeenCalled();
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM turns").get()).toEqual({
      count: 0,
    });

    await expect(
      service.startThreadTurn(thread.id, "user-1", "Run", {
        model: "fake-codex-standard",
        reasoningEffort: "high",
      }),
    ).resolves.toMatchObject({ status: "RUNNING" });
    expect(execution.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveConfig: expect.objectContaining({
          model: "fake-codex-standard",
          reasoningEffort: "high",
        }),
      }),
    );
  });

  test("resolves a null model to the Runtime default in the immutable Turn snapshot", async () => {
    execution.listModels.mockResolvedValue([STANDARD_MODEL]);
    const project = await service.createProject("user-1", { name: "Runtime default" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Default model",
    });

    await service.startThreadTurn(thread.id, "user-1", "Use the default");

    await expect(service.getThread(thread.id, "user-1")).resolves.toMatchObject({
      currentTurn: {
        configSnapshot: {
          model: "fake-codex-standard",
          reasoningEffort: "MEDIUM",
        },
      },
    });
    expect(execution.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveConfig: expect.objectContaining({ model: "fake-codex-standard" }),
      }),
    );
  });

  test("fails a changed model selection after allocation without requiring recovery", async () => {
    execution.listModels.mockResolvedValueOnce([STANDARD_MODEL]).mockResolvedValueOnce([
      {
        ...STANDARD_MODEL,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [{ value: "low", description: "Fast" }],
      },
    ]);
    const project = await service.createProject("user-1", { name: "Allocation race" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Catalog changed",
    });

    await expect(
      service.startThreadTurn(thread.id, "user-1", "Do not run", {
        model: "fake-codex-standard",
        reasoningEffort: "high",
      }),
    ).rejects.toThrow("Model availability changed after allocation");

    expect(execution.startTask).not.toHaveBeenCalled();
    expect(leases.getAccountOccupancy("account-1")).toEqual({
      activeUsers: 0,
      activeTurns: 0,
    });
    expect(database.sqlite.prepare("SELECT status FROM turns").get()).toEqual({
      status: "FAILED",
    });
    expect(await service.getThread(thread.id, "user-1")).toMatchObject({
      status: "FAILED",
      turns: [expect.objectContaining({ status: "FAILED" })],
      items: [
        expect.objectContaining({
          type: "TURN_FAILED",
          payload: expect.objectContaining({
            error: "The selected model or Effort became unavailable before execution.",
          }),
        }),
      ],
    });
    expect(JSON.stringify(await service.getThread(thread.id, "user-1"))).not.toContain(
      "NEEDS_RECOVERY",
    );
  });

  test("cools down an account before promoting the next queued Turn after catalog refresh fails", async () => {
    database.sqlite
      .prepare("UPDATE codex_accounts SET max_active_users = 1 WHERE id = 'account-1'")
      .run();
    const catalogRefresh = deferred<ModelOption[]>();
    execution.listModels
      .mockResolvedValueOnce([STANDARD_MODEL])
      .mockReturnValueOnce(catalogRefresh.promise)
      .mockRejectedValue(new Error("runtime unavailable"));
    const project = await service.createProject("user-1", { name: "Catalog outage" });
    const firstThread = await service.createThread("user-1", {
      projectId: project.id,
      title: "First",
    });
    const secondProject = await service.createProject("user-2", { name: "Catalog outage" });
    const secondThread = await service.createThread("user-2", {
      projectId: secondProject.id,
      title: "Second",
    });

    const firstStart = service.startThreadTurn(firstThread.id, "user-1", "First prompt");
    await nextTick();
    await expect(
      service.startThreadTurn(secondThread.id, "user-2", "Second prompt"),
    ).resolves.toMatchObject({ status: "QUEUED" });

    catalogRefresh.reject(new Error("runtime unavailable"));
    await expect(firstStart).rejects.toBeInstanceOf(ModelCatalogUnavailableError);
    await nextTick();

    expect(accounts.list()[0]).toMatchObject({ status: "COOLDOWN" });
    expect(await service.getThread(secondThread.id, "user-2")).toMatchObject({
      status: "QUEUED",
      currentTurn: expect.objectContaining({ status: "QUEUED" }),
    });
    expect(execution.listModels).toHaveBeenCalledTimes(2);
    expect(execution.startTask).not.toHaveBeenCalled();

    execution.listModels.mockResolvedValue([STANDARD_MODEL]);
    currentNow = new Date(NOW.getTime() + 31_000);
    await service.runMaintenance(currentNow);
    await vi.waitFor(async () => {
      expect(await service.getThread(secondThread.id, "user-2")).toMatchObject({
        status: "RUNNING",
        currentTurn: expect.objectContaining({ status: "RUNNING" }),
      });
    });
    expect(execution.startTask).toHaveBeenCalledTimes(1);
  });

  test("keeps personal model Settings linked to the selected model catalog", async () => {
    execution.listModels.mockResolvedValue([STANDARD_MODEL]);

    await expect(
      service.patchMySettings("user-1", {
        execution: { model: "fake-codex-standard", reasoningEffort: "high" },
      }),
    ).resolves.toMatchObject({
      execution: { model: "fake-codex-standard", reasoningEffort: "high" },
    });

    await expect(
      service.patchMySettings("user-1", {
        execution: { reasoningEffort: "ultra" },
      }),
    ).rejects.toThrow("Reasoning effort is not supported by the selected model");
    await expect(service.getMySettings("user-1")).resolves.toMatchObject({
      execution: { model: "fake-codex-standard", reasoningEffort: "high" },
    });
  });

  test("validates effort-only personal Settings against the Runtime default model", async () => {
    execution.listModels.mockResolvedValue([STANDARD_MODEL]);

    await expect(
      service.patchMySettings("user-1", {
        execution: { reasoningEffort: "ultra" },
      }),
    ).rejects.toThrow("Reasoning effort is not supported by the selected model");

    await expect(service.getMySettings("user-1")).resolves.toMatchObject({
      execution: { model: null, reasoningEffort: "MEDIUM" },
    });
  });

  test("validates a null-model Thread config against the Runtime default before persisting", async () => {
    execution.listModels.mockResolvedValue([STANDARD_MODEL]);
    const project = await service.createProject("user-1", { name: "Default model config" });

    await expect(
      service.createThread("user-1", {
        projectId: project.id,
        title: "Invalid default Effort",
        config: { model: null, reasoningEffort: "ultra" },
      }),
    ).rejects.toThrow("Reasoning effort is not supported by the selected model");

    await expect(service.listThreads("user-1", project.id)).resolves.toEqual([]);
  });

  test("does not persist a null-model Thread config without a routable default model", async () => {
    await service.setAccountState("account-1", "QUARANTINED", "user-1");
    const project = await service.createProject("user-1", { name: "No default model" });

    await expect(
      service.createThread("user-1", {
        projectId: project.id,
        title: "Must not persist",
        config: { model: null, reasoningEffort: "medium" },
      }),
    ).rejects.toBeInstanceOf(ModelCatalogUnavailableError);

    await expect(service.listThreads("user-1", project.id)).resolves.toEqual([]);
  });

  test("projects legacy tasks as owned continuous Threads with stable Items", async () => {
    const project = await service.createProject("user-1", { name: "Threads" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Continuous conversation",
    });
    await service.startThreadTurn(thread.id, "user-1", "Inspect the repository");
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: `thread-${thread.id}`,
      turnId: `codex-turn-${thread.id}`,
      type: "AGENT_MESSAGE_DELTA",
      payload: { itemId: "message-1", delta: "Working" },
    });
    const schedulerTurn = database.sqlite
      .prepare("SELECT id FROM turns WHERE task_id = ?")
      .get(thread.id) as { id: string };

    const detail = ThreadSchema.parse(await service.getThread(thread.id, "user-1"));
    expect(detail).toMatchObject({
      id: thread.id,
      projectId: project.id,
      title: "Continuous conversation",
      currentTurn: {
        id: schedulerTurn.id,
        threadId: thread.id,
        prompt: "Inspect the repository",
      },
      turns: [
        expect.objectContaining({
          id: schedulerTurn.id,
          prompt: "Inspect the repository",
          configSnapshot: expect.objectContaining({
            reasoningEffort: "MEDIUM",
            approvalMode: "ASK",
          }),
        }),
      ],
      items: [
        expect.objectContaining({
          id: expect.any(String),
          threadId: thread.id,
          turnId: schedulerTurn.id,
          type: "LEASE_ACQUIRED",
        }),
        expect.objectContaining({
          id: "message-1",
          threadId: thread.id,
          turnId: schedulerTurn.id,
          type: "AGENT_MESSAGE_DELTA",
        }),
      ],
    });
    expect(await service.listThreads("user-1")).toEqual([
      expect.objectContaining({ id: thread.id }),
    ]);
    expect(await service.getThread(thread.id, "user-2")).toBeNull();
    expect(JSON.stringify(detail)).not.toMatch(/ownerId|leaseId|runtime-thread|Codex A/);
  });

  test("lets a same-tenant administrator inspect a member Thread read-only", async () => {
    const project = await service.createProject("user-2", { name: "Member project" });
    const thread = await service.createThread("user-2", {
      projectId: project.id,
      title: "Member conversation",
    });

    expect(await service.getAdminThread(thread.id, "user-1")).toMatchObject({
      id: thread.id,
      title: "Member conversation",
    });
    expect(await service.getAdminThread(thread.id, "user-2")).toBeNull();
    expect(await service.getThread(thread.id, "user-1")).toBeNull();
  });

  test("lists, archives and unarchives only the current user's local Threads", async () => {
    const project = await service.createProject("user-1", { name: "Archive" });
    const visible = await service.createThread("user-1", {
      projectId: project.id,
      title: "Visible",
    });
    const archived = await service.createThread("user-1", {
      projectId: project.id,
      title: "Archive me",
    });

    await service.archiveThread(archived.id, "user-1");

    expect(await service.listThreads("user-1")).toEqual([
      expect.objectContaining({ id: visible.id, archivedAt: null }),
    ]);
    expect(await service.listArchivedThreads("user-1")).toEqual([
      expect.objectContaining({ id: archived.id, archivedAt: NOW.toISOString() }),
    ]);
    expect(await service.listArchivedThreads("user-2")).toEqual([]);
    await expect(service.archiveThread(archived.id, "user-2")).rejects.toThrow("Thread not found");
    expect(execution.startTask).not.toHaveBeenCalled();
    expect(execution.interruptTask).not.toHaveBeenCalled();

    await service.unarchiveThread(archived.id, "user-1");

    expect(await service.listArchivedThreads("user-1")).toEqual([]);
    expect((await service.listThreads("user-1")).map((thread) => thread.id)).toEqual(
      expect.arrayContaining([visible.id, archived.id]),
    );
  });

  test("refuses to archive a Thread while its Turn is running", async () => {
    const project = await service.createProject("user-1", { name: "Archive guard" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Still running",
    });
    await service.startThreadTurn(thread.id, "user-1", "Keep working");

    await expect(service.archiveThread(thread.id, "user-1")).rejects.toThrow(
      "Thread has active work and cannot be archived",
    );
    expect(await service.listArchivedThreads("user-1")).toEqual([]);
  });

  test("does not start a new Turn until an archived Thread is restored", async () => {
    const project = await service.createProject("user-1", { name: "Archived execution" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Archived",
    });
    await service.archiveThread(thread.id, "user-1");

    await expect(service.startThreadTurn(thread.id, "user-1", "Do not run")).rejects.toThrow(
      "Thread is archived",
    );
    await expect(service.steerThread(thread.id, "user-1", "Do not steer")).rejects.toThrow(
      "Thread is archived",
    );
    await expect(service.interruptThread(thread.id, "user-1")).rejects.toThrow(
      "Thread is archived",
    );
    expect(execution.startTask).not.toHaveBeenCalled();
    expect(execution.steerTask).not.toHaveBeenCalled();
    expect(execution.interruptTask).not.toHaveBeenCalled();
  });

  test("reconstructs every completed Turn in creation order with its immutable config snapshot", async () => {
    const project = await service.createProject("user-1", { name: "History" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Two turns",
    });

    await service.startThreadTurn(thread.id, "user-1", "First prompt");
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: `thread-${thread.id}`,
      turnId: `codex-turn-${thread.id}`,
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });
    execution.startTask.mockResolvedValueOnce({
      threadId: `thread-${thread.id}`,
      turnId: `codex-turn-${thread.id}-2`,
    });
    await service.startThreadTurn(thread.id, "user-1", "Second prompt");
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: `thread-${thread.id}`,
      turnId: `codex-turn-${thread.id}-2`,
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 20 },
    });

    const detail = ThreadSchema.parse(await service.getThread(thread.id, "user-1"));
    expect(detail.currentTurn).toBeNull();
    expect(detail.turns.map((turn) => [turn.prompt, turn.status])).toEqual([
      ["First prompt", "COMPLETED"],
      ["Second prompt", "COMPLETED"],
    ]);
    expect(detail.turns[0]?.configSnapshot).toEqual(detail.turns[1]?.configSnapshot);
    expect(JSON.stringify(detail)).not.toContain("Codex A");
  });

  test("isolates Settings and exposes organization policy metadata", async () => {
    const updated = UserSettingsViewSchema.parse(
      await service.patchMySettings("user-1", {
        general: { theme: "DARK" },
        personalization: { instructions: "Use concise Chinese." },
      }),
    );

    expect(updated).toMatchObject({
      general: { theme: "DARK" },
      personalization: { instructions: "Use concise Chinese." },
      policy: {
        allowedModels: null,
        allowedReasoningEfforts: ["LOW", "MEDIUM", "HIGH", "XHIGH", "ULTRA"],
        allowedPermissionModes: [
          "DEFAULT",
          "READ_ONLY",
          "WORKSPACE_WRITE",
          "ASK_FOR_APPROVAL",
          "APPROVE_FOR_ME",
        ],
        allowedApprovalPreferences: ["ASK"],
        lockedFields: [],
      },
    });
    expect(await service.getMySettings("user-2")).toMatchObject({
      general: { theme: "SYSTEM" },
      personalization: { instructions: "" },
    });
    await expect(
      service.patchMySettings("user-1", {
        execution: { permissionMode: "FULL_ACCESS" },
      } as never),
    ).rejects.toThrow(/not allowed/i);
    await expect(
      service.patchMySettings("user-1", {
        execution: { approvalPreference: "NEVER" },
      } as never),
    ).rejects.toThrow(/not allowed/i);
  });

  test("accepts only an owned project as the user's default project", async () => {
    const owned = await service.createProject("user-1", { name: "Owned" });
    const other = await service.createProject("user-2", { name: "Other user" });

    await expect(
      service.patchMySettings("user-1", {
        general: { defaultProjectId: owned.id },
      }),
    ).resolves.toMatchObject({ general: { defaultProjectId: owned.id } });
    await expect(
      service.patchMySettings("user-1", {
        general: { defaultProjectId: other.id },
      }),
    ).rejects.toThrow("Invalid default project");
    await expect(
      service.patchMySettings("user-1", {
        general: { defaultProjectId: "unknown-project" },
      }),
    ).rejects.toThrow("Invalid default project");
  });

  test("passes each Feishu user's immutable effective Settings and ActorContext to Runtime", async () => {
    await service.patchMySettings("user-1", {
      execution: {
        reasoningEffort: "HIGH",
        permissionMode: "READ_ONLY",
      },
      personalization: {
        personality: "FRIENDLY",
        instructions: "Answer user one concisely.",
      },
    });
    await service.patchMySettings("user-2", {
      execution: {
        reasoningEffort: "LOW",
        permissionMode: "WORKSPACE_WRITE",
      },
      personalization: {
        personality: "NONE",
        instructions: "Answer user two with evidence.",
      },
    });
    const projectOne = await service.createProject("user-1", { name: "One" });
    const projectTwo = await service.createProject("user-2", { name: "Two" });
    const threadOne = await service.createThread("user-1", {
      projectId: projectOne.id,
      title: "One",
    });
    const threadTwo = await service.createThread("user-2", {
      projectId: projectTwo.id,
      title: "Two",
    });

    await service.startThreadTurn(threadOne.id, "user-1", "First");
    await service.startThreadTurn(threadTwo.id, "user-2", "Second");

    expect(execution.startTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        effectiveConfig: expect.objectContaining({
          reasoningEffort: "HIGH",
          permissionMode: "READ_ONLY",
          approvalMode: "ASK",
          personality: "FRIENDLY",
          instructions: expect.stringContaining("Answer user one concisely."),
        }),
        actorContext: {
          tenantKey: "tenant-1",
          userId: "user-1",
          role: "ADMIN",
          toolScopes: [
            "feishu_wiki_search",
            "feishu_doc_read",
            "demo_db_query",
            "demo_business_get",
          ],
          approvalPolicy: "ASK",
        },
      }),
    );
    expect(execution.startTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        effectiveConfig: expect.objectContaining({
          reasoningEffort: "LOW",
          permissionMode: "WORKSPACE_WRITE",
          approvalMode: "ASK",
          personality: "NONE",
          instructions: expect.stringContaining("Answer user two with evidence."),
        }),
        actorContext: expect.objectContaining({
          tenantKey: "tenant-1",
          userId: "user-2",
          role: "MEMBER",
        }),
      }),
    );
  });

  test("merges organization, user, Thread and Turn config into one persisted immutable snapshot", async () => {
    execution.listModels.mockResolvedValue([STANDARD_MODEL, DEEP_MODEL]);
    await service.patchMySettings("user-1", {
      execution: { reasoningEffort: "LOW", permissionMode: "READ_ONLY" },
      personalization: {
        personality: "FRIENDLY",
        instructions: "User instructions",
      },
    });
    const project = await service.createProject("user-1", { name: "Config merge" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Config",
      config: {
        reasoningEffort: "HIGH",
        permissionMode: "WORKSPACE_WRITE",
        instructions: "Thread instructions",
      },
    });

    await service.startThreadTurn(thread.id, "user-1", "Run", {
      model: "fake-codex-deep",
      reasoningEffort: "xhigh",
      personality: "NONE",
      instructions: "",
    });

    const detail = await service.getThread(thread.id, "user-1");
    expect(detail?.currentTurn?.configSnapshot).toEqual({
      model: "fake-codex-deep",
      reasoningEffort: "xhigh",
      permissionMode: "WORKSPACE_WRITE",
      approvalMode: "ASK",
      personality: "NONE",
      instructions:
        "Apply organization policy and use the authenticated employee identity for enterprise tools.",
      sourceVersion: "org-policy-1.1a-v1",
    });
    expect(execution.startTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        effectiveConfig: detail?.currentTurn?.configSnapshot,
      }),
    );
  });

  test("persists observable subagent summaries and keeps details private to the parent owner", async () => {
    const project = await service.createProject("user-1", { name: "Subagents" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Delegate",
    });
    await service.startThreadTurn(thread.id, "user-1", "Run parallel research");

    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: `thread-${thread.id}`,
      turnId: `codex-turn-${thread.id}`,
      type: "SUBAGENT_ACTIVITY",
      payload: {
        itemId: "collab-1:agent-thread-1",
        agentThreadId: "agent-thread-1",
        kind: "started",
        name: "Repository audit",
        role: "subagent",
        model: "gpt-5",
        effort: "HIGH",
        status: "ACTIVE",
        resultSummary: null,
      },
    });
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: "agent-thread-1",
      turnId: "agent-turn-1",
      subagentThreadId: "agent-thread-1",
      type: "TURN_STARTED",
      payload: { status: "inProgress" },
    });
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: "agent-thread-1",
      turnId: "agent-turn-1",
      subagentThreadId: "agent-thread-1",
      type: "AGENT_MESSAGE_DELTA",
      payload: { itemId: "child-message-1", delta: "Inspecting files" },
    });
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: "agent-thread-1",
      turnId: "agent-turn-1",
      subagentThreadId: "agent-thread-1",
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: `thread-${thread.id}`,
      turnId: `codex-turn-${thread.id}`,
      type: "SUBAGENT_ACTIVITY",
      payload: {
        itemId: "collab-2:agent-thread-1",
        agentThreadId: "agent-thread-1",
        kind: "completed",
        name: "Repository audit",
        role: "subagent",
        model: "gpt-5",
        effort: "HIGH",
        status: "DONE",
        resultSummary: "No critical findings",
      },
    });

    expect(await service.listSubagents(thread.id, "user-1")).toEqual([
      expect.objectContaining({
        threadId: "agent-thread-1",
        parentThreadId: thread.id,
        parentTurnId: expect.any(String),
        status: "DONE",
        resultSummary: "No critical findings",
      }),
    ]);
    expect(await service.getSubagent("agent-thread-1", "user-1")).toMatchObject({
      name: "Repository audit",
      items: [
        expect.objectContaining({ type: "TURN_STARTED", threadId: "agent-thread-1" }),
        expect.objectContaining({
          type: "AGENT_MESSAGE_DELTA",
          id: "child-message-1",
          threadId: "agent-thread-1",
          turnId: null,
        }),
        expect.objectContaining({ type: "TURN_COMPLETED", threadId: "agent-thread-1" }),
      ],
    });
    expect(await service.getSubagent("agent-thread-1", "user-2")).toBeNull();
    expect(await service.getTask(thread.id, "user-1")).toMatchObject({ status: "RUNNING" });
    expect((await service.getThread(thread.id, "user-1"))?.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "child-message-1" }),
        expect.objectContaining({ turnId: "agent-turn-1", type: "TURN_COMPLETED" }),
      ]),
    );
  });

  test("reports only factual usage and connection data", async () => {
    const project = await service.createProject("user-1", { name: "Usage" });
    await service.createThread("user-1", { projectId: project.id, title: "One thread" });

    expect(await service.getMyUsage("user-1")).toMatchObject({
      threads: 1,
      tokenUsage: null,
      tokenUsageStatus: "UNKNOWN",
    });
    expect(await service.getMyConnections("user-1")).toEqual([
      expect.objectContaining({
        id: "feishu",
        managed: true,
        connected: false,
      }),
    ]);
    expect(await service.getMyPlugins("user-1")).toEqual([]);
  });

  test("persists parent and child Thread token snapshots and aggregates the owned Thread tree", async () => {
    const project = await service.createProject("user-1", { name: "Token usage" });
    const thread = await service.createThread("user-1", {
      projectId: project.id,
      title: "Usage tree",
    });
    await service.startThreadTurn(thread.id, "user-1", "Delegate");
    const parentThreadId = `thread-${thread.id}`;
    const parentTurnId = `codex-turn-${thread.id}`;
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: parentThreadId,
      turnId: parentTurnId,
      type: "SUBAGENT_ACTIVITY",
      payload: {
        itemId: "collab-token",
        agentThreadId: "agent-token",
        kind: "started",
        name: "Token child",
        role: "subagent",
        model: null,
        effort: null,
        status: "ACTIVE",
        resultSummary: null,
      },
    });
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: parentThreadId,
      turnId: parentTurnId,
      type: "TOKEN_USAGE_UPDATED",
      payload: tokenUsagePayload(100, 60, 10, 40, 8),
    } as TaskEventDraft);
    execution.emitTaskEvent({
      taskId: thread.id,
      threadId: "agent-token",
      turnId: "agent-turn-token",
      subagentThreadId: "agent-token",
      type: "TOKEN_USAGE_UPDATED",
      payload: tokenUsagePayload(50, 30, 5, 20, 4),
    } as TaskEventDraft);

    expect(await service.getMyUsage("user-1")).toMatchObject({
      tokenUsageStatus: "KNOWN",
      tokenUsage: {
        scope: "OWNED_THREAD_TREES",
        totalTokens: 150,
        inputTokens: 90,
        cachedInputTokens: 15,
        outputTokens: 60,
        reasoningOutputTokens: 12,
      },
      quota: {
        scope: "SHARED_CODEX_ACCOUNT",
        attributableToUser: false,
      },
    });
    expect(await service.getSubagent("agent-token", "user-1")).toMatchObject({
      tokenUsage: {
        totalTokens: 50,
        inputTokens: 30,
        outputTokens: 20,
      },
    });
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

  test("attributes a subagent approval to its parent Turn without losing child transport identity", async () => {
    const project = await service.createProject("user-1", { name: "Subagent approval" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Approval" });
    await service.startTurn(task.id, "user-1", "Delegate a protected change");
    const parentTurnId = `codex-turn-${task.id}`;
    const platformParentTurnId = (
      database.sqlite.prepare("SELECT id FROM turns WHERE task_id = ?").get(task.id) as {
        id: string;
      }
    ).id;

    execution.emitApproval({
      requestId: "child-approval-1",
      rawRpcId: "child-approval-1",
      accountId: "account-1",
      connectionGeneration: 3,
      taskId: task.id,
      threadId: "agent-thread-1",
      turnId: "agent-turn-1",
      parentTurnId,
      itemId: "child-command-1",
      approvalType: "COMMAND",
      payload: { reason: "run tests", command: "pnpm test", cwd: "/repo" },
    });
    execution.emitApproval({
      requestId: "child-approval-2",
      rawRpcId: "child-approval-2",
      accountId: "account-1",
      connectionGeneration: 3,
      taskId: task.id,
      threadId: "agent-thread-2",
      turnId: "agent-turn-2",
      parentTurnId,
      itemId: "child-command-2",
      approvalType: "COMMAND",
      payload: { reason: "run checks", command: "pnpm typecheck", cwd: "/repo" },
    });

    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "WAITING_APPROVAL",
    });
    const approvals = (await service.listApprovals(task.id, "user-1")) as Array<{
      id: string;
      turnId: string | null;
      parentTurnId: string | null;
      sourceThreadId: string;
    }>;
    expect(approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: null,
          parentTurnId: platformParentTurnId,
          sourceThreadId: "agent-thread-1",
        }),
        expect.objectContaining({
          turnId: null,
          parentTurnId: platformParentTurnId,
          sourceThreadId: "agent-thread-2",
        }),
      ]),
    );
    expect(await service.listTaskEvents(task.id, "user-1", 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "APPROVAL_REQUESTED",
          turnId: platformParentTurnId,
          payload: expect.objectContaining({
            sourceThreadId: "agent-thread-1",
            sourceSubagent: true,
          }),
        }),
      ]),
    );

    const firstApproval = approvals.find(
      (approval) => approval.sourceThreadId === "agent-thread-1",
    );
    const secondApproval = approvals.find(
      (approval) => approval.sourceThreadId === "agent-thread-2",
    );
    await service.decideApproval(firstApproval?.id ?? "missing", "user-1", "accept");
    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "WAITING_APPROVAL",
    });
    await service.decideApproval(secondApproval?.id ?? "missing", "user-1", "accept");
    expect(await service.getTask(task.id, "user-1")).toMatchObject({ status: "RUNNING" });
    expect(await service.listTaskEvents(task.id, "user-1", 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "APPROVAL_DECIDED",
          turnId: platformParentTurnId,
        }),
      ]),
    );
    expect(execution.respondApproval).toHaveBeenCalledWith(
      "child-approval-1",
      "accept",
      expect.objectContaining({
        transport: expect.objectContaining({
          threadId: "agent-thread-1",
          turnId: "agent-turn-1",
        }),
      }),
    );
    const firstDetail = await service.getSubagent("agent-thread-1", "user-1");
    expect(firstDetail?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: null,
          type: "APPROVAL_REQUESTED",
          payload: expect.objectContaining({
            sourceSubagent: true,
            sourceSubagentName: "agent-thread-1",
          }),
        }),
        expect.objectContaining({
          turnId: null,
          type: "APPROVAL_DECIDED",
          payload: expect.objectContaining({ decision: "accept" }),
        }),
      ]),
    );
    expect(JSON.stringify({ approvals, firstDetail })).not.toMatch(
      new RegExp(`codex-turn-${task.id}|agent-turn-[12]`),
    );
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
    const idempotentDecision = await service.decideApproval(approvalId, "user-1", "accept");
    expect(idempotentDecision).toMatchObject({
      status: "DELIVERED",
      decision: "accept",
    });
    expect(JSON.stringify(idempotentDecision)).not.toContain(`codex-turn-${task.id}`);
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

  test("coalesces overlapping quota refreshes for the same account", async () => {
    const quota = deferred<Awaited<ReturnType<TaskExecutionAdapter["refreshWeeklyQuota"]>>>();
    execution.refreshWeeklyQuota.mockImplementation(() => quota.promise);
    const staleAt = new Date(NOW.getTime() + 6 * 60_000);

    const firstMaintenance = service.runMaintenance(staleAt);
    const secondMaintenance = service.runMaintenance(staleAt);

    await vi.waitFor(() => expect(execution.refreshWeeklyQuota).toHaveBeenCalledTimes(1));
    quota.resolve({
      status: "KNOWN",
      limitId: "weekly",
      usedPercent: 28,
      remainingPercent: 72,
      windowDurationMins: 10_080,
      resetsAt: null,
    });
    await Promise.all([firstMaintenance, secondMaintenance]);

    expect(accounts.list()[0]).toMatchObject({
      status: "AVAILABLE",
      weeklyRemaining: 72,
    });
  });

  test("stores real-time account quota notifications with a fresh observation time", async () => {
    currentNow = new Date(NOW.getTime() + 90_000);

    execution.emit("accountQuotaUpdated", {
      accountId: "account-1",
      quota: {
        status: "KNOWN",
        limitId: "codex",
        usedPercent: 44,
        remainingPercent: 56,
        windowDurationMins: 10_080,
        resetsAt: 1_785_225_600,
      },
    });

    expect(accounts.list()[0]).toMatchObject({
      weeklyRemaining: 56,
      quotaUpdatedAt: currentNow.toISOString(),
    });
  });

  test("lets an administrator force a fresh account quota read", async () => {
    currentNow = new Date(NOW.getTime() + 120_000);
    execution.refreshWeeklyQuota.mockResolvedValueOnce({
      status: "KNOWN",
      limitId: "codex",
      usedPercent: 45,
      remainingPercent: 55,
      windowDurationMins: 10_080,
      resetsAt: 1_785_225_600,
    });

    await expect(service.refreshAccountQuotaNow("account-1", "user-1")).resolves.toMatchObject({
      weeklyRemaining: 55,
      quotaUpdatedAt: currentNow.toISOString(),
    });
    expect(execution.refreshWeeklyQuota).toHaveBeenCalledTimes(1);
  });

  test("keeps an authenticated account available after a transient quota refresh failure", async () => {
    execution.refreshWeeklyQuota.mockRejectedValueOnce(new Error("temporary network failure"));
    const staleAt = new Date(NOW.getTime() + 6 * 60_000);

    await service.runMaintenance(staleAt);

    expect(accounts.list()[0]).toMatchObject({
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
      weeklyRemaining: 80,
      quotaUpdatedAt: NOW.toISOString(),
    });
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

  test("queues an existing Thread when its bound account is unavailable instead of migrating it", async () => {
    const project = await service.createProject("user-1", { name: "Runtime affinity" });
    const task = await service.createTask("user-1", {
      projectId: project.id,
      title: "Pinned Task",
    });
    await service.startTurn(task.id, "user-1", "First Turn");
    execution.emitTaskEvent({
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });
    leases.addAccount({
      id: "account-2",
      alias: "Codex B",
      codexHome: "/tmp/codexplatform-test/account-2",
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
      maxActiveUsers: 4,
      weeklyRemaining: 100,
      quotaUpdatedAt: NOW,
      allowUnknownQuota: false,
      healthScore: 100,
    });
    leases.updateAccount("account-1", { status: "QUARANTINED" });

    await expect(service.startTurn(task.id, "user-1", "Second Turn")).resolves.toMatchObject({
      status: "QUEUED",
      reason: "NO_ELIGIBLE_ACCOUNT",
    });
    expect(execution.startTask).toHaveBeenCalledTimes(1);
    expect(
      database.sqlite
        .prepare(
          `SELECT required_account_id, status
           FROM queue_entries
           WHERE task_id = ? ORDER BY ticket DESC LIMIT 1`,
        )
        .get(task.id),
    ).toEqual({ required_account_id: "account-1", status: "WAITING" });
    expect(accounts.list().find((account) => account.id === "account-2")).toMatchObject({
      activeUsers: 0,
      activeTurns: 0,
    });
  });

  test("fails closed when an existing Thread has lost its runtime account binding", async () => {
    const project = await service.createProject("user-1", { name: "Missing affinity" });
    const task = await service.createTask("user-1", {
      projectId: project.id,
      title: "Pinned Task",
    });
    await service.startTurn(task.id, "user-1", "First Turn");
    execution.emitTaskEvent({
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });
    database.sqlite.prepare("UPDATE tasks SET account_id = NULL WHERE id = ?").run(task.id);

    await expect(service.startTurn(task.id, "user-1", "Second Turn")).rejects.toThrow(
      "Thread runtime account binding is missing",
    );
    expect(execution.startTask).toHaveBeenCalledTimes(1);
  });

  test("quarantines a typed active-resume conflict and releases its scheduler allocation", async () => {
    const project = await service.createProject("user-1", { name: "Active resume conflict" });
    const task = await service.createTask("user-1", {
      projectId: project.id,
      title: "Pinned Task",
    });
    await service.startTurn(task.id, "user-1", "First Turn");
    execution.emitTaskEvent({
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      type: "TURN_COMPLETED",
      payload: { status: "completed", durationMs: 10 },
    });
    execution.startTask.mockImplementationOnce(async () => {
      execution.emit("accountCrashed", {
        accountId: "account-1",
        reason: "Thread already has an active Turn; the new prompt was not accepted",
        sourceTaskId: task.id,
        sourceRuntimeTurnId: `codex-turn-${task.id}`,
      });
      throw new ActiveTurnResumeConflictError(`thread-${task.id}`, `codex-turn-${task.id}`);
    });

    await expect(service.startTurn(task.id, "user-1", "Second Turn")).rejects.toMatchObject({
      code: "ACTIVE_TURN_RESUME_CONFLICT",
      promptAccepted: false,
      rejoined: false,
    });
    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(accounts.list()[0]).toMatchObject({
      status: "QUARANTINED",
      activeTurns: 0,
    });
    const recoveryPayload = database.sqlite
      .prepare(
        `SELECT payload_json
         FROM task_events
         WHERE task_id = ? AND type = 'RECOVERY_REQUIRED'
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(task.id) as { payload_json: string };
    expect(JSON.parse(recoveryPayload.payload_json)).toEqual({
      reason: "Thread already has an active Turn; the new prompt was not accepted",
    });

    const anotherTask = await service.createTask("user-1", {
      projectId: project.id,
      title: "Must not run on quarantined account",
    });
    await expect(service.startTurn(anotherTask.id, "user-1", "Third Turn")).resolves.toMatchObject({
      status: "QUEUED",
      reason: "NO_ELIGIBLE_ACCOUNT",
    });
    expect(execution.startTask).toHaveBeenCalledTimes(2);
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

    execution.emit("accountCrashed", {
      accountId: "account-1",
      reason: "Codex App Server exited; recovery is required.",
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

  test("persists recovery events with only the public platform Turn id across every event view", async () => {
    const project = await service.createProject("user-1", { name: "Recovery projection" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Run once");
    const schedulerTurn = database.sqlite
      .prepare("SELECT id FROM turns WHERE task_id = ?")
      .get(task.id) as { id: string };
    const runtimeTurnId = `codex-turn-${task.id}`;

    execution.emit("accountCrashed", {
      accountId: "account-1",
      reason: "Codex App Server exited; recovery is required.",
      sourceTaskId: task.id,
      sourceRuntimeTurnId: runtimeTurnId,
    });

    const persisted = database.sqlite
      .prepare(
        `SELECT turn_id, payload_json
         FROM task_events
         WHERE task_id = ? AND type = 'RECOVERY_REQUIRED'`,
      )
      .get(task.id) as { turn_id: string | null; payload_json: string };
    expect(persisted).toEqual({
      turn_id: schedulerTurn.id,
      payload_json: JSON.stringify({
        reason: "Codex App Server exited; recovery is required.",
      }),
    });
    database.sqlite
      .prepare(
        `UPDATE task_events
         SET turn_id = ?, item_id = ?, payload_json = ?
         WHERE task_id = ? AND type = 'RECOVERY_REQUIRED'`,
      )
      .run(
        runtimeTurnId,
        `recovery_required:${runtimeTurnId}`,
        JSON.stringify({
          reason: "Codex App Server exited; recovery is required.",
          sourceRuntimeTurnId: runtimeTurnId,
        }),
        task.id,
      );

    const legacyEvents = (await service.listTaskEvents(task.id, "user-1", 0)) ?? [];
    const threadEvents = (await service.listThreadEvents(task.id, "user-1", 0)) ?? [];
    const thread = await service.getThread(task.id, "user-1");
    const serialized = JSON.stringify({
      legacyEvents,
      threadEvents,
      items: thread?.items,
      sse: legacyEvents.map((event) => encodeSse(event)).join(""),
    });
    expect(serialized).not.toContain("sourceRuntimeTurnId");
    expect(serialized).not.toContain(runtimeTurnId);
    for (const event of [...legacyEvents, ...threadEvents].filter(
      (candidate) => candidate.type === "RECOVERY_REQUIRED",
    )) {
      expect(event.turnId).toBe(schedulerTurn.id);
      expect(event.payload).toEqual({
        reason: "Codex App Server exited; recovery is required.",
      });
    }
    expect(thread?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: schedulerTurn.id,
          type: "RECOVERY_REQUIRED",
          payload: { reason: "Codex App Server exited; recovery is required." },
        }),
      ]),
    );
  });

  test("immediately recovers every active Turn on the intentionally stopped account", async () => {
    const project1 = await service.createProject("user-1", { name: "Crash user 1" });
    const project2 = await service.createProject("user-2", { name: "Crash user 2" });
    const task1 = await service.createTask("user-1", {
      projectId: project1.id,
      title: "Task 1",
    });
    const task2 = await service.createTask("user-2", {
      projectId: project2.id,
      title: "Task 2",
    });
    await service.startTurn(task1.id, "user-1", "Run one");
    await service.startTurn(task2.id, "user-2", "Run two");
    expect(accounts.list()[0]).toMatchObject({ activeTurns: 2 });

    execution.emit("accountCrashed", {
      accountId: "account-1",
      reason: "Unsafe resume forced an intentional account stop.",
    });

    expect(await service.getTask(task1.id, "user-1")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(await service.getTask(task2.id, "user-2")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(accounts.list()[0]).toMatchObject({
      status: "QUARANTINED",
      activeTurns: 0,
    });
    for (const [task, userId] of [
      [task1, "user-1"],
      [task2, "user-2"],
    ] as const) {
      expect(
        (await service.listTaskEvents(task.id, userId, 0))?.filter(
          (event) => event.type === "RECOVERY_REQUIRED",
        ),
      ).toHaveLength(1);
    }
  });

  test("releases an account Turn slot even when its scheduler record is missing", () => {
    expect(
      leases.acquireTurn({
        userId: "user-1",
        taskId: "damaged-task",
        turnId: "missing-scheduler-turn",
        now: NOW,
      }),
    ).toMatchObject({ kind: "LEASED", accountId: "account-1" });

    execution.emit("accountCrashed", {
      accountId: "account-1",
      reason: "Unsafe runtime state.",
    });

    expect(leases.getAccountOccupancy("account-1")).toMatchObject({ activeTurns: 0 });
    expect(leases.markAccountTurnsForRecovery("account-1")).toEqual([]);
  });

  test("recovers account tasks and approvals when the scheduler Turn record is missing", async () => {
    const project = await service.createProject("user-1", { name: "Damaged crash recovery" });
    const task = await service.createTask("user-1", { projectId: project.id, title: "Task" });
    await service.startTurn(task.id, "user-1", "Run once");
    execution.emitApproval({
      requestId: "damaged-approval",
      rawRpcId: 301,
      accountId: "account-1",
      connectionGeneration: 1,
      taskId: task.id,
      threadId: `thread-${task.id}`,
      turnId: `codex-turn-${task.id}`,
      itemId: "damaged-command",
      approvalType: "COMMAND",
      payload: { command: "pnpm publish" },
    });
    const schedulerTurn = database.sqlite
      .prepare("SELECT id FROM turns WHERE task_id = ?")
      .get(task.id) as { id: string };
    database.sqlite.prepare("DELETE FROM turns WHERE id = ?").run(schedulerTurn.id);

    execution.emit("accountCrashed", {
      accountId: "account-1",
      reason: "Unsafe runtime state.",
    });

    expect(await service.getTask(task.id, "user-1")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(await service.listApprovals(task.id, "user-1")).toEqual([
      expect.objectContaining({
        requestId: "damaged-approval",
        status: "RECOVERY_REQUIRED",
      }),
    ]);
    expect(leases.getAccountOccupancy("account-1")).toMatchObject({ activeTurns: 0 });
    expect(
      (await service.listTaskEvents(task.id, "user-1", 0))?.filter(
        (event) => event.type === "RECOVERY_REQUIRED",
      ),
    ).toEqual([
      expect.objectContaining({
        turnId: null,
        payload: { reason: "Unsafe runtime state." },
      }),
    ]);
  });

  test("quarantines a crashed Codex account before another task can be assigned", async () => {
    execution.emit("accountCrashed", { accountId: "account-1" });

    expect(accounts.list()[0]).toMatchObject({ status: "QUARANTINED" });
  });
});

class FakeExecution extends EventEmitter implements TaskExecutionAdapter {
  readonly listModels = vi.fn<TaskExecutionAdapter["listModels"]>(async () => [STANDARD_MODEL]);
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
  readonly refreshWeeklyQuota = vi.fn<TaskExecutionAdapter["refreshWeeklyQuota"]>(async () => ({
    status: "WEEKLY_QUOTA_UNKNOWN" as const,
  }));

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

function tokenUsagePayload(
  totalTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
) {
  return {
    total: {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    },
    last: {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    },
    modelContextWindow: 200_000,
  };
}
