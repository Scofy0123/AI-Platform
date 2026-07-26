import { existsSync } from "node:fs";
import { chromium, defineConfig } from "@playwright/test";
import { e2eWebUrl } from "./tests/e2e/config.js";

const explicitChannel = process.env.CODEXPLATFORM_E2E_BROWSER_CHANNEL;
const localChannel =
  explicitChannel ?? (existsSync(chromium.executablePath()) ? undefined : "chrome");

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: ".data/playwright-results",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: e2eWebUrl,
    browserName: "chromium",
    ...(localChannel ? { channel: localChannel } : {}),
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx tests/e2e/start-test-server.ts",
    url: e2eWebUrl,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    timeout: 60_000,
  },
});
