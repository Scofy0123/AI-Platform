import { access, readFile, stat } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { runSecurityProbeCli } from "../../../../scripts/security-probe.js";
import {
  CREDENTIAL_READ_BLOCKED_MARKER,
  decideRealCodexAccess,
  probeCodexCredentialIsolation,
  type SandboxProbeRequest,
} from "./runtime-safety-gate.js";

describe("probeCodexCredentialIsolation", () => {
  test("only reports isolation after the sandboxed command explicitly proves read denial", async () => {
    let captured: SandboxProbeRequest | undefined;
    const runner = vi.fn(async (request: SandboxProbeRequest) => {
      captured = request;
      expect((await stat(request.tempRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(request.codexHome)).mode & 0o777).toBe(0o700);
      expect((await stat(request.sentinelPath)).mode & 0o777).toBe(0o600);
      expect(request.binaryPath).toBe("/opt/codex-0.144.6");
      expect(request.args.slice(0, 6)).toEqual([
        "sandbox",
        "--permission-profile",
        ":workspace",
        "--cd",
        "/safe/workspace",
        "--",
      ]);
      expect(request.args.at(-1)).toBe(request.sentinelPath);
      expect(request.env.CODEX_HOME).toBe(request.codexHome);
      return { exitCode: 0, stdout: CREDENTIAL_READ_BLOCKED_MARKER, stderr: "" };
    });

    const result = await probeCodexCredentialIsolation({
      binaryPath: "/opt/codex-0.144.6",
      workspacePath: "/safe/workspace",
      runner,
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    expect(result).toEqual({
      status: "ISOLATED",
      safeForMultiUser: true,
      evidence: "SANDBOX_DENIED_SENTINEL_READ",
      checkedAt: "2026-07-22T00:00:00.000Z",
    });
    expect(runner).toHaveBeenCalledTimes(1);
    await expect(access(captured?.tempRoot ?? "")).rejects.toThrow();
  });

  test("fails closed and does not return the sentinel when the command can read it", async () => {
    let exposedSentinel = "";
    const result = await probeCodexCredentialIsolation({
      binaryPath: "/opt/codex-0.144.6",
      workspacePath: "/safe/workspace",
      runner: async (request) => {
        exposedSentinel = await readFile(request.sentinelPath, "utf8");
        return { exitCode: 71, stdout: exposedSentinel, stderr: "" };
      },
    });

    expect(result).toMatchObject({
      status: "READABLE",
      safeForMultiUser: false,
      evidence: "SANDBOX_READ_SENTINEL",
    });
    expect(JSON.stringify(result)).not.toContain(exposedSentinel);
  });

  test.each([
    {
      name: "the sandbox command exits unexpectedly",
      runner: async () => ({ exitCode: 2, stdout: "", stderr: "invalid config" }),
    },
    {
      name: "the runner throws",
      runner: async () => {
        throw new Error("spawn failed with a sensitive path");
      },
    },
    {
      name: "the denial marker is absent",
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    },
  ])("fails closed when $name", async ({ runner }) => {
    const result = await probeCodexCredentialIsolation({
      binaryPath: "/opt/codex-0.144.6",
      workspacePath: "/safe/workspace",
      runner,
    });

    expect(result).toMatchObject({
      status: "ERROR",
      safeForMultiUser: false,
      evidence: "PROBE_EXECUTION_FAILED",
    });
    expect(result).not.toHaveProperty("error");
  });
});

describe("decideRealCodexAccess", () => {
  const isolatedProbe = {
    status: "ISOLATED" as const,
    safeForMultiUser: true as const,
    evidence: "SANDBOX_DENIED_SENTINEL_READ" as const,
    checkedAt: "2026-07-22T00:00:00.000Z",
  };
  const unsafeProbe = {
    status: "READABLE" as const,
    safeForMultiUser: false as const,
    evidence: "SANDBOX_READ_SENTINEL" as const,
    checkedAt: "2026-07-22T00:00:00.000Z",
  };

  test("allows up to four distinct users only after explicit isolation proof", () => {
    const allowed = decideRealCodexAccess({
      userId: "user-4",
      operatorUserId: "user-1",
      activeUserIds: ["user-1", "user-2", "user-3"],
      probe: isolatedProbe,
    });
    const queued = decideRealCodexAccess({
      userId: "user-5",
      operatorUserId: "user-1",
      activeUserIds: ["user-1", "user-2", "user-3", "user-4"],
      probe: isolatedProbe,
    });

    expect(allowed).toEqual({
      allowed: true,
      shouldQueue: false,
      mode: "SHARED_UP_TO_FOUR",
      maxConcurrentUsers: 4,
      code: "SHARED_EXECUTION_ALLOWED",
      message: "Codex credential isolation verified; shared execution is enabled.",
    });
    expect(queued).toMatchObject({
      allowed: false,
      shouldQueue: true,
      mode: "SHARED_UP_TO_FOUR",
      maxConcurrentUsers: 4,
      code: "SHARED_USER_LIMIT_REACHED",
    });
  });

  test("does not count another turn from an already active user as a fifth user", () => {
    const result = decideRealCodexAccess({
      userId: "user-4",
      operatorUserId: "user-1",
      activeUserIds: ["user-1", "user-2", "user-3", "user-4"],
      probe: isolatedProbe,
    });

    expect(result.allowed).toBe(true);
    expect(result.shouldQueue).toBe(false);
  });

  test.each([
    unsafeProbe,
    {
      status: "ERROR" as const,
      safeForMultiUser: false as const,
      evidence: "PROBE_EXECUTION_FAILED" as const,
      checkedAt: "2026-07-22T00:00:00.000Z",
    },
  ])("allows only the designated operator when isolation is not proven", (probe) => {
    const operator = decideRealCodexAccess({
      userId: "operator",
      operatorUserId: "operator",
      activeUserIds: [],
      probe,
    });
    const member = decideRealCodexAccess({
      userId: "member",
      operatorUserId: "operator",
      activeUserIds: [],
      probe,
    });

    expect(operator).toMatchObject({
      allowed: true,
      shouldQueue: false,
      mode: "SINGLE_OPERATOR",
      maxConcurrentUsers: 1,
      code: "SINGLE_OPERATOR_ALLOWED",
    });
    expect(member).toEqual({
      allowed: false,
      shouldQueue: false,
      mode: "SINGLE_OPERATOR",
      maxConcurrentUsers: 1,
      code: "CREDENTIAL_ISOLATION_REQUIRED",
      message:
        "Real Codex multi-user execution is disabled because credential isolation was not verified.",
    });
  });
});

describe("security probe CLI", () => {
  test("prints machine-readable evidence and succeeds only for verified isolation", async () => {
    const write = vi.fn();
    const result = {
      status: "ISOLATED" as const,
      safeForMultiUser: true as const,
      evidence: "SANDBOX_DENIED_SENTINEL_READ" as const,
      checkedAt: "2026-07-22T00:00:00.000Z",
    };

    const exitCode = await runSecurityProbeCli({
      argv: ["--binary", "/opt/codex", "--workspace", "/workspace"],
      probe: async (input) => {
        expect(input).toMatchObject({
          binaryPath: "/opt/codex",
          workspacePath: "/workspace",
        });
        return result;
      },
      write,
    });

    expect(exitCode).toBe(0);
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(result, null, 2)}\n`);
  });

  test("returns failure for an unsafe or inconclusive result", async () => {
    const exitCode = await runSecurityProbeCli({
      argv: [],
      probe: async () => ({
        status: "ERROR",
        safeForMultiUser: false,
        evidence: "PROBE_EXECUTION_FAILED",
        checkedAt: "2026-07-22T00:00:00.000Z",
      }),
      write: () => undefined,
    });

    expect(exitCode).toBe(1);
  });
});
