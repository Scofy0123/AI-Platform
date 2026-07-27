import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { SQLiteLeaseStore } from "../../domain/lease-store.js";
import { migrateDatabase } from "./migrate.js";

const NOW = new Date("2026-07-21T08:00:00.000Z");

describe("migrateDatabase", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  test("upgrades the scheduler-era account table without deleting existing accounts", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE codex_accounts (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        status TEXT NOT NULL,
        auth_status TEXT NOT NULL,
        max_active_users INTEGER NOT NULL,
        weekly_remaining REAL,
        quota_updated_at INTEGER,
        allow_unknown_quota INTEGER NOT NULL,
        health_score INTEGER NOT NULL,
        last_assigned_at INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO codex_accounts (
        id, alias, status, auth_status, max_active_users, weekly_remaining,
        allow_unknown_quota, health_score, created_at
      ) VALUES ('account-1', 'Codex A', 'REAUTH_REQUIRED', 'UNAUTHENTICATED', 4, NULL, 0, 100, 1);
    `);

    migrateDatabase(database);

    const columns = database.pragma("table_info(codex_accounts)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["codex_home", "quota_resets_at"]),
    );
    expect(database.prepare("SELECT id, alias FROM codex_accounts").all()).toEqual([
      { id: "account-1", alias: "Codex A" },
    ]);
  });

  test("adds 1.1 Thread config snapshots to legacy task tables idempotently", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        queue_ticket INTEGER,
        account_id TEXT,
        account_alias TEXT,
        lease_id TEXT,
        thread_id TEXT,
        current_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        codex_turn_id TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER
      );
    `);

    migrateDatabase(database);
    migrateDatabase(database);

    const taskColumns = database.pragma("table_info(tasks)") as Array<{ name: string }>;
    const turnColumns = database.pragma("table_info(turns)") as Array<{ name: string }>;
    expect(taskColumns.map((column) => column.name)).toContain("thread_config_json");
    expect(turnColumns.map((column) => column.name)).toContain("config_snapshot_json");
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_token_usage'",
        )
        .get(),
    ).toEqual({ name: "thread_token_usage" });
  });

  test("adds nullable local archive state to legacy tasks without changing existing rows", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        queue_ticket INTEGER,
        account_id TEXT,
        account_alias TEXT,
        lease_id TEXT,
        thread_id TEXT,
        current_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO tasks (
        id, project_id, owner_id, title, status, created_at, updated_at
      ) VALUES ('task-1', 'project-1', 'user-1', 'Existing thread', 'COMPLETED', 1, 2);
    `);

    migrateDatabase(database);
    migrateDatabase(database);

    const columns = database.pragma("table_info(tasks)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("archived_at");
    expect(database.prepare("SELECT id, archived_at FROM tasks").all()).toEqual([
      { id: "task-1", archived_at: null },
    ]);
  });

  test("adds nullable required account affinity to legacy queue entries idempotently", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        queue_ticket INTEGER,
        account_id TEXT,
        account_alias TEXT,
        lease_id TEXT,
        thread_id TEXT,
        current_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE queue_entries (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        assigned_at INTEGER,
        account_id TEXT,
        lease_id TEXT
      );
      INSERT INTO tasks (
        id, project_id, owner_id, title, status, account_id, thread_id, created_at, updated_at
      ) VALUES
        ('task-bound', 'project-1', 'user-1', 'Bound', 'QUEUED',
          'account-1', 'runtime-thread-1', 1, 1),
        ('task-new', 'project-1', 'user-1', 'New', 'QUEUED',
          'account-2', NULL, 1, 1);
      INSERT INTO queue_entries (
        user_id, task_id, turn_id, reason, status, enqueued_at
      ) VALUES
        ('user-1', 'task-bound', 'turn-bound', 'NO_ELIGIBLE_ACCOUNT', 'WAITING', 1),
        ('user-1', 'task-new', 'turn-new', 'NO_ELIGIBLE_ACCOUNT', 'WAITING', 2);
    `);

    migrateDatabase(database);
    migrateDatabase(database);

    const columns = database.pragma("table_info(queue_entries)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("required_account_id");
    expect(
      database
        .prepare("SELECT turn_id, required_account_id FROM queue_entries ORDER BY ticket")
        .all(),
    ).toEqual([
      { turn_id: "turn-bound", required_account_id: "account-1" },
      { turn_id: "turn-new", required_account_id: null },
    ]);
  });

  test("promotes an upgraded waiting Thread only on its backfilled runtime account", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        queue_ticket INTEGER,
        account_id TEXT,
        account_alias TEXT,
        lease_id TEXT,
        thread_id TEXT,
        current_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE queue_entries (
        ticket INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        assigned_at INTEGER,
        account_id TEXT,
        lease_id TEXT
      );
      INSERT INTO tasks (
        id, project_id, owner_id, title, status, account_id, thread_id, created_at, updated_at
      ) VALUES (
        'task-bound', 'project-1', 'user-1', 'Bound', 'QUEUED',
        'thread-account', 'runtime-thread-1', 1, 1
      );
      INSERT INTO queue_entries (
        user_id, task_id, turn_id, reason, status, enqueued_at
      ) VALUES (
        'user-1', 'task-bound', 'turn-bound', 'NO_ELIGIBLE_ACCOUNT', 'WAITING', 1
      );
    `);
    migrateDatabase(database);
    const leases = new SQLiteLeaseStore(database);
    leases.addAccount({
      id: "thread-account",
      alias: "Thread Account",
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
      maxActiveUsers: 4,
      weeklyRemaining: 10,
      quotaUpdatedAt: NOW,
      allowUnknownQuota: false,
      healthScore: 100,
    });
    leases.addAccount({
      id: "higher-quota-account",
      alias: "Higher Quota",
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
      maxActiveUsers: 4,
      weeklyRemaining: 90,
      quotaUpdatedAt: NOW,
      allowUnknownQuota: false,
      healthScore: 100,
    });

    expect(leases.promoteQueue(NOW)).toEqual([
      expect.objectContaining({
        taskId: "task-bound",
        turnId: "turn-bound",
        accountId: "thread-account",
      }),
    ]);
  });

  test("rebuilds legacy approvals without losing rows, custom indexes, or task foreign keys", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.pragma("foreign_keys = ON");
    migrateDatabase(database);
    database.exec(`
      DROP TABLE approvals;
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        approval_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        decision TEXT,
        requested_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT REFERENCES users(id)
      );
      CREATE INDEX approvals_status_idx ON approvals(status, requested_at);
      INSERT INTO users (
        id, tenant_key, open_id, name, role, created_at, updated_at
      ) VALUES ('user-1', 'tenant-1', 'ou_1', 'User', 'ADMIN', 1, 1);
      INSERT INTO projects (id, owner_id, name, created_at, updated_at)
      VALUES ('project-1', 'user-1', 'Project', 1, 1);
      INSERT INTO tasks (id, project_id, owner_id, title, status, created_at, updated_at)
      VALUES ('task-1', 'project-1', 'user-1', 'Task', 'RUNNING', 1, 1);
      INSERT INTO approvals (
        id, request_id, task_id, turn_id, item_id, approval_type, status,
        payload_json, requested_at
      ) VALUES ('approval-1', '7', 'task-1', 'turn-1', 'item-1', 'FILE_CHANGE',
        'PENDING', '{"reason":"write"}', 1);
    `);

    migrateDatabase(database);

    const columns = database.pragma("table_info(approvals)") as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "raw_request_id_json",
        "transport_account_id",
        "connection_generation",
        "thread_id",
        "parent_turn_id",
      ]),
    );
    expect(database.prepare("SELECT id, request_id, payload_json FROM approvals").all()).toEqual([
      { id: "approval-1", request_id: "7", payload_json: '{"reason":"write"}' },
    ]);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).toEqual(
      expect.arrayContaining([{ name: "approvals_status_idx" }]),
    );
    expect(database.pragma("foreign_key_list(approvals)")).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: "tasks", from: "task_id" })]),
    );
    expect(database.pragma("foreign_key_check")).toEqual([]);

    expect(() =>
      database
        .prepare(
          `INSERT INTO approvals (
            id, request_id, task_id, turn_id, item_id, approval_type, status,
            payload_json, requested_at
          ) VALUES ('approval-2', '7', 'task-1', 'turn-2', 'item-2', 'FILE_CHANGE',
            'PENDING', '{}', 2)`,
        )
        .run(),
    ).not.toThrow();

    migrateDatabase(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM approvals").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).toEqual(
      expect.arrayContaining([{ name: "approvals_status_idx" }]),
    );
  });

  test("idempotently adds 1.1 user settings, subagent state and event item boundaries", () => {
    const database = new Database(":memory:");
    databases.push(database);

    migrateDatabase(database);
    migrateDatabase(database);

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(["user_settings", "subagent_threads", "subagent_events"]),
    );
    expect(
      (database.pragma("table_info(task_events)") as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toContain("item_id");
    expect(
      (database.pragma("table_info(subagent_threads)") as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "thread_id",
        "parent_task_id",
        "parent_thread_id",
        "parent_turn_id",
        "owner_id",
        "status",
        "result_summary",
      ]),
    );
  });
});
