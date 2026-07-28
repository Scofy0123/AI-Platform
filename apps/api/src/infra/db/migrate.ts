import type Database from "better-sqlite3";

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS codex_accounts (
  id TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  codex_home TEXT,
  status TEXT NOT NULL,
  auth_status TEXT NOT NULL,
  max_active_users INTEGER NOT NULL DEFAULT 4 CHECK(max_active_users > 0),
  weekly_remaining REAL,
  quota_updated_at INTEGER,
  quota_resets_at INTEGER,
  allow_unknown_quota INTEGER NOT NULL DEFAULT 0 CHECK(allow_unknown_quota IN (0, 1)),
  health_score INTEGER NOT NULL DEFAULT 100,
  last_assigned_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_slots (
  account_id TEXT NOT NULL REFERENCES codex_accounts(id) ON DELETE CASCADE,
  slot_index INTEGER NOT NULL,
  user_id TEXT,
  lease_id TEXT,
  claimed_at INTEGER,
  last_activity_at INTEGER,
  PRIMARY KEY(account_id, slot_index),
  UNIQUE(account_id, user_id)
);

CREATE TABLE IF NOT EXISTS account_leases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES codex_accounts(id),
  user_id TEXT NOT NULL,
  slot_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT
);

CREATE INDEX IF NOT EXISTS account_leases_active_idx
  ON account_leases(account_id, user_id, status);

CREATE TABLE IF NOT EXISTS user_turn_slots (
  account_id TEXT NOT NULL REFERENCES codex_accounts(id),
  user_id TEXT NOT NULL,
  slot_index INTEGER NOT NULL CHECK(slot_index IN (0, 1)),
  task_id TEXT NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, user_id, slot_index)
);

