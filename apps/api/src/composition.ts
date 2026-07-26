import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { AuthService } from "./auth/auth-service.js";
import { SQLiteAuthStore } from "./auth/auth-store.js";
import { FeishuOAuthClient } from "./auth/feishu-oauth-client.js";
import type { AppConfig } from "./config.js";
import { AccountAdminStore } from "./domain/account-admin-store.js";
import { SQLiteLeaseStore } from "./domain/lease-store.js";
import {
  LocalPlatformService,
  type RuntimeSafetyPort,
  type TaskExecutionAdapter,
} from "./domain/platform-service.js";
import { SQLitePlatformStore } from "./domain/platform-store.js";
import { AppServerExecutionAdapter } from "./infra/codex/app-server-execution-adapter.js";
import { FakeExecutionAdapter } from "./infra/codex/fake-execution-adapter.js";
import { CodexRuntimeSupervisor } from "./infra/codex/runtime-supervisor.js";
import { createDatabase, type PlatformDatabase } from "./infra/db/database.js";
import { migrateDatabase } from "./infra/db/migrate.js";
import {
  type CredentialIsolationProbeResult,
  decideRealCodexAccess,
  probeCodexCredentialIsolation,
} from "./security/runtime-safety-gate.js";
import { AesGcmSecretStore } from "./security/secret-store.js";
import { buildApp } from "./server.js";
import { ActorRegistry } from "./tools/actor-registry.js";
import { SafeDemoDatabase } from "./tools/demo-db.js";
import { FeishuContentClient } from "./tools/feishu-client.js";
import { EnterpriseToolRuntime } from "./tools/tool-runtime.js";

const PRIMARY_ACCOUNT_ID = "codex-primary";
const MAINTENANCE_INTERVAL_MS = 15_000;
const RUNTIME_BINDING_FILE = ".codexplatform-binding.json";

interface CreateApplicationOptions {
  credentialProbe?: (input: {
    binaryPath: string;
    workspacePath: string;
  }) => Promise<CredentialIsolationProbeResult>;
}

export interface PlatformApplication {
  app: FastifyInstance;
  database: PlatformDatabase;
  accounts: AccountAdminStore;
  service: LocalPlatformService;
  safetyProbe: CredentialIsolationProbeResult | null;
  close(): Promise<void>;
}

export async function createApplication(
  config: AppConfig,
  options: CreateApplicationOptions = {},
): Promise<PlatformApplication> {
  await prepareDirectories(config);
  const database = createDatabase(config.storage.databasePath);
  migrateDatabase(database.sqlite);
  try {
    await bindRuntimeStorage(database, config);
  } catch (error) {
    database.sqlite.close();
    throw error;
  }
  seedDemoDatabase(database);

  const secrets = new AesGcmSecretStore(config.feishu.tokenEncryptionKey);
  const authStore = new SQLiteAuthStore(database.sqlite, secrets);
  const identity = new FeishuOAuthClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    redirectUri: config.feishu.redirectUri,
    scopes: config.feishu.scopes,
  });
  const auth = new AuthService({
    identity,
    store: authStore,
    allowedTenantKey: config.feishu.tenantKey,
    firstAdminOpenId: config.feishu.firstAdminOpenId,
  });
  const leases = new SQLiteLeaseStore(database.sqlite);
  const accounts = new AccountAdminStore(database.sqlite);
  const platformStore = new SQLitePlatformStore(database.sqlite);
  seedPrimaryAccount(config, leases, accounts);

  const actors = new ActorRegistry();
  const demoDatabase = new SafeDemoDatabase(database.sqlite, {
    allowedTables: ["demo_orders", "demo_customers"],
  });
  const tools = new EnterpriseToolRuntime({
    resolveActor: async (threadId, turnId) => {
      const actor = actors.resolve(threadId, turnId);
      if (!actor) return null;
      let credentials = authStore.getCredentials(actor.userId);
      if (!credentials) return null;
      if (credentials.accessExpiresAt.getTime() <= Date.now() + 60_000) {
        await auth.refreshUserCredentials(actor.userId);
        credentials = authStore.getCredentials(actor.userId);
      }
      return credentials
        ? { taskId: actor.taskId, userId: actor.userId, accessToken: credentials.accessToken }
        : null;
    },
    createFeishuClient: (accessToken) => new FeishuContentClient(accessToken),
    demoDatabase,
    onInvocation: (event) => platformStore.recordToolInvocation(event),
  });

  const execution = createExecutionAdapter(config, actors, tools);
  const workspacePath = join(config.storage.runtimeDataDir, "workspaces");
  const safetyProbe =
    config.runtime.mode === "real"
      ? await (options.credentialProbe ?? probeCodexCredentialIsolation)({
          binaryPath: config.runtime.codexBinary,
          workspacePath,
        })
      : null;
  const safety = createSafetyPort(config, database, safetyProbe);
  const service = new LocalPlatformService({
    store: platformStore,
    leases,
    accounts,
    execution,
    safety,
    dataDir: config.storage.runtimeDataDir,
  });
  service.recoverInterruptedTurns();
  const app = buildApp({ auth, platform: service, webOrigin: config.server.webOrigin });
  const maintenance = setInterval(() => {
    void service.runMaintenance().catch(() => undefined);
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();

  let closed = false;
  return {
    app,
    database,
    accounts,
    service,
    safetyProbe,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(maintenance);
      await app.close();
      await service.close();
      database.sqlite.close();
    },
  };
}

