export interface FeishuOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface FeishuTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
  scopes: string[];
  tokenType: string;
}

export interface FeishuUserInfo {
  openId: string;
  unionId: string | null;
  tenantKey: string;
  name: string;
  avatarUrl: string | null;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class FeishuApiError extends Error {
  readonly name = "FeishuApiError";

  constructor(
    readonly code: number,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class FeishuOAuthClient {
  constructor(
    private readonly config: FeishuOAuthConfig,
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  createAuthorizationUrl(state: string): string {
    const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    url.searchParams.set("client_id", this.config.appId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string): Promise<FeishuTokenSet> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      code,
      redirect_uri: this.config.redirectUri,
    });
  }

  async refreshTokens(refreshToken: string): Promise<FeishuTokenSet> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      refresh_token: refreshToken,
    });
  }

  async getUserInfo(accessToken: string): Promise<FeishuUserInfo> {
    const response = await this.fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await parseJson(response);
    assertFeishuSuccess(body, response.status);
    const data = isRecord(body.data) ? body.data : body;
    const openId = requiredString(data.open_id, "open_id");
    const tenantKey = requiredString(data.tenant_key, "tenant_key");
    return {
      openId,
      unionId: optionalString(data.union_id),
      tenantKey,
      name: requiredString(data.name, "name"),
      avatarUrl: optionalString(data.avatar_url),
    };
  }

  private async tokenRequest(payload: Record<string, string>): Promise<FeishuTokenSet> {
    const response = await this.fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await parseJson(response);
    assertFeishuSuccess(body, response.status);
    const data = isRecord(body.data) ? body.data : body;
    return {
      accessToken: requiredString(data.access_token, "access_token"),
      refreshToken: requiredString(data.refresh_token, "refresh_token"),
      expiresIn: requiredNumber(data.expires_in, "expires_in"),
      refreshTokenExpiresIn: requiredNumber(
        data.refresh_token_expires_in,
        "refresh_token_expires_in",
      ),
      scopes: requiredString(data.scope, "scope").split(/\s+/).filter(Boolean),
      tokenType: optionalString(data.token_type) ?? "Bearer",
    };
  }
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = (await response.json()) as unknown;
    if (!isRecord(value)) throw new Error("response is not an object");
    return value;
  } catch {
    throw new FeishuApiError(-1, "Feishu returned an invalid JSON response", response.status);
  }
}

function assertFeishuSuccess(body: Record<string, unknown>, status: number): void {
  const code = typeof body.code === "number" ? body.code : 0;
  if (status >= 400 || code !== 0) {
    throw new FeishuApiError(
      code || status,
      optionalString(body.msg) ?? optionalString(body.message) ?? "Feishu API request failed",
      status,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FeishuApiError(-1, `Feishu response is missing ${field}`, 502);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FeishuApiError(-1, `Feishu response is missing ${field}`, 502);
  }
  return value;
}
