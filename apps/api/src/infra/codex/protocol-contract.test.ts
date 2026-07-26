import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { CODEX_PINNED_VERSION } from "./runtime-supervisor.js";

describe("pinned Codex App Server protocol", () => {
  test("matches the installed package and includes every MVP method", async () => {
    const packageJson = JSON.parse(
      await readFile(
        new URL("../../../../../node_modules/@openai/codex/package.json", import.meta.url),
        "utf8",
      ),
    ) as { version: string };
    const clientRequest = await readFile(
      new URL("./generated/ClientRequest.ts", import.meta.url),
      "utf8",
    );
    const serverRequest = await readFile(
      new URL("./generated/ServerRequest.ts", import.meta.url),
      "utf8",
    );

    expect(packageJson.version).toBe(CODEX_PINNED_VERSION);
    expect(clientRequest).toContain('"method": "initialize"');
    expect(clientRequest).toContain('"method": "account/login/start"');
    expect(clientRequest).toContain('"method": "account/rateLimits/read"');
    expect(clientRequest).toContain('"method": "thread/start"');
    expect(clientRequest).toContain('"method": "thread/resume"');
    expect(clientRequest).toContain('"method": "turn/start"');
    expect(clientRequest).toContain('"method": "turn/steer"');
    expect(clientRequest).toContain('"method": "turn/interrupt"');
    expect(serverRequest).toContain('"method": "item/tool/call"');
    expect(serverRequest).toContain('"method": "item/commandExecution/requestApproval"');
    expect(serverRequest).toContain('"method": "item/fileChange/requestApproval"');
  });
});
