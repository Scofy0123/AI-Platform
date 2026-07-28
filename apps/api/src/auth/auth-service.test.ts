import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type PlatformDatabase } from "../infra/db/database.js";
import { migrateDatabase } from "../infra/db/migrate.js";
import { AesGcmSecretStore } from "../security/secret-store.js";
import { AuthService, type FeishuIdentityProvider } from "./auth-service.js";
import { SQLiteAuthStore } from "./auth-store.js";
import { FeishuApiError } from "./feishu-oauth-client.js";

const NOW = new Date("2026-07-21T10:00:00.000Z");
const TOKENS = {
  accessToken: "sentinel-access-token",
  refreshToken: "sentinel-refresh-token",
  expiresIn: 7_200,
  refreshTokenExpiresIn: 2_592_000,
  scopes: ["auth:user.id:read", "offline_access"],
  tokenType: "Bearer",
};

describe("AuthService", () => {
  let database: PlatformDatabase;
  let store: SQLiteAuthStore;

  beforeEach(() => {
    database = createDatabase(":memory:");
    migrateDatabase(database.sqlite);
    store = new SQLiteAuthStore(
      database.sqlite,
      new AesGcmSecretStore(Buffer.alloc(32, 9).toString("base64")),
    );
  });

  afterEach(() => {
    database.sqlite.close();
  });

  test("consumes OAuth state once, restricts the tenant, and creates the first admin session", async () => {
    const identity = new FakeIdentityProvider();
    const service = new AuthService({
      identity,
      store,
      allowedTenantKey: "tenant-1",
      firstAdminOpenId: "ou_admin",
      now: () => NOW,
    });
    const start = service.startLogin();

    expect(start.authorizationUrl).toBe(`https://auth.example.test?state=${start.state}`);
    await expect(
      service.completeLogin({ code: "code-1", state: start.state, browserBinding: "wrong" }),
    ).rejects.toThrow("OAuth state is invalid, expired, or already used");
    const result = await service.completeLogin({
      code: "code-1",
      state: start.state,
      browserBinding: start.browserBinding,
    });

    expect(result.user).toMatchObject({
      openId: "ou_admin",
      tenantKey: "tenant-1",
      role: "ADMIN",
      name: "Admin",
    });
    expect(result.sessionToken).toHaveLength(64);
    expect(result.csrfToken).toHaveLength(64);
    expect(service.resolveSession(result.sessionToken)).toMatchObject({
      user: { openId: "ou_admin", role: "ADMIN" },
    });
    await expect(
      service.completeLogin({
        code: "code-1",
        state: start.state,
        browserBinding: start.browserBinding,
      }),
    ).rejects.toThrow("OAuth state is invalid, expired, or already used");

    const dump = database.sqlite.serialize();
    expect(dump.includes(Buffer.from(TOKENS.accessToken))).toBe(false);
    expect(dump.includes(Buffer.from(TOKENS.refreshToken))).toBe(false);
  });

  test("rejects a foreign tenant before persisting users, tokens, or sessions", async () => {
    const identity = new FakeIdentityProvider({ tenantKey: "tenant-foreign" });
    const service = new AuthService({
      identity,
      store,
      allowedTenantKey: "tenant-1",
      firstAdminOpenId: "ou_admin",
      now: () => NOW,
    });
    const start = service.startLogin();

    await expect(
      service.completeLogin({
        code: "code-1",
        state: start.state,
        browserBinding: start.browserBinding,
      }),
    ).rejects.toThrow("Feishu tenant is not allowed");
    expect(store.countUsers()).toBe(0);
    expect(store.countCredentials()).toBe(0);
    expect(store.countSessions()).toBe(0);
  });

  test("atomically rotates both access and refresh tokens", async () => {
    const identity = new FakeIdentityProvider();
    const service = new AuthService({
      identity,
      store,
      allowedTenantKey: "tenant-1",
      firstAdminOpenId: "ou_admin",
      now: () => NOW,
    });
    const start = service.startLogin();
    const login = await service.completeLogin({
      code: "code-1",
      state: start.state,
      browserBinding: start.browserBinding,
    });
    identity.refreshedTokens = {
      ...TOKENS,
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
    };

    await service.refreshUserCredentials(login.user.id);

    expect(store.getCredentials(login.user.id)).toMatchObject({
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
    });
  });

  test("creates a 30 day persistent session and upgrades a legacy session only once", async () => {
    const service = new AuthService({
      identity: new FakeIdentityProvider(),
      store,
      allowedTenantKey: "tenant-1",
      firstAdminOpenId: "ou_admin",
      now: () => NOW,
      sessionTtlMs: 12 * 60 * 60_000,
      persistentSessionTtlMs: 30 * 24 * 60 * 60_000,
    });
    const start = service.startLogin();
    const login = await service.completeLogin({
      code: "code-1",
      state: start.state,
      browserBinding: start.browserBinding,
    });

    const before = service.resolveSession(login.sessionToken);
    expect(before?.persistent).toBe(false);
    expect(before?.expiresAt.toISOString()).toBe("2026-07-21T22:00:00.000Z");

    const persisted = service.persistSession(login.sessionToken);
    expect(persisted?.persistent).toBe(true);
    expect(persisted?.expiresAt.toISOString()).toBe("2026-08-20T10:00:00.000Z");
    expect(service.persistSession(login.sessionToken)?.expiresAt).toEqual(persisted?.expiresAt);

    service.revokeSession(login.sessionToken);
    expect(service.resolveSession(login.sessionToken)).toBeNull();
  });

  test("coalesces concurrent Feishu credential refreshes per user", async () => {
    const identity = new FakeIdentityProvider();
    const service = new AuthService({
      identity,
      store,
      allowedTenantKey: "tenant-1",
      firstAdminOpenId: "ou_admin",
      now: () => NOW,
    });
    const start = service.startLogin();
    const login = await service.completeLogin({
      code: "code-1",
      state: start.state,
      browserBinding: start.browserBinding,
    });

    await Promise.all([
      service.refreshUserCredentials(login.user.id),
      service.refreshUserCredentials(login.user.id),
    ]);

    expect(identity.refreshCalls).toBe(1);
  });

  test("refreshes expiring credentials only for users with an active platform session", async () => {
    const identity = new FakeIdentityProvider();
    identity.exchangedTokens = { ...TOKENS, expiresIn: 5 * 60 };
    const service = new AuthService({
      identity,
      store,
      allowedTenantKey: "tenant-1",
      firstAdminOpenId: "ou_admin",
      now: () => NOW,
    });
    const start = service.startLogin();
    await service.completeLogin({
      code: "code-1",
      state: start.state,
      browserBinding: start.browserBinding,
    });

    await service.refreshExpiringCredentials();

    expect(identity.refreshCalls).toBe(1);
  });

  test("keeps the platform session when Feishu requires reauthorization", async () => {
    const identity = new FakeIdentityProvider();
    identity.refreshError = new FeishuApiError(20013, "refresh token invalid", 400);
    const service = new AuthService({
      identity,
      store,
      allowedTenantKey: "tenant-1",
      firstAdminOpenId: "ou_admin",
      now: () => NOW,
    });
    const start = service.startLogin();
    const login = await service.completeLogin({
      code: "code-1",
      state: start.state,
      browserBinding: start.browserBinding,
    });

    await expect(service.refreshUserCredentials(login.user.id)).rejects.toThrow(
      "refresh token invalid",
    );

    expect(service.resolveSession(login.sessionToken)).toMatchObject({
      user: { id: login.user.id },
      feishuConnectionStatus: "REAUTH_REQUIRED",
    });
  });
});

class FakeIdentityProvider implements FeishuIdentityProvider {
  exchangedTokens = TOKENS;
  refreshedTokens = TOKENS;
  refreshError: Error | null = null;
  refreshCalls = 0;

  constructor(
    private readonly identityOverrides: Partial<
      Awaited<ReturnType<FeishuIdentityProvider["getUserInfo"]>>
    > = {},
  ) {}

  createAuthorizationUrl(state: string): string {
    return `https://auth.example.test?state=${state}`;
  }

  async exchangeAuthorizationCode(): Promise<typeof TOKENS> {
    return this.exchangedTokens;
  }

  async getUserInfo() {
    return {
      openId: "ou_admin",
      unionId: "on_union",
      tenantKey: "tenant-1",
      name: "Admin",
      avatarUrl: "https://avatar.example.test/admin.png",
      ...this.identityOverrides,
    };
  }

  async refreshTokens(): Promise<typeof TOKENS> {
    this.refreshCalls += 1;
    if (this.refreshError) throw this.refreshError;
    return this.refreshedTokens;
  }
}