CREATE TABLE IF NOT EXISTS queue_entries (
  ticket INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  required_account_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  assigned_at INTEGER,
  account_id TEXT,
  lease_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS queue_entries_waiting_turn_unique
  ON queue_entries(turn_id) WHERE status = 'WAITING';

CREATE INDEX IF NOT EXISTS queue_entries_fifo_idx
  ON queue_entries(status, ticket);

CREATE TABLE IF NOT EXISTS turn_duration_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
  completed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  open_id TEXT NOT NULL,
  union_id TEXT,
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL CHECK(role IN ('ADMIN', 'MEMBER')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_key, open_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  token_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CONNECTED'
    CHECK(status IN ('CONNECTED', 'REFRESHING', 'REAUTH_REQUIRED')),
  last_refresh_error_code TEXT,
  reauth_required_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  persistent_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS sessions_user_active_idx
  ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  queue_ticket INTEGER,
  account_id TEXT,
  account_alias TEXT,
  lease_id TEXT,
  thread_id TEXT,
  current_turn_id TEXT,
  thread_config_json TEXT,
  archived_at INTEGER,
  lifecycle_state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK(lifecycle_state IN ('DRAFT', 'ACTIVE', 'EXPIRED')),
  draft_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_owner_updated_idx ON tasks(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  codex_turn_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  config_snapshot_json TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS draft_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('FILE', 'FOLDER')),
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  file_count INTEGER NOT NULL CHECK(file_count BETWEEN 1 AND 500),
  scan_status TEXT NOT NULL
    CHECK(scan_status IN ('UPLOADING', 'SCANNING', 'READY', 'BLOCKED', 'FAILED')),
  blocked_reason TEXT,
  claimed_turn_id TEXT REFERENCES turns(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS draft_attachments_task_idx
  ON draft_attachments(task_id, created_at);

CREATE TABLE IF NOT EXISTS turn_input_snapshots (
  turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS steer_input_snapshots (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(delivery_status IN ('PENDING', 'DELIVERED', 'FAILED')),
  delivery_error TEXT,
  delivered_at INTEGER,
  failed_at INTEGER,
  captured_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS steer_input_snapshots_turn_idx
  ON steer_input_snapshots(turn_id, captured_at, id);

CREATE TABLE IF NOT EXISTS attachment_cleanup_jobs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(thread_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS attachment_cleanup_jobs_status_idx
  ON attachment_cleanup_jobs(status, created_at, id);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  thread_id TEXT,
  turn_id TEXT,
  item_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, sequence)
);

CREATE INDEX IF NOT EXISTS task_events_replay_idx ON task_events(task_id, sequence);

CREATE TABLE IF NOT EXISTS subagent_threads (
  thread_id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_thread_id TEXT,
  parent_turn_id TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  status TEXT NOT NULL,
  result_summary TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS subagent_threads_parent_status_idx
  ON subagent_threads(parent_task_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS subagent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES subagent_threads(thread_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  turn_id TEXT,
  item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, sequence)
);

CREATE INDEX IF NOT EXISTS subagent_events_replay_idx
  ON subagent_events(thread_id, sequence);

CREATE TABLE IF NOT EXISTS thread_token_usage (
  runtime_thread_id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_runtime_thread_id TEXT,
  turn_id TEXT,
  total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0),
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK(cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  reasoning_output_tokens INTEGER NOT NULL CHECK(reasoning_output_tokens >= 0),
  last_total_tokens INTEGER NOT NULL CHECK(last_total_tokens >= 0),
  last_input_tokens INTEGER NOT NULL CHECK(last_input_tokens >= 0),
  last_cached_input_tokens INTEGER NOT NULL CHECK(last_cached_input_tokens >= 0),
  last_output_tokens INTEGER NOT NULL CHECK(last_output_tokens >= 0),
  last_reasoning_output_tokens INTEGER NOT NULL CHECK(last_reasoning_output_tokens >= 0),
  model_context_window INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS thread_token_usage_task_idx
  ON thread_token_usage(parent_task_id, runtime_thread_id);

CREATE INDEX IF NOT EXISTS thread_token_usage_owner_idx
  ON thread_token_usage(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  raw_request_id_json TEXT,
  transport_account_id TEXT,
  connection_generation INTEGER,
  thread_id TEXT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  parent_turn_id TEXT,
  item_id TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  decision TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  tool TEXT NOT NULL,
  status TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  output_digest TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  account_id TEXT,
  account_alias TEXT,
  lease_id TEXT,
  task_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  tool_call_id TEXT,
  approval_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_actor_created_idx
  ON audit_events(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function migrateDatabase(sqlite: Database.Database): void {
  sqlite.exec(INITIAL_SCHEMA);
  ensureColumn(sqlite, "codex_accounts", "codex_home", "TEXT");
  ensureColumn(sqlite, "codex_accounts", "quota_resets_at", "INTEGER");
  ensureColumn(sqlite, "task_events", "item_id", "TEXT");
  ensureColumn(sqlite, "tasks", "thread_config_json", "TEXT");
  ensureColumn(sqlite, "tasks", "archived_at", "INTEGER");
  ensureColumn(sqlite, "tasks", "lifecycle_state", "TEXT NOT NULL DEFAULT 'ACTIVE'");
  ensureColumn(sqlite, "tasks", "draft_expires_at", "INTEGER");
  sqlite.exec(
    `CREATE INDEX IF NOT EXISTS tasks_owner_archived_updated_idx
       ON tasks(owner_id, archived_at, updated_at DESC)`,
  );
  ensureColumn(sqlite, "turns", "config_snapshot_json", "TEXT");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS draft_attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('FILE', 'FOLDER')),
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      file_count INTEGER NOT NULL CHECK(file_count BETWEEN 1 AND 500),
      scan_status TEXT NOT NULL
        CHECK(scan_status IN ('UPLOADING', 'SCANNING', 'READY', 'BLOCKED', 'FAILED')),
      blocked_reason TEXT,
      claimed_turn_id TEXT REFERENCES turns(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS draft_attachments_task_idx
      ON draft_attachments(task_id, created_at);
    CREATE TABLE IF NOT EXISTS turn_input_snapshots (
      turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      captured_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steer_input_snapshots (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      delivery_status TEXT NOT NULL DEFAULT 'PENDING',
      delivery_error TEXT,
      delivered_at INTEGER,
      failed_at INTEGER,
      captured_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS steer_input_snapshots_turn_idx
      ON steer_input_snapshots(turn_id, captured_at, id);
    CREATE TABLE IF NOT EXISTS attachment_cleanup_jobs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(thread_id, attachment_id)
    );
    CREATE INDEX IF NOT EXISTS attachment_cleanup_jobs_status_idx
      ON attachment_cleanup_jobs(status, created_at, id);
  `);
  ensureColumn(
    sqlite,
    "steer_input_snapshots",
    "delivery_status",
    "TEXT NOT NULL DEFAULT 'PENDING'",
  );
  ensureColumn(sqlite, "steer_input_snapshots", "delivery_error", "TEXT");
  ensureColumn(sqlite, "steer_input_snapshots", "delivered_at", "INTEGER");
  ensureColumn(sqlite, "steer_input_snapshots", "failed_at", "INTEGER");
  ensureColumn(sqlite, "queue_entries", "required_account_id", "TEXT");
  ensureColumn(sqlite, "sessions", "persistent_at", "INTEGER");
  ensureColumn(sqlite, "feishu_credentials", "status", "TEXT NOT NULL DEFAULT 'CONNECTED'");
  ensureColumn(sqlite, "feishu_credentials", "last_refresh_error_code", "TEXT");
  ensureColumn(sqlite, "feishu_credentials", "reauth_required_at", "INTEGER");
  backfillQueuedThreadAccountAffinity(sqlite);
  backfillTaskEventItemIds(sqlite);
  migrateApprovalsTable(sqlite);
}

function backfillQueuedThreadAccountAffinity(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `UPDATE queue_entries
       SET required_account_id = (
         SELECT tasks.account_id
         FROM tasks
         WHERE tasks.id = queue_entries.task_id
           AND tasks.thread_id IS NOT NULL
           AND tasks.account_id IS NOT NULL
       )
       WHERE status = 'WAITING'
         AND required_account_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM tasks
           WHERE tasks.id = queue_entries.task_id
             AND tasks.thread_id IS NOT NULL
             AND tasks.account_id IS NOT NULL
         )`,
    )
    .run();
}

function migrateApprovalsTable(sqlite: Database.Database): void {
  const columns = sqlite.pragma("table_info(approvals)") as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const indexes = sqlite.pragma("index_list(approvals)") as Array<{
    name: string;
    unique: number;
  }>;
  const globallyUniqueRequestIndexes = new Set(
    indexes
      .filter((index) => index.unique === 1)
      .filter((index) => {
        const indexedColumns = sqlite
          .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .all(index.name) as Array<{ name: string }>;
        return indexedColumns.length === 1 && indexedColumns[0]?.name === "request_id";
      })
      .map((index) => index.name),
  );
  const requiredColumns = [
    "raw_request_id_json",
    "transport_account_id",
    "connection_generation",
    "thread_id",
    "parent_turn_id",
  ];
  if (
    requiredColumns.every((column) => columnNames.has(column)) &&
    globallyUniqueRequestIndexes.size === 0
  ) {
    return;
  }

  const customIndexSql = (
    sqlite
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'approvals' AND sql IS NOT NULL`,
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .filter((index) => !globallyUniqueRequestIndexes.has(index.name))
    .map((index) => index.sql);
  const source = (column: string, fallback: string) =>
    columnNames.has(column) ? column : fallback;

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(`
      CREATE TABLE approvals_migrated (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        raw_request_id_json TEXT,
        transport_account_id TEXT,
        connection_generation INTEGER,
        thread_id TEXT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        parent_turn_id TEXT,
        item_id TEXT NOT NULL,
        approval_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        decision TEXT,
        requested_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT REFERENCES users(id)
      );
      INSERT INTO approvals_migrated (
        id, request_id, raw_request_id_json, transport_account_id,
        connection_generation, thread_id, task_id, turn_id, parent_turn_id, item_id, approval_type,
        status, payload_json, decision, requested_at, decided_at, decided_by
      )
      SELECT
        id, request_id,
        ${source("raw_request_id_json", "NULL")},
        ${source("transport_account_id", "NULL")},
        ${source("connection_generation", "NULL")},
        ${source("thread_id", "NULL")},
        task_id, turn_id,
        ${source("parent_turn_id", "turn_id")},
        item_id, approval_type, status, payload_json, decision,
        requested_at, decided_at, decided_by
      FROM approvals;
      DROP TABLE approvals;
      ALTER TABLE approvals_migrated RENAME TO approvals;
    `);
    for (const sql of customIndexSql) sqlite.exec(sql);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

function ensureColumn(
  sqlite: Database.Database,
  table:
    | "codex_accounts"
    | "queue_entries"
    | "task_events"
    | "tasks"
    | "turns"
    | "sessions"
    | "feishu_credentials"
    | "steer_input_snapshots",
  column:
    | "codex_home"
    | "quota_resets_at"
    | "required_account_id"
    | "item_id"
    | "thread_config_json"
    | "archived_at"
    | "lifecycle_state"
    | "draft_expires_at"
    | "config_snapshot_json"
    | "persistent_at"
    | "status"
    | "last_refresh_error_code"
    | "reauth_required_at"
    | "delivery_status"
    | "delivery_error"
    | "delivered_at"
    | "failed_at",
  definition:
    | "TEXT"
    | "INTEGER"
    | "TEXT NOT NULL DEFAULT 'CONNECTED'"
    | "TEXT NOT NULL DEFAULT 'ACTIVE'"
    | "TEXT NOT NULL DEFAULT 'PENDING'",
): void {
  const columns = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function backfillTaskEventItemIds(sqlite: Database.Database): void {
  const rows = sqlite
    .prepare(
      `SELECT id, task_id, turn_id, type, payload_json
       FROM task_events WHERE item_id IS NULL`,
    )
    .all() as Array<{
    id: number;
    task_id: string;
    turn_id: string | null;
    type: string;
    payload_json: string;
  }>;
  const update = sqlite.prepare("UPDATE task_events SET item_id = ? WHERE id = ?");
  for (const row of rows) {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Legacy malformed payloads retain an event-scoped boundary and are not
      // interpreted further.
    }
    update.run(deriveEventItemId(row.task_id, row.turn_id, row.type, payload), row.id);
  }
}

function deriveEventItemId(
  taskId: string,
  turnId: string | null,
  type: string,
  payload: Record<string, unknown>,
): string {
  if (typeof payload.itemId === "string" && payload.itemId.length > 0) return payload.itemId;
  if (type === "PLAN_UPDATED") return `plan:${turnId ?? taskId}`;
  if (type === "DIFF_UPDATED") return `diff:${turnId ?? taskId}`;
  if (type === "QUEUED") return `queue:${taskId}`;
  if (type === "APPROVAL_DECIDED" && typeof payload.approvalId === "string") {
    return `approval:${payload.approvalId}`;
  }
  if (type.startsWith("TURN_")) return `turn:${turnId ?? taskId}`;
  return `${type.toLowerCase()}:${turnId ?? taskId}`;
}
