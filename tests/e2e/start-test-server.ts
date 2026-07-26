import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eApi, e2eApiUrl, e2eWeb, e2eWebUrl } from "./config.js";
import {
  type E2eIdentity,
  e2eCanaries,
  e2eIdentity,
  e2eMemberIdentity,
  seededFixture,
} from "./identity.js";

const apiPort = e2eApi.port;
const webPort = e2eWeb.port;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testDataDirectory = await mkdtemp(join(tmpdir(), "codexplatform-e2e-"));
const databasePath = join(testDataDirectory, "codexplatform.sqlite");
const runtimeDataDirectory = join(testDataDirectory, "runtime");
const children: ChildProcess[] = [];
let shuttingDown = false;
let requestedExitCode: number | null = null;
let finish: ((exitCode: number) => void) | undefined;

const finished = new Promise<number>((resolveFinished) => {
  finish = resolveFinished;
});

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("SIGHUP", () => void shutdown(0));

try {
  const api = launch("api", ["--filter", "@codexplatform/api", "exec", "tsx", "src/index.ts"], {
    NODE_ENV: "test",
    HOST: e2eApi.hostname,
    PORT: apiPort,
    WEB_ORIGIN: e2eWebUrl,
    DATABASE_PATH: databasePath,
    RUNTIME_DATA_DIR: runtimeDataDirectory,
    RUNTIME_MODE: "fake",
    FEISHU_APP_ID: "cli_e2e_fake",
    FEISHU_APP_SECRET: e2eCanaries.credentialSecret,
    FEISHU_TENANT_KEY: e2eIdentity.tenantKey,
    FEISHU_ADMIN_OPEN_IDS: e2eIdentity.openId,
    FEISHU_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  children.push(api);
  await waitForHttp(`${e2eApiUrl}/api/health`);
  seedTestData(databasePath);

  const web = launch(
    "web",
    [
      "--filter",
      "@codexplatform/web",
      "exec",
      "vite",
      "--host",
      e2eWeb.hostname,
      "--port",
      webPort,
      "--strictPort",
    ],
    {
      NODE_ENV: "test",
      CODEXPLATFORM_API_ORIGIN: e2eApiUrl,
    },
  );
  children.push(web);
  await waitForHttp(e2eWebUrl);
  process.stdout.write(`[e2e] isolated Fake Runtime is ready at ${e2eWebUrl}\n`);

  const exitCode = await finished;
  await stopChildren();
  await rm(testDataDirectory, { recursive: true, force: true });
  process.exitCode = exitCode;
} catch (error) {
  if (requestedExitCode === null) {
    process.stderr.write(`[e2e] failed to start: ${safeMessage(error)}\n`);
  }
  await stopChildren();
  await rm(testDataDirectory, { recursive: true, force: true });
  process.exitCode = requestedExitCode ?? 1;
}

function launch(name: string, args: string[], environment: NodeJS.ProcessEnv): ChildProcess {
  assertNotShuttingDown();
  const child = spawn("pnpm", args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    detached: process.platform !== "win32",
    stdio: "inherit",
  });
  child.once("error", (error) => {
    process.stderr.write(`[e2e:${name}] ${safeMessage(error)}\n`);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `[e2e:${name}] exited before the test finished (code=${code ?? "null"}, signal=${signal ?? "none"})\n`,
    );
    void shutdown(1);
  });
  return child;
}

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertNotShuttingDown();
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child process is still booting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function assertNotShuttingDown(): void {
  if (shuttingDown) throw new Error("E2E server startup was cancelled");
}

function seedTestData(path: string): void {
  interface Statement {
    run(...parameters: unknown[]): unknown;
  }
  interface SqliteDatabase {
    prepare(sql: string): Statement;
    close(): void;
  }
  interface SqliteConstructor {
    new (filename: string): SqliteDatabase;
  }

  const requireFromApi = createRequire(join(repositoryRoot, "apps/api/package.json"));
  const Database = requireFromApi("better-sqlite3") as SqliteConstructor;
  const sqlite = new Database(path);
  const now = Date.now();

  try {
    seedIdentity(sqlite, e2eIdentity, now);
    seedIdentity(sqlite, e2eMemberIdentity, now);
    seedPrivateThreadTree(sqlite, now);
    sqlite
      .prepare("UPDATE codex_accounts SET alias = ?, codex_home = ?")
      .run(e2eCanaries.accountAlias, `/tmp/${e2eCanaries.codexHome}`);
  } finally {
    sqlite.close();
  }
}