async function prepareDirectories(config: AppConfig): Promise<void> {
  await mkdir(dirname(config.storage.databasePath), { recursive: true, mode: 0o700 });
  await mkdir(config.storage.runtimeDataDir, { recursive: true, mode: 0o700 });
  await chmod(config.storage.runtimeDataDir, 0o700);
  await mkdir(join(config.storage.runtimeDataDir, "workspaces"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(config.storage.runtimeDataDir, "codex-accounts"), {
    recursive: true,
    mode: 0o700,
  });
}

function seedDemoDatabase(database: PlatformDatabase): void {
  database.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS demo_orders (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      amount_cents INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS demo_customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tier TEXT NOT NULL
    );
    INSERT OR IGNORE INTO demo_customers (id, name, tier)
      VALUES ('customer-1', 'Demo Customer', 'GOLD');
    INSERT OR IGNORE INTO demo_orders (id, customer_id, status, amount_cents)
      VALUES ('order-1', 'customer-1', 'PAID', 129900);
  `);
}

interface RuntimeBinding {
  version: 1;
  storageId: string;
  runtimeMode: AppConfig["runtime"]["mode"];
  databasePath: string;
  runtimeDataDir: string;
}

async function bindRuntimeStorage(database: PlatformDatabase, config: AppConfig): Promise<void> {
  const settings = database.sqlite
    .prepare(
      `SELECT key, value FROM platform_settings
       WHERE key IN ('runtime_mode', 'runtime_dir', 'storage_id', 'database_path')`,
    )
    .all() as Array<{ key: string; value: string }>;
  const recordedMode = settings.find((setting) => setting.key === "runtime_mode")?.value;
  const recordedRuntimeDir = settings.find((setting) => setting.key === "runtime_dir")?.value;
  const recordedStorageId = settings.find((setting) => setting.key === "storage_id")?.value;
  const recordedDatabasePath = settings.find((setting) => setting.key === "database_path")?.value;
  const markerPath = join(config.storage.runtimeDataDir, RUNTIME_BINDING_FILE);
  const marker = await readRuntimeBinding(markerPath);
  const existingAccount = database.sqlite.prepare("SELECT 1 FROM codex_accounts LIMIT 1").get();
  if (existingAccount) {
    assertAccountHomes(database, config.storage.runtimeDataDir);
  }

  if (recordedMode) {
    if (recordedMode !== config.runtime.mode) {
      throw new Error(
        `Database is bound to RUNTIME_MODE=${recordedMode}. Configure a new DATABASE_PATH and RUNTIME_DATA_DIR for RUNTIME_MODE=${config.runtime.mode}.`,
      );
    }
    if (recordedRuntimeDir !== config.storage.runtimeDataDir) {
      throw new Error(
        "Database is bound to a different runtime directory. Configure DATABASE_PATH and RUNTIME_DATA_DIR as a paired environment.",
      );
    }
    if (recordedDatabasePath && recordedDatabasePath !== config.storage.databasePath) {
      throw new Error(
        "Runtime database was moved or copied. Configure DATABASE_PATH and RUNTIME_DATA_DIR as a paired environment.",
      );
    }
    if (recordedStorageId) {
      if (!marker) {
        throw new Error(
          "RUNTIME_DATA_DIR binding marker is missing; refusing to attach the database to an unverified runtime directory.",
        );
      }
      assertRuntimeBinding(marker, {
        storageId: recordedStorageId,
        runtimeMode: config.runtime.mode,
        databasePath: config.storage.databasePath,
        runtimeDataDir: config.storage.runtimeDataDir,
      });
      return;
    }
    if (marker) {
      assertRuntimeBinding(marker, {
        runtimeMode: config.runtime.mode,
        databasePath: config.storage.databasePath,
        runtimeDataDir: config.storage.runtimeDataDir,
      });
      storeRuntimeBinding(database, marker);
      return;
    }
    await createAndStoreRuntimeBinding(database, config, markerPath);
    return;
  }

  if (marker) {
    throw new Error(
      "RUNTIME_DATA_DIR is already bound to another database. Configure a new DATABASE_PATH and RUNTIME_DATA_DIR.",
    );
  }
  if (!existingAccount && (await runtimeDirectoryContainsState(config.storage.runtimeDataDir))) {
    throw new Error(
      "RUNTIME_DATA_DIR contains unbound runtime state. Configure a new DATABASE_PATH and RUNTIME_DATA_DIR.",
    );
  }
  if (existingAccount) {
    const legacyMode = await inferLegacyRuntimeMode(database);
    if (!legacyMode) {
      throw new Error(
        "Legacy database runtime mode is ambiguous. Configure a new DATABASE_PATH and RUNTIME_DATA_DIR.",
      );
    }
    if (legacyMode !== config.runtime.mode) {
      throw new Error(
        `Legacy database contains ${legacyMode} runtime state. Configure a new DATABASE_PATH and RUNTIME_DATA_DIR for RUNTIME_MODE=${config.runtime.mode}.`,
      );
    }
  }
  await createAndStoreRuntimeBinding(database, config, markerPath);
}

function assertAccountHomes(database: PlatformDatabase, runtimeDataDir: string): void {
  const accounts = database.sqlite
    .prepare("SELECT id, codex_home FROM codex_accounts")
    .all() as Array<{ id: string; codex_home: string | null }>;
  for (const account of accounts) {
    const expectedHome = join(runtimeDataDir, "codex-accounts", account.id);
    if (account.codex_home !== expectedHome) {
      throw new Error(
        `Codex account home for ${account.id} is outside the configured RUNTIME_DATA_DIR. Configure a paired DATABASE_PATH and RUNTIME_DATA_DIR.`,
      );
    }
  }
}

async function inferLegacyRuntimeMode(
  database: PlatformDatabase,
): Promise<AppConfig["runtime"]["mode"] | null> {
  const fakeThread = database.sqlite
    .prepare("SELECT 1 FROM tasks WHERE thread_id LIKE 'fake-thread-%' LIMIT 1")
    .get();

  const accounts = database.sqlite
    .prepare("SELECT id, codex_home, auth_status, weekly_remaining FROM codex_accounts")
    .all() as Array<{
    id: string;
    codex_home: string | null;
    auth_status: string;
    weekly_remaining: number | null;
  }>;
  let hasAuthFile = false;
  for (const account of accounts) {
    if (account.codex_home && (await fileExists(join(account.codex_home, "auth.json")))) {
      hasAuthFile = true;
      break;
    }
  }
  const primary = accounts.find((account) => account.id === PRIMARY_ACCOUNT_ID);
  const hasFakeAccountSeed =
    primary?.auth_status === "AUTHENTICATED" && primary.weekly_remaining === 90;
  const hasRealUnauthenticatedSeed =
    accounts.length > 0 &&
    accounts.every(
      (account) => account.auth_status !== "AUTHENTICATED" && account.weekly_remaining === null,
    );
  const hasFakeEvidence = Boolean(fakeThread || hasFakeAccountSeed);
  const hasRealEvidence = hasAuthFile || hasRealUnauthenticatedSeed;

  if (hasFakeEvidence && hasRealEvidence) return null;
  if (hasFakeEvidence) return "fake";
  if (hasRealEvidence) return "real";
  return null;
}

async function createAndStoreRuntimeBinding(
  database: PlatformDatabase,
  config: AppConfig,
  markerPath: string,
): Promise<void> {
  const binding: RuntimeBinding = {
    version: 1,
    storageId: randomUUID(),
    runtimeMode: config.runtime.mode,
    databasePath: config.storage.databasePath,
    runtimeDataDir: config.storage.runtimeDataDir,
  };
  await writeRuntimeBinding(markerPath, binding);
  try {
    storeRuntimeBinding(database, binding);
  } catch (error) {
    await unlink(markerPath).catch(() => undefined);
    throw error;
  }
}

function storeRuntimeBinding(database: PlatformDatabase, binding: RuntimeBinding): void {
  const entries = [
    ["runtime_mode", binding.runtimeMode],
    ["runtime_dir", binding.runtimeDataDir],
    ["storage_id", binding.storageId],
    ["database_path", binding.databasePath],
  ] as const;
  database.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const statement = database.sqlite.prepare(
      `INSERT INTO platform_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    for (const entry of entries) statement.run(...entry);
    database.sqlite.exec("COMMIT");
  } catch (error) {
    database.sqlite.exec("ROLLBACK");
    throw error;
  }
}

