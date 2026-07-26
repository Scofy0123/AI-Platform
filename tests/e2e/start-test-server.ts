import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eIdentity } from "./identity.js";

const apiUrl = "http://127.0.0.1:4310";
const webUrl = "http://127.0.0.1:5173";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testDataDirectory = await mkdtemp(join(tmpdir(), "codexplatform-e2e-"));
const databasePath = join(testDataDirectory, "codexplatform.sqlite");
const runtimeDataDirectory = join(testDataDirectory, "runtime");
const children: ChildProcess[] = [];
let shuttingDown = false;
let finish: ((exitCode: number) => void) | undefined;

const finished = new Promise<number>((resolveFinished) => {
  finish = resolveFinished;
});

try {
  const api = launch("api", ["--filter", "@codexplatform/api", "exec", "tsx", "src/index.ts"], {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "4310",
    WEB_ORIGIN: webUrl,
    DATABASE_PATH: databasePath,
    RUNTIME_DATA_DIR: runtimeDataDirectory,
    RUNTIME_MODE: "fake",
    FEISHU_APP_ID: "cli_e2e_fake",
    FEISHU_APP_SECRET: "e2e-only-not-a-real-secret",
    FEISHU_TENANT_KEY: e2eIdentity.tenantKey,
    FEISHU_ADMIN_OPEN_IDS: e2eIdentity.openId,
    FEISHU_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  children.push(api);
  await waitForHttp(`${apiUrl}/api/health`);
  seedTestIdentity(databasePath);

  const web = launch(
    "web",
    [
      "--filter",
      "@codexplatform/web",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
      "--strictPort",
    ],
    { NODE_ENV: "test" },
  );
  children.push(web);
  await waitForHttp(webUrl);
  process.stdout.write(`[e2e] isolated Fake Runtime is ready at ${webUrl}\n`);

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  process.once("SIGHUP", () => void shutdown(0));

  const exitCode = await finished;
  await stopChildren();
  await rm(testDataDirectory, { recursive: true, force: true });
  process.exitCode = exitCode;
} catch (error) {
  process.stderr.write(`[e2e] failed to start: ${safeMessage(error)}\n`);
  await stopChildren();
  await rm(testDataDirectory, { recursive: true, force: true });
  process.exitCode = 1;
}

function launch(name: string, args: string[], environment: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn("pnpm", args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
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

function seedTestIdentity(path: string): void {
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
    sqlite
      .prepare(
        `INSERT INTO users (
          id, tenant_key, open_id, union_id, name, avatar_url, role, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, NULL, 'ADMIN', ?, ?)`,
      )
      .run(
        e2eIdentity.userId,
        e2eIdentity.tenantKey,
        e2eIdentity.openId,
        e2eIdentity.name,
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
        "e2e-session",
        hash(e2eIdentity.sessionToken),
        hash(e2eIdentity.csrfToken),
        e2eIdentity.userId,
        now,
        now + 60 * 60_000,
      );
  } finally {
    sqlite.close();
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  finish?.(exitCode);
}

async function stopChildren(): Promise<void> {
  shuttingDown = true;
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