function seedIdentity(
  sqlite: { prepare(sql: string): { run(...parameters: unknown[]): unknown } },
  identity: E2eIdentity,
  now: number,
): void {
  sqlite
    .prepare(
      `INSERT INTO users (
        id, tenant_key, open_id, union_id, name, avatar_url, role, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
    )
    .run(
      identity.userId,
      identity.tenantKey,
      identity.openId,
      identity.name,
      identity.role,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO sessions (
        id, token_hash, csrf_hash, user_id, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      `e2e-session-${identity.role.toLowerCase()}`,
      hash(identity.sessionToken),
      hash(identity.csrfToken),
      identity.userId,
      now,
      now + 60 * 60_000,
    );
}

function seedPrivateThreadTree(
  sqlite: { prepare(sql: string): { run(...parameters: unknown[]): unknown } },
  now: number,
): void {
  const configSnapshot = JSON.stringify({
    model: null,
    reasoningEffort: "MEDIUM",
    permissionMode: "DEFAULT",
    approvalMode: "ASK",
    personality: "PRAGMATIC",
    instructions: "",
    sourceVersion: "e2e-seed-v1",
  });
  sqlite
    .prepare(
      `INSERT INTO projects (id, owner_id, name, created_at, updated_at)
       VALUES (?, ?, 'E2E private project', ?, ?)`,
    )
    .run(seededFixture.projectId, e2eIdentity.userId, now, now);
  sqlite
    .prepare(
      `INSERT INTO tasks (
        id, project_id, owner_id, title, status, account_id, account_alias, thread_id,
        current_turn_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'E2E seeded private Thread', 'COMPLETED', 'primary-codex',
        ?, ?, ?, ?, ?)`,
    )
    .run(
      seededFixture.threadId,
      seededFixture.projectId,
      e2eIdentity.userId,
      e2eCanaries.accountAlias,
      seededFixture.runtimeThreadId,
      seededFixture.turnId,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO turns (
        id, task_id, codex_turn_id, prompt, status, config_snapshot_json,
        started_at, completed_at, duration_ms
      ) VALUES (?, ?, 'e2e-private-runtime-turn', 'Seed private fixture', 'COMPLETED', ?, ?, ?, 5)`,
    )
    .run(seededFixture.turnId, seededFixture.threadId, configSnapshot, now - 10, now - 5);
  sqlite
    .prepare(
      `INSERT INTO task_events (
        task_id, sequence, thread_id, turn_id, item_id, type, payload_json, created_at
      ) VALUES (?, 1, ?, 'e2e-private-runtime-turn', 'e2e-private-steer',
        'USER_MESSAGE', ?, ?)`,
    )
    .run(
      seededFixture.threadId,
      seededFixture.runtimeThreadId,
      JSON.stringify({
        itemId: "e2e-private-steer",
        kind: "STEER",
        text: "E2E persisted steer instruction",
      }),
      now - 7,
    );
  sqlite
    .prepare(
      `INSERT INTO task_events (
        task_id, sequence, thread_id, turn_id, item_id, type, payload_json, created_at
      ) VALUES (?, 2, ?, 'e2e-private-runtime-turn', 'e2e-private-message',
        'AGENT_MESSAGE_DELTA', ?, ?)`,
    )
    .run(
      seededFixture.threadId,
      seededFixture.runtimeThreadId,
      JSON.stringify({
        itemId: "e2e-private-message",
        delta: "Seeded safe user-visible summary",
        accountAlias: e2eCanaries.accountAlias,
        reasoningTextDelta: e2eCanaries.rawReasoning,
        encrypted_content: e2eCanaries.encryptedReasoning,
      }),
      now - 6,
    );
  sqlite
    .prepare(
      `INSERT INTO task_events (
        task_id, sequence, thread_id, turn_id, item_id, type, payload_json, created_at
      ) VALUES (?, 3, ?, 'e2e-private-runtime-turn', 'e2e-private-turn-complete',
        'TURN_COMPLETED', '{"status":"completed","durationMs":5}', ?)`,
    )
    .run(seededFixture.threadId, seededFixture.runtimeThreadId, now - 5);
  seedQueuedThread(sqlite, configSnapshot, now);

  seedSubagent(sqlite, {
    threadId: seededFixture.activeSubagentId,
    status: "ACTIVE",
    name: "E2E active researcher",
    summary: "Inspecting current evidence",
    completedAt: null,
    now,
  });
  seedSubagent(sqlite, {
    threadId: seededFixture.doneSubagentId,
    status: "DONE",
    name: "E2E completed reviewer",
    summary: "Review completed without findings",
    completedAt: now - 1,
    now,
  });
  sqlite
    .prepare(
      `INSERT INTO subagent_events (
        thread_id, sequence, turn_id, item_id, type, payload_json, created_at
      ) VALUES (?, 1, 'e2e-subagent-turn', 'e2e-subagent-message',
        'AGENT_MESSAGE_DELTA', ?, ?)`,
    )
    .run(
      seededFixture.doneSubagentId,
      JSON.stringify({
        itemId: "e2e-subagent-message",
        delta: "Subagent visible detail canary",
      }),
      now - 2,
    );
}

