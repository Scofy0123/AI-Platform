import { isAbsolute, resolve } from "node:path";

export type RuntimeMode = "fake" | "real";
export type LoopbackHost = "127.0.0.1" | "localhost" | "::1";

export interface AppConfig {
  server: {
    host: LoopbackHost;
    port: number;
    webOrigin: string;
  };
  storage: {
    databasePath: string;
    runtimeDataDir: string;
  };
  runtime: {
    mode: RuntimeMode;
    codexBinary: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    redirectUri: string;
    tenantKey: string;
    adminOpenIds: string[];
    firstAdminOpenId: string;
    tokenEncryptionKey: string;
    scopes: string[];
  };
}

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

const DEFAULT_HOST: LoopbackHost = "127.0.0.1";
const DEFAULT_PORT = 4310;

const FEISHU_SCOPES = [
  "auth:user.id:read",
  "offline_access",
  "search:docs:read",
  "docx:document:readonly",
  "wiki:node:read",
  "wiki:node:retrieve",
  "wiki:space:retrieve",
] as const;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const host = parseHost(env.HOST);
  const port = parsePort(env.PORT);
  const runtimeMode = parseRuntimeMode(env.RUNTIME_MODE);
  const databasePath = optionalText(env.DATABASE_PATH) ?? ".data/codexplatform.sqlite";
  const runtimeDataDir = optionalText(env.RUNTIME_DATA_DIR) ?? ".data/runtime";
  if (runtimeMode === "real" && (!isAbsolute(databasePath) || !isAbsolute(runtimeDataDir))) {
    throw new ConfigurationError("real runtime storage paths must be absolute");
  }
  const appId = requiredText(env.FEISHU_APP_ID, "FEISHU_APP_ID");
  const appSecret = requiredText(env.FEISHU_APP_SECRET, "FEISHU_APP_SECRET");
  const tenantKey = requiredText(env.FEISHU_TENANT_KEY, "FEISHU_TENANT_KEY");
  const adminOpenIds = parseAdminOpenIds(env.FEISHU_ADMIN_OPEN_IDS);
  const tokenEncryptionKey = parseEncryptionKey(env.FEISHU_TOKEN_ENCRYPTION_KEY);
  const redirectUri = parseOAuthCallback(
    env.FEISHU_REDIRECT_URI ?? `http://${formatUrlHost(host)}:${port}/api/auth/feishu/callback`,
  );
  const webOrigin = parseLoopbackOrigin(optionalText(env.WEB_ORIGIN) ?? "http://127.0.0.1:5173");

  return {
    server: { host, port, webOrigin },
    storage: {
      databasePath: resolvePath(workingDirectory, databasePath),
      runtimeDataDir: resolvePath(workingDirectory, runtimeDataDir),
    },
    runtime: {
      mode: runtimeMode,
      codexBinary: resolvePath(
        workingDirectory,
        optionalText(env.CODEX_BIN) ?? "node_modules/.bin/codex",
      ),
    },
    feishu: {
      appId,
      appSecret,
      redirectUri,
      tenantKey,
      adminOpenIds,
      firstAdminOpenId: adminOpenIds[0],
      tokenEncryptionKey,
      scopes: [...FEISHU_SCOPES],
    },
  };
}

function parseHost(value: string | undefined): LoopbackHost {
  const host = optionalText(value) ?? DEFAULT_HOST;
  if (!isLoopbackHost(host)) {
    throw new ConfigurationError("HOST must be a loopback address");
  }
  return host;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) {
    throw new ConfigurationError("PORT must be an integer between 1 and 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseRuntimeMode(value: string | undefined): RuntimeMode {
  const mode = optionalText(value) ?? "fake";
  if (mode !== "fake" && mode !== "real") {
    throw new ConfigurationError("RUNTIME_MODE must be fake or real");
  }
  return mode;
}

function parseAdminOpenIds(value: string | undefined): [string, ...string[]] {
  const raw = requiredText(value, "FEISHU_ADMIN_OPEN_IDS");
  const openIds = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  if (openIds.length === 0) {
    throw new ConfigurationError("FEISHU_ADMIN_OPEN_IDS is required");
  }
  return openIds as [string, ...string[]];
}

function parseEncryptionKey(value: string | undefined): string {
  const key = requiredText(value, "FEISHU_TOKEN_ENCRYPTION_KEY");
  const decoded = Buffer.from(key, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== key) {
    throw new ConfigurationError(
      "FEISHU_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  return key;
}

function parseOAuthCallback(value: string): string {
  const url = parseUrl(value, "FEISHU_REDIRECT_URI must be a loopback OAuth callback URL");
  if (
    url.protocol !== "http:" ||
    !isLoopbackHostname(url.hostname) ||
    url.pathname !== "/api/auth/feishu/callback" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigurationError("FEISHU_REDIRECT_URI must be a loopback OAuth callback URL");
  }
  return url.toString();
}

function parseLoopbackOrigin(value: string): string {
  const message = "WEB_ORIGIN must be a loopback HTTP or HTTPS origin";
  const url = parseUrl(value, message);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopbackHostname(url.hostname) ||
    url.pathname !== "/" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigurationError(message);
  }
  return url.origin;
}

function parseUrl(value: string, safeMessage: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ConfigurationError(safeMessage);
  }
}

function requiredText(value: string | undefined, field: string): string {
  const parsed = optionalText(value);
  if (!parsed) throw new ConfigurationError(`${field} is required`);
  return parsed;
}

function optionalText(value: string | undefined): string | null {
  const parsed = value?.trim();
  return parsed ? parsed : null;
}

function resolvePath(workingDirectory: string, value: string): string {
  return resolve(workingDirectory, value);
}

function isLoopbackHost(value: string): value is LoopbackHost {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isLoopbackHostname(value: string): boolean {
  return isLoopbackHost(value === "[::1]" ? "::1" : value);
}

function formatUrlHost(host: LoopbackHost): string {
  return host === "::1" ? "[::1]" : host;
}
