import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ConfigurationError, loadConfig } from "./config.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    FEISHU_APP_ID: "cli_test_app",
    FEISHU_APP_SECRET: "super-sensitive-app-secret",
    FEISHU_TENANT_KEY: "tenant-test",
    FEISHU_ADMIN_OPEN_IDS: "ou_admin",
    FEISHU_TOKEN_ENCRYPTION_KEY: encryptionKey,
    ...overrides,
  };
}

describe("loadConfig", () => {
  test("defaults to the loopback API address and fake runtime", () => {
    const config = loadConfig(validEnv(), "/workspace/codexplatform");

    expect(config.server).toEqual({
      host: "127.0.0.1",
      port: 4310,
      webOrigin: "http://127.0.0.1:5173",
    });
    expect(config.runtime.mode).toBe("fake");
    expect(config.feishu.redirectUri).toBe("http://127.0.0.1:4310/api/auth/feishu/callback");
  });

  test.each(["0.0.0.0", "192.168.1.10", "example.com"])("rejects non-loopback host %s", (host) => {
    expect(() => loadConfig(validEnv({ HOST: host }))).toThrow("HOST must be a loopback address");
  });

  test.each(["127.0.0.1", "localhost", "::1"])("accepts loopback host %s", (host) => {
    expect(loadConfig(validEnv({ HOST: host })).server.host).toBe(host);
  });

  test("allows HTTPS on a loopback web origin so production cookies can be Secure", () => {
    expect(loadConfig(validEnv({ WEB_ORIGIN: "https://localhost:5173" })).server.webOrigin).toBe(
      "https://localhost:5173",
    );
  });

  test("validates the TCP port without echoing the supplied value", () => {
    const secretPort = "99999-sensitive";

    expect(() => loadConfig(validEnv({ PORT: secretPort }))).toThrow("PORT must be an integer");
    try {
      loadConfig(validEnv({ PORT: secretPort }));
    } catch (error) {
      expect(String(error)).not.toContain(secretPort);
    }
  });

  test.each(["fake", "real"] as const)("accepts %s runtime mode", (mode) => {
    const paths =
      mode === "real"
        ? {
            DATABASE_PATH: "/private/var/codexplatform.sqlite",
            RUNTIME_DATA_DIR: "/private/var/codexplatform-runtime",
          }
        : {};
    expect(loadConfig(validEnv({ RUNTIME_MODE: mode, ...paths })).runtime.mode).toBe(mode);
  });

  test("rejects an unknown runtime mode", () => {
    expect(() => loadConfig(validEnv({ RUNTIME_MODE: "staging" }))).toThrow(
      "RUNTIME_MODE must be fake or real",
    );
  });

  test("rejects worktree-relative storage paths in real runtime mode", () => {
    expect(() =>
      loadConfig(
        validEnv({
          RUNTIME_MODE: "real",
          DATABASE_PATH: "../../.data/real-codexplatform.sqlite",
          RUNTIME_DATA_DIR: "../../.data/real-runtime",
        }),
        "/workspace/worktrees/feature/apps/api",
      ),
    ).toThrow("real runtime storage paths must be absolute");
  });

  test("resolves storage and Codex binary paths against the supplied working directory", () => {
    const cwd = "/workspace/codexplatform";
    const config = loadConfig(
      validEnv({
        DATABASE_PATH: "var/platform.sqlite",
        RUNTIME_DATA_DIR: "var/runtime",
        CODEX_BIN: "vendor/codex",
      }),
      cwd,
    );

    expect(config.storage.databasePath).toBe(resolve(cwd, "var/platform.sqlite"));
    expect(config.storage.runtimeDataDir).toBe(resolve(cwd, "var/runtime"));
    expect(config.runtime.codexBinary).toBe(resolve(cwd, "vendor/codex"));
  });

  test("keeps absolute storage and binary paths unchanged", () => {
    const config = loadConfig(
      validEnv({
        DATABASE_PATH: "/private/var/platform.sqlite",
        RUNTIME_DATA_DIR: "/private/var/runtime",
        CODEX_BIN: "/opt/codex/bin/codex",
      }),
      "/workspace/codexplatform",
    );

    expect(config.storage.databasePath).toBe("/private/var/platform.sqlite");
    expect(config.storage.runtimeDataDir).toBe("/private/var/runtime");
    expect(config.runtime.codexBinary).toBe("/opt/codex/bin/codex");
  });

  test.each([
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_TENANT_KEY",
    "FEISHU_ADMIN_OPEN_IDS",
    "FEISHU_TOKEN_ENCRYPTION_KEY",
  ])("requires %s", (field) => {
    expect(() => loadConfig(validEnv({ [field]: "" }))).toThrow(`${field} is required`);
  });

  test("parses multiple administrator Open IDs and exposes the first as bootstrap admin", () => {
    const config = loadConfig(
      validEnv({ FEISHU_ADMIN_OPEN_IDS: " ou_first,ou_second  ou_third " }),
    );

    expect(config.feishu.adminOpenIds).toEqual(["ou_first", "ou_second", "ou_third"]);
    expect(config.feishu.firstAdminOpenId).toBe("ou_first");
  });

  test("requires a loopback OAuth callback with the expected path", () => {
    expect(() =>
      loadConfig(
        validEnv({
          FEISHU_REDIRECT_URI: "https://public.example.com/api/auth/feishu/callback",
        }),
      ),
    ).toThrow("FEISHU_REDIRECT_URI must be a loopback OAuth callback URL");
    expect(() =>
      loadConfig(validEnv({ FEISHU_REDIRECT_URI: "http://127.0.0.1:4310/not-the-callback" })),
    ).toThrow("FEISHU_REDIRECT_URI must be a loopback OAuth callback URL");
  });

  test("accepts only a canonical base64 key decoding to exactly 32 bytes", () => {
    expect(loadConfig(validEnv()).feishu.tokenEncryptionKey).toBe(encryptionKey);
    expect(() =>
      loadConfig(validEnv({ FEISHU_TOKEN_ENCRYPTION_KEY: Buffer.alloc(31).toString("base64") })),
    ).toThrow("FEISHU_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    expect(() => loadConfig(validEnv({ FEISHU_TOKEN_ENCRYPTION_KEY: "!".repeat(44) }))).toThrow(
      "FEISHU_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  });

  test("never includes Feishu secrets or encryption keys in configuration errors", () => {
    const appSecret = "sensitive-app-secret-do-not-print";
    const invalidKey = "sensitive-invalid-key-do-not-print";

    try {
      loadConfig(
        validEnv({
          FEISHU_APP_SECRET: appSecret,
          FEISHU_TOKEN_ENCRYPTION_KEY: invalidKey,
        }),
      );
      throw new Error("expected configuration parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain(appSecret);
      expect(String(error)).not.toContain(invalidKey);
    }
  });
});
