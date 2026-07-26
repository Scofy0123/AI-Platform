import { describe, expect, test, vi } from "vitest";
import { type FeishuApiError, FeishuOAuthClient } from "./feishu-oauth-client.js";

const CONFIG = {
  appId: "cli_test_app",
  appSecret: "test-secret",
  redirectUri: "http://127.0.0.1:4310/api/auth/feishu/callback",
  scopes: ["auth:user.id:read", "offline_access", "search:docs:read"],
};

describe("FeishuOAuthClient", () => {
  test("builds a browser authorization URL with an opaque state", () => {
    const client = new FeishuOAuthClient(CONFIG, vi.fn());
    const url = new URL(client.createAuthorizationUrl("opaque-state"));

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe(CONFIG.appId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("scope")).toBe(CONFIG.scopes.join(" "));
  });

  test("exchanges and refreshes tokens, then loads the authoritative tenant identity", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 7_200,
          refresh_token_expires_in: 2_592_000,
          scope: CONFIG.scopes.join(" "),
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: {
            open_id: "ou_admin",
            union_id: "on_union",
            tenant_key: "tenant-1",
            name: "Admin",
            avatar_url: "https://avatar.example.test/a.png",
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 7_200,
          refresh_token_expires_in: 2_592_000,
          scope: CONFIG.scopes.join(" "),
          token_type: "Bearer",
        }),
      );
    const client = new FeishuOAuthClient(CONFIG, fetch);

    await expect(client.exchangeAuthorizationCode("code-1")).resolves.toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    await expect(client.getUserInfo("access-1")).resolves.toMatchObject({
      openId: "ou_admin",
      tenantKey: "tenant-1",
      name: "Admin",
    });
    await expect(client.refreshTokens("refresh-1")).resolves.toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });

    expect(fetch.mock.calls[0]).toEqual([
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CONFIG.appId,
          client_secret: CONFIG.appSecret,
          code: "code-1",
          redirect_uri: CONFIG.redirectUri,
        }),
      }),
    ]);
    expect(fetch.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ headers: { Authorization: "Bearer access-1" } }),
    );
    expect(fetch.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CONFIG.appId,
          client_secret: CONFIG.appSecret,
          refresh_token: "refresh-1",
        }),
      }),
    );
  });

  test("turns Feishu error envelopes into typed errors without returning tokens", async () => {
    const client = new FeishuOAuthClient(
      CONFIG,
      vi.fn().mockResolvedValue(response({ code: 99991679, msg: "insufficient permission" }, 403)),
    );

    await expect(client.getUserInfo("sentinel-secret-token")).rejects.toEqual(
      expect.objectContaining<FeishuApiError>({
        name: "FeishuApiError",
        code: 99991679,
        status: 403,
        message: "insufficient permission",
      }),
    );
  });
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
