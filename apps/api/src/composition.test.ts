import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createApplication, type PlatformApplication } from "./composition.js";
import type { AppConfig } from "./config.js";

const key = Buffer.alloc(32, 3).toString("base64");

describe("createApplication", () => {
  let tempRoot: string | undefined;
  let application: PlatformApplication | undefined;

  afterEach(async () => {
    await application?.close();
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  test("assembles a runnable fake vertical slice and seeds exactly one four-user account", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    application = await createApplication(fakeConfig(tempRoot));

    await expect(
      application.app.inject({ method: "GET", url: "/api/health" }),
    ).resolves.toMatchObject({
      statusCode: 200,
      json: expect.any(Function),
    });
    expect(application.accounts.list()).toEqual([
      expect.objectContaining({
        alias: "Codex A",
        status: "AVAILABLE",
        authStatus: "AUTHENTICATED",
        maxActiveUsers: 4,
        weeklyRemaining: 90,
      }),
    ]);
    expect(application.database.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  test("is idempotent across restarts and does not create duplicate Codex accounts", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const config = fakeConfig(tempRoot);
    application = await createApplication(config);
    await application.close();
    application = undefined;

    application = await createApplication(config);

    expect(application.accounts.list()).toHaveLength(1);
  });

  test("refuses to reuse a fake database in real mode without mutating the fake account", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const fake = fakeConfig(tempRoot);
    application = await createApplication(fake);
    application.database.sqlite.prepare("DELETE FROM platform_settings").run();
    await application.close();
    application = undefined;
    await rm(join(fake.storage.runtimeDataDir, ".codexplatform-binding.json"), { force: true });

    const real = fakeConfig(tempRoot);
    real.runtime.mode = "real";
    let transitionError: unknown;
    try {
      application = await createApplication(real, {
        credentialProbe: async () => ({
          status: "READABLE",
          safeForMultiUser: false,
          evidence: "SANDBOX_READ_SENTINEL",
          checkedAt: "2026-07-21T12:00:00.000Z",
        }),
      });
    } catch (error) {
      transitionError = error;
    }
    await application?.close();
    application = undefined;

    expect(transitionError).toBeInstanceOf(Error);
    expect((transitionError as Error).message).toContain("DATABASE_PATH and RUNTIME_DATA_DIR");

    application = await createApplication(fake);
    expect(application.accounts.list()).toEqual([
      expect.objectContaining({
        status: "AVAILABLE",
        authStatus: "AUTHENTICATED",
        weeklyRemaining: 90,
      }),
    ]);
  });

  test("refuses conflicting legacy evidence from a fake database with a stale auth file", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const fake = fakeConfig(tempRoot);
    application = await createApplication(fake);
    const codexHome = join(fake.storage.runtimeDataDir, "codex-accounts", "codex-primary");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    application.database.sqlite.prepare("DELETE FROM platform_settings").run();
    await application.close();
    application = undefined;
    await rm(join(fake.storage.runtimeDataDir, ".codexplatform-binding.json"), { force: true });

    const real = fakeConfig(tempRoot);
    real.runtime.mode = "real";
    let transitionError: unknown;
    try {
      application = await createApplication(real, {
        credentialProbe: async () => ({
          status: "READABLE",
          safeForMultiUser: false,
          evidence: "SANDBOX_READ_SENTINEL",
          checkedAt: "2026-07-21T12:00:00.000Z",
        }),
      });
    } catch (error) {
      transitionError = error;
    }
    await application?.close();
    application = undefined;

    expect(transitionError).toBeInstanceOf(Error);
    expect((transitionError as Error).message).toContain("ambiguous");
  });

  test("refuses to bind a fresh database to an existing runtime directory", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const original = fakeConfig(join(tempRoot, "original"));
    application = await createApplication(original);
    await application.close();
    application = undefined;

    const unrelated = fakeConfig(join(tempRoot, "unrelated"));
    unrelated.runtime.mode = "real";
    unrelated.storage.runtimeDataDir = original.storage.runtimeDataDir;
    let pairingError: unknown;
    try {
      application = await createApplication(unrelated, {
        credentialProbe: async () => ({
          status: "READABLE",
          safeForMultiUser: false,
          evidence: "SANDBOX_READ_SENTINEL",
          checkedAt: "2026-07-21T12:00:00.000Z",
        }),
      });
    } catch (error) {
      pairingError = error;
    }
    await application?.close();
    application = undefined;

    expect(pairingError).toBeInstanceOf(Error);
    expect((pairingError as Error).message).toContain("RUNTIME_DATA_DIR");
  });

  test("refuses a fresh database when an unmarked legacy runtime contains account state", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const original = fakeConfig(join(tempRoot, "legacy-real"));
    original.runtime.mode = "real";
    const probe = async () =>
      ({
        status: "READABLE",
        safeForMultiUser: false,
        evidence: "SANDBOX_READ_SENTINEL",
        checkedAt: "2026-07-21T12:00:00.000Z",
      }) as const;
    application = await createApplication(original, { credentialProbe: probe });
    const codexHome = join(original.storage.runtimeDataDir, "codex-accounts", "codex-primary");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    await application.close();
    application = undefined;
    await rm(join(original.storage.runtimeDataDir, ".codexplatform-binding.json"), {
      force: true,
    });

    const unrelated = fakeConfig(join(tempRoot, "fresh-database"));
    unrelated.runtime.mode = "real";
    unrelated.storage.runtimeDataDir = original.storage.runtimeDataDir;
    let pairingError: unknown;
    try {
      application = await createApplication(unrelated, { credentialProbe: probe });
    } catch (error) {
      pairingError = error;
    }
    await application?.close();
    application = undefined;

    expect(pairingError).toBeInstanceOf(Error);
    expect((pairingError as Error).message).toContain("RUNTIME_DATA_DIR");
  });

  test("adopts a legacy real database and preserves authenticated account state", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const real = fakeConfig(tempRoot);
    real.runtime.mode = "real";
    const probe = async () =>
      ({
        status: "READABLE",
        safeForMultiUser: false,
        evidence: "SANDBOX_READ_SENTINEL",
        checkedAt: "2026-07-21T12:00:00.000Z",
      }) as const;
    application = await createApplication(real, { credentialProbe: probe });
    const authenticatedAt = new Date("2026-07-21T12:00:00.000Z");
    application.accounts.markAuthenticated("codex-primary", authenticatedAt);
    application.accounts.updateWeeklyQuota("codex-primary", {
      remainingPercent: 72,
      resetsAt: new Date("2026-07-28T12:00:00.000Z"),
      observedAt: authenticatedAt,
    });
    const codexHome = join(real.storage.runtimeDataDir, "codex-accounts", "codex-primary");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    application.database.sqlite.prepare("DELETE FROM platform_settings").run();
    await application.close();
    application = undefined;
    await rm(join(real.storage.runtimeDataDir, ".codexplatform-binding.json"), { force: true });

    application = await createApplication(real, { credentialProbe: probe });

    expect(application.accounts.list()[0]).toMatchObject({
      status: "AVAILABLE",
      authStatus: "AUTHENTICATED",
      weeklyRemaining: 72,
      activeUsers: 0,
      activeTurns: 0,
    });
  });

  test("refuses to adopt a legacy database with account homes outside the configured runtime", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const original = fakeConfig(join(tempRoot, "original"));
    original.runtime.mode = "real";
    const probe = async () =>
      ({
        status: "READABLE",
        safeForMultiUser: false,
        evidence: "SANDBOX_READ_SENTINEL",
        checkedAt: "2026-07-21T12:00:00.000Z",
      }) as const;
    application = await createApplication(original, { credentialProbe: probe });
    const codexHome = join(original.storage.runtimeDataDir, "codex-accounts", "codex-primary");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    application.accounts.markAuthenticated("codex-primary", new Date());
    application.accounts.updateWeeklyQuota("codex-primary", {
      remainingPercent: 72,
      resetsAt: new Date(Date.now() + 7 * 24 * 60 * 60_000),
      observedAt: new Date(),
    });
    application.database.sqlite.prepare("DELETE FROM platform_settings").run();
    await application.close();
    application = undefined;
    await rm(join(original.storage.runtimeDataDir, ".codexplatform-binding.json"), {
      force: true,
    });

    const moved = fakeConfig(join(tempRoot, "moved"));
    moved.runtime.mode = "real";
    moved.storage.databasePath = original.storage.databasePath;
    let pairingError: unknown;
    try {
      application = await createApplication(moved, { credentialProbe: probe });
    } catch (error) {
      pairingError = error;
    }
    await application?.close();
    application = undefined;

    expect(pairingError).toBeInstanceOf(Error);
    expect((pairingError as Error).message).toContain("account home");
  });

  test("immediately marks persisted running Turns for recovery on restart", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const config = fakeConfig(tempRoot);
    application = await createApplication(config);
    seedUser(application, "operator", "ou_admin", "ADMIN");
    const project = await application.service.createProject("operator", { name: "Recovery" });
    const task = await application.service.createTask("operator", {
      projectId: project.id,
      title: "Interrupted task",
    });
    await application.service.startTurn(task.id, "operator", "Run across restart");
    await application.close();
    application = undefined;

    application = await createApplication(config);

    expect(await application.service.getTask(task.id, "operator")).toMatchObject({
      status: "NEEDS_RECOVERY",
    });
    expect(
      (await application.service.listTaskEvents(task.id, "operator", 0))?.filter(
        (event) => event.type === "RECOVERY_REQUIRED",
      ),
    ).toHaveLength(1);
    expect(application.accounts.list()[0]).toMatchObject({ activeTurns: 0 });
  });

  test("real mode keeps non-operator users outside the lease pool when isolation is unsafe", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-composition-"));
    const config = fakeConfig(tempRoot);
    config.runtime.mode = "real";
    application = await createApplication(config, {
      credentialProbe: async () => ({
        status: "READABLE",
        safeForMultiUser: false,
        evidence: "SANDBOX_READ_SENTINEL",
        checkedAt: "2026-07-21T12:00:00.000Z",
      }),
    });
    expect(application.accounts.list()[0]).toMatchObject({
      status: "REAUTH_REQUIRED",
      authStatus: "UNAUTHENTICATED",
      weeklyRemaining: null,
      activeUsers: 0,
      activeTurns: 0,
    });
    seedUser(application, "operator", "ou_admin", "ADMIN");
    seedUser(application, "member", "ou_member", "MEMBER");
    const project = await application.service.createProject("member", { name: "Member" });
    const task = await application.service.createTask("member", {
      projectId: project.id,
      title: "Blocked",
    });

    await expect(application.service.startTurn(task.id, "member", "Run Codex")).rejects.toThrow(
      "credential isolation",
    );
    expect(application.accounts.list()[0]).toMatchObject({ activeUsers: 0, activeTurns: 0 });
  });
});

function fakeConfig(root: string): AppConfig {
  return {
    server: { host: "127.0.0.1", port: 4310, webOrigin: "http://127.0.0.1:5173" },
    storage: {
      databasePath: join(root, "data", "platform.sqlite"),
      runtimeDataDir: join(root, "runtime"),
    },
    runtime: { mode: "fake", codexBinary: join(root, "codex") },
    feishu: {
      appId: "cli_test",
      appSecret: "secret",
      redirectUri: "http://127.0.0.1:4310/api/auth/feishu/callback",
      tenantKey: "tenant-1",
      adminOpenIds: ["ou_admin"],
      firstAdminOpenId: "ou_admin",
      tokenEncryptionKey: key,
      scopes: ["auth:user.id:read"],
    },
  };
}

function seedUser(
  application: PlatformApplication,
  id: string,
  openId: string,
  role: "ADMIN" | "MEMBER",
): void {
  const now = Date.now();
  application.database.sqlite
    .prepare(
      `INSERT INTO users (id, tenant_key, open_id, name, role, created_at, updated_at)
       VALUES (?, 'tenant-1', ?, ?, ?, ?, ?)`,
    )
    .run(id, openId, id, role, now, now);
}
