function resolveLocalUrl(
  explicitUrl: string | undefined,
  legacyPort: string | undefined,
  fallbackPort: string,
): URL {
  const url = new URL(explicitUrl ?? `http://127.0.0.1:${legacyPort ?? fallbackPort}`);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error(`E2E server URL must be loopback HTTP: ${url.origin}`);
  }
  if (!url.port) {
    throw new Error(`E2E server URL must include an explicit port: ${url.origin}`);
  }
  return url;
}

export const e2eWeb = resolveLocalUrl(
  process.env.CODEXPLATFORM_E2E_WEB_URL,
  process.env.CODEXPLATFORM_E2E_WEB_PORT,
  "5174",
);

export const e2eApi = resolveLocalUrl(
  process.env.CODEXPLATFORM_E2E_API_URL,
  process.env.CODEXPLATFORM_E2E_API_PORT,
  "4311",
);

export const e2eWebUrl = e2eWeb.origin;
export const e2eApiUrl = e2eApi.origin;