function seedQueuedThread(
  sqlite: { prepare(sql: string): { run(...parameters: unknown[]): unknown } },
  configSnapshot: string,
  now: number,
): void {
  const ticket = 9_001;
  sqlite
    .prepare(
      `INSERT INTO tasks (
        id, project_id, owner_id, title, status, queue_ticket, created_at, updated_at
      ) VALUES (?, ?, ?, 'E2E queued Thread', 'QUEUED', ?, ?, ?)`,
    )
    .run(
      seededFixture.queuedThreadId,
      seededFixture.projectId,
      e2eIdentity.userId,
      ticket,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO turns (
        id, task_id, prompt, status, config_snapshot_json, started_at
      ) VALUES (?, ?, 'E2E queued prompt', 'QUEUED', ?, ?)`,
    )
    .run(seededFixture.queuedTurnId, seededFixture.queuedThreadId, configSnapshot, now);
  sqlite
    .prepare(
      `INSERT INTO queue_entries (
        ticket, user_id, task_id, turn_id, required_account_id, reason, status, enqueued_at
      ) VALUES (?, ?, ?, ?, 'e2e-unavailable-account', 'E2E stable queue', 'WAITING', ?)`,
    )
    .run(ticket, e2eIdentity.userId, seededFixture.queuedThreadId, seededFixture.queuedTurnId, now);
  sqlite
    .prepare(
      `INSERT INTO task_events (
        task_id, sequence, thread_id, turn_id, item_id, type, payload_json, created_at
      ) VALUES (?, 1, NULL, NULL, 'e2e-queue-item', 'QUEUED',
        '{"position":1,"etaMs":600000,"etaEstimated":true}', ?)`,
    )
    .run(seededFixture.queuedThreadId, now);
}

function seedSubagent(
  sqlite: { prepare(sql: string): { run(...parameters: unknown[]): unknown } },
  input: {
    threadId: string;
    status: "ACTIVE" | "DONE";
    name: string;
    summary: string;
    completedAt: number | null;
    now: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO subagent_threads (
        thread_id, parent_task_id, parent_thread_id, parent_turn_id, owner_id, session_id,
        name, role, model, effort, status, result_summary, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'e2e-session-tree', ?, 'reviewer', 'fake-codex',
        'MEDIUM', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.threadId,
      seededFixture.threadId,
      seededFixture.runtimeThreadId,
      seededFixture.turnId,
      e2eIdentity.userId,
      input.name,
      input.status,
      input.summary,
      input.now - 5_000,
      input.completedAt,
      input.now,
    );
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  requestedExitCode = exitCode;
  finish?.(exitCode);
}

async function stopChildren(): Promise<void> {
  shuttingDown = true;
  await Promise.all(children.map(stopChild));
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChild(child, "SIGKILL");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
