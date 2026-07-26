import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { migrateDatabase } from "./migrate.js";

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
});
