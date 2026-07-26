import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { SecretStore } from "../security/secret-store.js";
import type { FeishuTokenSet, FeishuUserInfo } from "./feishu-oauth-client.js";

export interface PlatformUser {
  id: string;
  tenantKey: string;
  openId: string;
  unionId: string | null;
  name: string;
  avatarUrl: string | null;
  role: "ADMIN" | "MEMBER";
}

export interface StoredFeishuCredentials extends FeishuTokenSet {
  userId: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

interface UserRow {
  id: string;
  tenant_key: string;
  open_id: string;
  union_id: string | null;
  name: string;
  avatar_url: string | null;
  role: "ADMIN" | "MEMBER";
}

interface CredentialRow {
  user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_expires_at: number;
  refresh_expires_at: number;
  scopes: string;
  token_type: string;
}

export class SQLiteAuthStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly secrets: SecretStore,
  ) {}

  createOAuthState(state: string, now: Date, ttlMs = 10 * 60_000): void {
    this.sqlite
      .prepare("INSERT INTO oauth_states (state_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(hash(state), now.getTime(), now.getTime() + ttlMs);
  }

  consumeOAuthState(state: string, now: Date): boolean {
    return this.immediateTransaction(() => {
      const result = this.sqlite
        .prepare(
          `UPDATE oauth_states SET consumed_at = ?
           WHERE state_hash = ? AND consumed_at IS NULL AND expires_at >= ?`,
        )
        .run(now.getTime(), hash(state), now.getTime());
      return result.changes === 1;
    });
  }

  saveLogin(input: {
    identity: FeishuUserInfo;
    tokens: FeishuTokenSet;
    role: PlatformUser["role"];
    now: Date;
    sessionToken: string;
    csrfToken: string;
    sessionTtlMs: number;
  }): PlatformUser {
    return this.immediateTransaction(() => {
      const existing = this.sqlite
        .prepare("SELECT id FROM users WHERE tenant_key = ? AND open_id = ?")
        .get(input.identity.tenantKey, input.identity.openId) as { id: string } | undefined;
      const userId = existing?.id ?? randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO users (
            id, tenant_key, open_id, union_id, name, avatar_url, role, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_key, open_id) DO UPDATE SET
             union_id = excluded.union_id,
             name = excluded.name,
             avatar_url = excluded.avatar_url,
             updated_at = excluded.updated_at`,
        )
        .run(
          userId,
          input.identity.tenantKey,
          input.identity.openId,
          input.identity.unionId,
          input.identity.name,
          input.identity.avatarUrl,
          input.role,
          input.now.getTime(),
          input.now.getTime(),
        );
      this.upsertCredentials(userId, input.tokens, input.now);
      this.sqlite
        .prepare(
          `INSERT INTO sessions (
            id, token_hash, csrf_hash, user_id, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          hash(input.sessionToken),
          hash(input.csrfToken),
          userId,
          input.now.getTime(),
          input.now.getTime() + input.sessionTtlMs,
        );
      return this.getUser(userId);
    });
  }

  resolveSession(
    sessionToken: string,
    now: Date,
  ): { user: PlatformUser; csrfHash: string; expiresAt: Date } | null {
    const row = this.sqlite
      .prepare(
        `SELECT u.*, s.csrf_hash, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      )
      .get(hash(sessionToken), now.getTime()) as
      | (UserRow & { csrf_hash: string; expires_at: number })
      | undefined;
    if (!row) return null;
    return {
      user: mapUser(row),
      csrfHash: row.csrf_hash,
      expiresAt: new Date(row.expires_at),
    };
  }

  verifyCsrf(expectedHash: string, providedToken: string): boolean {
    return expectedHash === hash(providedToken);
  }

  getCredentials(userId: string): StoredFeishuCredentials | null {
    const row = this.sqlite
      .prepare("SELECT * FROM feishu_credentials WHERE user_id = ?")
      .get(userId) as CredentialRow | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      accessToken: this.secrets.decrypt(row.access_token_encrypted),
      refreshToken: this.secrets.decrypt(row.refresh_token_encrypted),
      accessExpiresAt: new Date(row.access_expires_at),
      refreshExpiresAt: new Date(row.refresh_expires_at),
      expiresIn: Math.max(0, Math.round((row.access_expires_at - Date.now()) / 1_000)),
      refreshTokenExpiresIn: Math.max(0, Math.round((row.refresh_expires_at - Date.now()) / 1_000)),
      scopes: JSON.parse(row.scopes) as string[],
      tokenType: row.token_type,
    };
  }

  rotateCredentials(userId: string, tokens: FeishuTokenSet, now: Date): void {
    this.immediateTransaction(() => {
      const exists = this.sqlite
        .prepare("SELECT 1 FROM feishu_credentials WHERE user_id = ?")
        .get(userId);
      if (!exists) throw new Error(`Missing Feishu credentials for user ${userId}`);
      this.upsertCredentials(userId, tokens, now);
    });
  }

  countUsers(): number {
    return this.count("users");
  }

  countCredentials(): number {
    return this.count("feishu_credentials");
  }

  countSessions(): number {
    return this.count("sessions");
  }

  private getUser(userId: string): PlatformUser {
    const row = this.sqlite.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
      | UserRow
      | undefined;
    if (!row) throw new Error(`Unknown user ${userId}`);
    return mapUser(row);
  }

  private upsertCredentials(userId: string, tokens: FeishuTokenSet, now: Date): void {
    this.sqlite
      .prepare(
        `INSERT INTO feishu_credentials (
          user_id, access_token_encrypted, refresh_token_encrypted, access_expires_at,
          refresh_expires_at, scopes, token_type, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           access_token_encrypted = excluded.access_token_encrypted,
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           access_expires_at = excluded.access_expires_at,
           refresh_expires_at = excluded.refresh_expires_at,
           scopes = excluded.scopes,
           token_type = excluded.token_type,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        this.secrets.encrypt(tokens.accessToken),
        this.secrets.encrypt(tokens.refreshToken),
        now.getTime() + tokens.expiresIn * 1_000,
        now.getTime() + tokens.refreshTokenExpiresIn * 1_000,
        JSON.stringify(tokens.scopes),
        tokens.tokenType,
        now.getTime(),
      );
  }

  private count(table: "users" | "feishu_credentials" | "sessions"): number {
    const row = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mapUser(row: UserRow): PlatformUser {
  return {
    id: row.id,
    tenantKey: row.tenant_key,
    openId: row.open_id,
    unionId: row.union_id,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
  };
}
