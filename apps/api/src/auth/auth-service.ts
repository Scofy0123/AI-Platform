import { randomBytes } from "node:crypto";
import type { PlatformUser, ResolvedAuthSession, SQLiteAuthStore } from "./auth-store.js";
import { FeishuApiError, type FeishuTokenSet, type FeishuUserInfo } from "./feishu-oauth-client.js";

export interface FeishuIdentityProvider {
  createAuthorizationUrl(state: string): string;
  exchangeAuthorizationCode(code: string): Promise<FeishuTokenSet>;
  getUserInfo(accessToken: string): Promise<FeishuUserInfo>;
  refreshTokens(refreshToken: string): Promise<FeishuTokenSet>;
}

interface AuthServiceOptions {
  identity: FeishuIdentityProvider;
  store: SQLiteAuthStore;
  allowedTenantKey: string;
  firstAdminOpenId: string;
  now?: () => Date;
  sessionTtlMs?: number;
  persistentSessionTtlMs?: number;
}

export class AuthService {
  private readonly now: () => Date;
  private readonly sessionTtlMs: number;
  private readonly persistentSessionTtlMs: number;
  private readonly refreshes = new Map<string, Promise<void>>();

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60_000;
    this.persistentSessionTtlMs = options.persistentSessionTtlMs ?? 30 * 24 * 60 * 60_000;
  }

  startLogin(): { state: string; browserBinding: string; authorizationUrl: string } {
    const state = randomToken();
    const browserBinding = randomToken();
    this.options.store.createOAuthState(boundState(state, browserBinding), this.now());
    return {
      state,
      browserBinding,
      authorizationUrl: this.options.identity.createAuthorizationUrl(state),
    };
  }

  async completeLogin(input: { code: string; state: string; browserBinding: string }): Promise<{
    user: PlatformUser;
    sessionToken: string;
    csrfToken: string;
  }> {
    const now = this.now();
    if (!this.options.store.consumeOAuthState(boundState(input.state, input.browserBinding), now)) {
      throw new Error("OAuth state is invalid, expired, or already used");
    }
    const tokens = await this.options.identity.exchangeAuthorizationCode(input.code);
    const identity = await this.options.identity.getUserInfo(tokens.accessToken);
    if (identity.tenantKey !== this.options.allowedTenantKey) {
      throw new Error("Feishu tenant is not allowed");
    }

    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const user = this.options.store.saveLogin({
      identity,
      tokens,
      role: identity.openId === this.options.firstAdminOpenId ? "ADMIN" : "MEMBER",
      now,
      sessionToken,
      csrfToken,
      sessionTtlMs: this.sessionTtlMs,
    });
    return { user, sessionToken, csrfToken };
  }

  resolveSession(sessionToken: string): ResolvedAuthSession | null {
    return this.options.store.resolveSession(sessionToken, this.now());
  }

  persistSession(sessionToken: string): ResolvedAuthSession | null {
    return this.options.store.persistSession(sessionToken, this.now(), this.persistentSessionTtlMs);
  }

  revokeSession(sessionToken: string): void {
    this.options.store.revokeSession(sessionToken, this.now());
  }

  verifyCsrf(expectedHash: string, providedToken: string): boolean {
    return this.options.store.verifyCsrf(expectedHash, providedToken);
  }

  async refreshUserCredentials(userId: string): Promise<void> {
    const inFlight = this.refreshes.get(userId);
    if (inFlight) return inFlight;
    const refresh = this.performCredentialRefresh(userId).finally(() => {
      this.refreshes.delete(userId);
    });
    this.refreshes.set(userId, refresh);
    return refresh;
  }

  async refreshExpiringCredentials(): Promise<void> {
    const now = this.now();
    const candidates = this.options.store.listCredentialRefreshCandidates(
      now,
      new Date(now.getTime() + 10 * 60_000),
    );
    await Promise.allSettled(candidates.map((userId) => this.refreshUserCredentials(userId)));
  }

  private async performCredentialRefresh(userId: string): Promise<void> {
    const current = this.options.store.getCredentials(userId);
    if (!current) throw new Error(`Missing Feishu credentials for user ${userId}`);
    if (current.status === "REAUTH_REQUIRED") {
      throw new Error("Feishu connection requires reauthorization");
    }
    const startedAt = this.now();
    this.options.store.markCredentialsRefreshing(userId, startedAt);
    try {
      const refreshed = await this.options.identity.refreshTokens(current.refreshToken);
      this.options.store.rotateCredentials(userId, refreshed, this.now());
    } catch (error) {
      if (isPermanentCredentialFailure(error)) {
        const code = error instanceof FeishuApiError ? String(error.code) : "TOKEN_INVALID";
        this.options.store.markCredentialsReauthRequired(userId, this.now(), code);
      } else {
        const code = error instanceof FeishuApiError ? String(error.code) : "TRANSIENT_ERROR";
        this.options.store.markCredentialsConnected(userId, this.now(), code);
      }
      throw error;
    }
  }
}

function isPermanentCredentialFailure(error: unknown): boolean {
  return error instanceof FeishuApiError && error.status >= 400 && error.status < 500
    ? error.status !== 408 && error.status !== 429
    : false;
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function boundState(state: string, browserBinding: string): string {
  return `${state}.${browserBinding}`;
}
