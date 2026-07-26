import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { JsonlRpcClient } from "../../apps/api/src/infra/codex/jsonl-rpc-client.js";
import { CodexRuntimeSupervisor } from "../../apps/api/src/infra/codex/runtime-supervisor.js";
import { requireSmokeEnv, rethrowWithoutSecrets } from "./smoke-env.js";

const supervisors: CodexRuntimeSupervisor[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stopAll()));
  await Promise.all(
    workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe("real Codex integration", () => {
  test.skipIf(process.env.REAL_CODEX_E2E !== "1")(
    "initializes the pinned App Server, reads quota, and completes one authenticated turn",
    async () => {
      const codexHome = resolve(requireSmokeEnv("CODEX_E2E_HOME"));
      const binaryPath = resolve(
        process.env.CODEX_BIN?.trim() || join(process.cwd(), "node_modules", ".bin", "codex"),
      );
      await assertExistingCodexSetup(codexHome, binaryPath);

      const workspace = await mkdtemp(join(tmpdir(), "codexplatform-real-smoke-"));
      workspaces.push(workspace);
      const supervisor = new CodexRuntimeSupervisor({
        binaryPath,
        requestTimeoutMs: 60_000,
      });
      supervisors.push(supervisor);

      try {
        const managed = await supervisor.startAccount({
          accountId: "real-smoke-account",
          codexHome,
        });
        const quota = await managed.runtime.readWeeklyQuota();
        expect(["KNOWN", "WEEKLY_QUOTA_UNKNOWN"]).toContain(quota.status);

        const thread = asRecord(
          await managed.runtime.startThread({ cwd: workspace, dynamicTools: [] }),
        );
        const threadId = requiredNestedId(thread, "thread");
        const completion = trackCompletedTurn(managed.rpc);
        try {
          const turn = asRecord(await managed.runtime.startTurn(threadId, smokePrompt()));
          const turnId = requiredNestedId(turn, "turn");

          await expect(completion.promise).resolves.toMatchObject({
            threadId,
            turnId,
            status: "completed",
            responseText: expect.stringContaining("CODEX_SMOKE_OK"),
          });
        } finally {
          completion.cancel();
        }
      } catch (error) {
        rethrowWithoutSecrets(error, []);
      }
    },
    180_000,
  );
});

async function assertExistingCodexSetup(codexHome: string, binaryPath: string): Promise<void> {
  try {
    const home = await stat(codexHome);
    if (!home.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(
      "CODEX_E2E_HOME must point to an existing account home completed through interactive Codex login.",
    );
  }
  try {
    await access(binaryPath);
  } catch {
    throw new Error(
      "Codex binary was not found. Install dependencies or set CODEX_BIN to the pinned 0.144.6 binary.",
    );
  }
}

function smokePrompt(): string {
  return [
    "This is an automated authenticated smoke test.",
    "Do not call tools or modify files.",
    "Reply with exactly CODEX_SMOKE_OK and nothing else.",
  ].join(" ");
}

function trackCompletedTurn(rpc: JsonlRpcClient): {
  promise: Promise<{
    threadId: string;
    turnId: string;
    status: string;
    responseText: string;
  }>;
  cancel: () => void;
} {
  let responseText = "";
  let cancel: () => void = () => undefined;
  const promise = new Promise<{
    threadId: string;
    turnId: string;
    status: string;
    responseText: string;
  }>((resolveCompletion, rejectCompletion) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectCompletion(new Error("Timed out waiting for the real Codex turn to complete."));
    }, 150_000);

    const onNotification = (value: unknown) => {
      const message = asRecord(value);
      const params = asRecord(message.params);
      if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        responseText += params.delta;
        return;
      }
      if (message.method !== "turn/completed") return;
      const turn = asRecord(params.turn);
      if (!responseText && Array.isArray(turn.items)) {
        const agentMessage = turn.items
          .map(asRecord)
          .find((item) => item.type === "agentMessage" && typeof item.text === "string");
        if (typeof agentMessage?.text === "string") responseText = agentMessage.text;
      }
      cleanup();
      const status = typeof turn.status === "string" ? turn.status : "unknown";
      if (status !== "completed") {
        const error = asRecord(turn.error);
        rejectCompletion(
          new Error(
            typeof error.message === "string"
              ? `Real Codex turn ${status}: ${error.message}`
              : `Real Codex turn finished with status ${status}.`,
          ),
        );
        return;
      }
      resolveCompletion({
        threadId: requiredString(params.threadId, "turn/completed threadId"),
        turnId: requiredString(turn.id, "turn/completed turn.id"),
        status,
        responseText,
      });
    };

    const cleanup = () => {
      clearTimeout(timeout);
      rpc.off("notification", onNotification);
    };
    cancel = cleanup;
    rpc.on("notification", onNotification);
  });
  return { promise, cancel };
}

function requiredNestedId(value: Record<string, unknown>, key: string): string {
  return requiredString(asRecord(value[key]).id, `${key}.id`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