async function writeRuntimeBinding(path: string, binding: RuntimeBinding): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(binding)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) await unlink(path).catch(() => undefined);
    throw new Error(
      "RUNTIME_DATA_DIR is already bound or cannot be claimed. Configure a paired DATABASE_PATH and RUNTIME_DATA_DIR.",
      { cause: error },
    );
  } finally {
    await handle?.close();
  }
}

async function readRuntimeBinding(path: string): Promise<RuntimeBinding | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RUNTIME_DATA_DIR binding marker is invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<RuntimeBinding>).version !== 1 ||
    typeof (value as Partial<RuntimeBinding>).storageId !== "string" ||
    !["fake", "real"].includes(String((value as Partial<RuntimeBinding>).runtimeMode)) ||
    typeof (value as Partial<RuntimeBinding>).databasePath !== "string" ||
    typeof (value as Partial<RuntimeBinding>).runtimeDataDir !== "string"
  ) {
    throw new Error("RUNTIME_DATA_DIR binding marker is invalid");
  }
  return value as RuntimeBinding;
}

function assertRuntimeBinding(actual: RuntimeBinding, expected: Partial<RuntimeBinding>): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key as keyof RuntimeBinding] !== value) {
      throw new Error(
        "RUNTIME_DATA_DIR is bound to a different database or runtime mode. Configure a paired DATABASE_PATH and RUNTIME_DATA_DIR.",
      );
    }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function runtimeDirectoryContainsState(runtimeDataDir: string): Promise<boolean> {
  const entries = await readdir(runtimeDataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === "codex-accounts" || entry.name === "workspaces")) {
      if ((await readdir(join(runtimeDataDir, entry.name))).length > 0) return true;
      continue;
    }
    if (entry.name !== RUNTIME_BINDING_FILE) return true;
  }
  return false;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function seedPrimaryAccount(
  config: AppConfig,
  leases: SQLiteLeaseStore,
  accounts: AccountAdminStore,
): void {
  if (accounts.count() > 0) return;
  const fake = config.runtime.mode === "fake";
  leases.addAccount({
    id: PRIMARY_ACCOUNT_ID,
    alias: "Codex A",
    codexHome: join(config.storage.runtimeDataDir, "codex-accounts", PRIMARY_ACCOUNT_ID),
    status: fake ? "AVAILABLE" : "REAUTH_REQUIRED",
    authStatus: fake ? "AUTHENTICATED" : "UNAUTHENTICATED",
    maxActiveUsers: 4,
    weeklyRemaining: fake ? 90 : null,
    quotaUpdatedAt: fake ? new Date() : null,
    allowUnknownQuota: false,
    healthScore: 100,
  });
}

