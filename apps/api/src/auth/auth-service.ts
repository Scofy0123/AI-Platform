import { randomBytes } from "node:crypto";
import type { PlatformUser, SQLiteAuthStore } from "./auth-store.js";
import type { FeishuTokenSet, FeishuUserInfo } from "./feishu-oauth-client.js";

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
}

export class AuthService {
  private readonly now: () => Date;
  private readonly sessionTtlMs: number;

  constructor(private readonly options: AuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60_000;
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

  resolveSession(
    sessionToken: string,
  ): { user: PlatformUser; csrfHash: string; expiresAt: Date } | null {
    return this.options.store.resolveSession(sessionToken, this.now());
  }

  verifyCsrf(expectedHash: string, providedToken: string): boolean {
    return this.options.store.verifyCsrf(expectedHash, providedToken);
  }

  async refreshUserCredentials(userId: string): Promise<void> {
    const current = this.options.store.getCredentials(userId);
    if (!current) throw new Error(`Missing Feishu credentials for user ${userId}`);
    const refreshed = await this.options.identity.refreshTokens(current.refreshToken);
    this.options.store.rotateCredentials(userId, refreshed, this.now());
  }
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function boundState(state: string, browserBinding: string): string {
  return `${state}.${browserBinding}`;
}
