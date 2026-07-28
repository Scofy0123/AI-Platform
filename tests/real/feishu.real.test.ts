import { describe, expect, test } from "vitest";
import { AuthService } from "../../apps/api/src/auth/auth-service.js";
import { SQLiteAuthStore } from "../../apps/api/src/auth/auth-store.js";
import { FeishuOAuthClient } from "../../apps/api/src/auth/feishu-oauth-client.js";
import { createDatabase } from "../../apps/api/src/infra/db/database.js";
import { migrateDatabase } from "../../apps/api/src/infra/db/migrate.js";
import { AesGcmSecretStore } from "../../apps/api/src/security/secret-store.js";
import { FeishuContentClient } from "../../apps/api/src/tools/feishu-client.js";
import { requireSmokeEnv, rethrowWithoutSecrets } from "./smoke-env.js";

describe("real Feishu integration", () => {
  test.skipIf(process.env.REAL_FEISHU_E2E !== "1")(
    "searches and reads content with the current user's OAuth token",
    async () => {
      const accessToken = requireSmokeEnv("FEISHU_E2E_USER_ACCESS_TOKEN");
      const documentUrl = requireSmokeEnv("FEISHU_E2E_DOCUMENT_URL");
      const searchQuery = process.env.FEISHU_E2E_SEARCH_QUERY?.trim() || "AI";
      const client = new FeishuContentClient(accessToken);

      try {
        const search = await client.search(searchQuery, { pageSize: 1 });
        expect(search.total).toBeGreaterThanOrEqual(0);
        expect(search.results.length).toBeLessThanOrEqual(1);
        expect(typeof search.hasMore).toBe("boolean");

        const document = await client.readDocument(documentUrl);
        expect(document.url).toBe(documentUrl);
        expect(document.documentId).not.toBe("");
        expect(document.title).not.toBe("");
        expect(document.revisionId).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(document.blocks)).toBe(true);
      } catch (error) {
        rethrowWithoutSecrets(error, [accessToken]);
      }
    },
    60_000,
  );

  test.skipIf(process.env.REAL_FEISHU_REFRESH_E2E !== "1")(
    "rotates the active platform user's one-time refresh token atomically",
    async () => {
      const databasePath = requireSmokeEnv("DATABASE_PATH");
      const encryptionKey = requireSmokeEnv("FEISHU_TOKEN_ENCRYPTION_KEY");
      const database = createDatabase(databasePath);
      const sensitiveValues: string[] = [];
      try {
        migrateDatabase(database.sqlite);
        const active = database.sqlite
          .prepare(
            `SELECT user_id FROM sessions
             WHERE revoked_at IS NULL AND expires_at > ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(Date.now()) as { user_id: string } | undefined;
        if (!active) throw new Error("No active platform session is available for refresh smoke.");

        const store = new SQLiteAuthStore(database.sqlite, new AesGcmSecretStore(encryptionKey));
        const before = store.getCredentials(active.user_id);
        if (!before) throw new Error("The active platform user has no Feishu credentials.");
        sensitiveValues.push(before.accessToken, before.refreshToken);

        const identity = new FeishuOAuthClient({
          appId: requireSmokeEnv("FEISHU_APP_ID"),
          appSecret: requireSmokeEnv("FEISHU_APP_SECRET"),
          redirectUri: requireSmokeEnv("FEISHU_REDIRECT_URI"),
          scopes: [],
        });
        const service = new AuthService({
          identity,
          store,
          allowedTenantKey: requireSmokeEnv("FEISHU_TENANT_KEY"),
          firstAdminOpenId: requireSmokeEnv("FEISHU_ADMIN_OPEN_IDS").split(/[\s,]+/)[0] ?? "",
        });

        await service.refreshUserCredentials(active.user_id);

        const after = store.getCredentials(active.user_id);
        expect(after).not.toBeNull();
        expect(after?.refreshToken).not.toBe(before.refreshToken);
        expect(after?.accessExpiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(after?.refreshExpiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(after?.status).toBe("CONNECTED");
      } catch (error) {
        rethrowWithoutSecrets(error, sensitiveValues);
      } finally {
        database.sqlite.close();
      }
    },
    60_000,
  );
});