function createExecutionAdapter(
  config: AppConfig,
  actors: ActorRegistry,
  tools: EnterpriseToolRuntime,
): TaskExecutionAdapter {
  if (config.runtime.mode === "fake") return new FakeExecutionAdapter();
  return new AppServerExecutionAdapter({
    supervisor: new CodexRuntimeSupervisor({ binaryPath: config.runtime.codexBinary }),
    actors,
    tools,
  });
}

function createSafetyPort(
  config: AppConfig,
  database: PlatformDatabase,
  probe: CredentialIsolationProbeResult | null,
): RuntimeSafetyPort {
  if (config.runtime.mode === "fake") {
    return { authorize: () => ({ allowed: true, mode: "SIMULATED_MULTI_USER" }) };
  }
  if (!probe) throw new Error("Real Codex credential safety probe was not run");
  return {
    authorize(userId) {
      const operator = database.sqlite
        .prepare("SELECT id FROM users WHERE tenant_key = ? AND open_id = ?")
        .get(config.feishu.tenantKey, config.feishu.firstAdminOpenId) as { id: string } | undefined;
      const activeUsers = database.sqlite
        .prepare("SELECT DISTINCT user_id FROM account_slots WHERE user_id IS NOT NULL")
        .all() as Array<{ user_id: string }>;
      const decision = decideRealCodexAccess({
        userId,
        operatorUserId: operator?.id ?? "__operator_not_logged_in__",
        activeUserIds: activeUsers.map((entry) => entry.user_id),
        probe,
      });
      return {
        allowed: decision.allowed || decision.shouldQueue,
        mode: decision.mode,
        ...(decision.allowed || decision.shouldQueue ? {} : { reason: decision.message }),
      };
    },
  };
}
