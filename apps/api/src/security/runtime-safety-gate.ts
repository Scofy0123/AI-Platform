import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CREDENTIAL_READ_BLOCKED_MARKER = "CODEXPLATFORM_CREDENTIAL_SENTINEL_READ_BLOCKED";

const SENTINEL_READABLE_EXIT_CODE = 71;
const PROBE_ERROR_EXIT_CODE = 72;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

export interface SandboxProbeRequest {
  binaryPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  workspacePath: string;
  tempRoot: string;
  codexHome: string;
  sentinelPath: string;
  timeoutMs: number;
}

export interface SandboxProbeCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
}

export type SandboxProbeRunner = (
  request: SandboxProbeRequest,
) => Promise<SandboxProbeCommandResult>;

export type CredentialIsolationProbeResult =
  | {
      status: "ISOLATED";
      safeForMultiUser: true;
      evidence: "SANDBOX_DENIED_SENTINEL_READ";
      checkedAt: string;
    }
  | {
      status: "READABLE";
      safeForMultiUser: false;
      evidence: "SANDBOX_READ_SENTINEL";
      checkedAt: string;
    }
  | {
      status: "ERROR";
      safeForMultiUser: false;
      evidence: "PROBE_EXECUTION_FAILED";
      checkedAt: string;
    };

interface CredentialIsolationProbeOptions {
  binaryPath: string;
  workspacePath: string;
  runner?: SandboxProbeRunner;
  timeoutMs?: number;
  now?: () => Date;
}

export async function probeCodexCredentialIsolation(
  options: CredentialIsolationProbeOptions,
): Promise<CredentialIsolationProbeResult> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  let tempRoot: string | undefined;
  let result: CredentialIsolationProbeResult = probeError(checkedAt);

  try {
    tempRoot = await mkdtemp(join(tmpdir(), "codexplatform-safety-"));
    await chmod(tempRoot, 0o700);

    const codexHome = join(tempRoot, "codex-home");
    await mkdir(codexHome, { mode: 0o700 });
    await chmod(codexHome, 0o700);

    const sentinelPath = join(codexHome, "credential-sentinel");
    const sentinel = `codexplatform-${randomBytes(32).toString("hex")}`;
    await writeFile(sentinelPath, sentinel, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(sentinelPath, 0o600);

    const request: SandboxProbeRequest = {
      binaryPath: options.binaryPath,
      args: buildSandboxProbeArgs(options.workspacePath, sentinelPath),
      env: buildProbeEnvironment(codexHome, tempRoot),
      workspacePath: options.workspacePath,
      tempRoot,
      codexHome,
      sentinelPath,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    };
    const commandResult = await (options.runner ?? runSandboxProbeCommand)(request);

    if (commandResult.stdout.includes(sentinel) || commandResult.stderr.includes(sentinel)) {
      result = {
        status: "READABLE",
        safeForMultiUser: false,
        evidence: "SANDBOX_READ_SENTINEL",
        checkedAt,
      };
    } else if (
      commandResult.exitCode === 0 &&
      !commandResult.timedOut &&
      !commandResult.signal &&
      commandResult.stdout.trim() === CREDENTIAL_READ_BLOCKED_MARKER
    ) {
      result = {
        status: "ISOLATED",
        safeForMultiUser: true,
        evidence: "SANDBOX_DENIED_SENTINEL_READ",
        checkedAt,
      };
    }
  } catch {
    result = probeError(checkedAt);
  }

  if (tempRoot) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      return probeError(checkedAt);
    }
  }

  return result;
}

export interface RealCodexAccessInput {
  userId: string;
  operatorUserId: string;
  activeUserIds: readonly string[];
  probe: CredentialIsolationProbeResult;
}

export interface RealCodexAccessDecision {
  allowed: boolean;
  shouldQueue: boolean;
  mode: "SHARED_UP_TO_FOUR" | "SINGLE_OPERATOR";
  maxConcurrentUsers: 4 | 1;
  code:
    | "SHARED_EXECUTION_ALLOWED"
    | "SHARED_USER_LIMIT_REACHED"
    | "SINGLE_OPERATOR_ALLOWED"
    | "CREDENTIAL_ISOLATION_REQUIRED";
  message: string;
}

export function decideRealCodexAccess(input: RealCodexAccessInput): RealCodexAccessDecision {
  if (input.probe.status !== "ISOLATED" || !input.probe.safeForMultiUser) {
    if (input.userId === input.operatorUserId) {
      return {
        allowed: true,
        shouldQueue: false,
        mode: "SINGLE_OPERATOR",
        maxConcurrentUsers: 1,
        code: "SINGLE_OPERATOR_ALLOWED",
        message: "Credential isolation is unverified; real Codex is limited to the operator.",
      };
    }
    return {
      allowed: false,
      shouldQueue: false,
      mode: "SINGLE_OPERATOR",
      maxConcurrentUsers: 1,
      code: "CREDENTIAL_ISOLATION_REQUIRED",
      message:
        "Real Codex multi-user execution is disabled because credential isolation was not verified.",
    };
  }

  const activeUsers = new Set(input.activeUserIds);
  if (activeUsers.has(input.userId) || activeUsers.size < 4) {
    return {
      allowed: true,
      shouldQueue: false,
      mode: "SHARED_UP_TO_FOUR",
      maxConcurrentUsers: 4,
      code: "SHARED_EXECUTION_ALLOWED",
      message: "Codex credential isolation verified; shared execution is enabled.",
    };
  }

  return {
    allowed: false,
    shouldQueue: true,
    mode: "SHARED_UP_TO_FOUR",
    maxConcurrentUsers: 4,
    code: "SHARED_USER_LIMIT_REACHED",
    message: "Four active users already hold this Codex account; the request must queue.",
  };
}

function buildSandboxProbeArgs(workspacePath: string, sentinelPath: string): string[] {
  const readSentinelScript = [
    'const fs = require("node:fs");',
    "try {",
    '  const value = fs.readFileSync(process.argv[1], "utf8");',
    "  process.stdout.write(value);",
    `  process.exit(${SENTINEL_READABLE_EXIT_CODE});`,
    "} catch (error) {",
    '  if (error && (error.code === "EACCES" || error.code === "EPERM")) {',
    `    process.stdout.write(${JSON.stringify(CREDENTIAL_READ_BLOCKED_MARKER)});`,
    "    process.exit(0);",
    "  }",
    `  process.exit(${PROBE_ERROR_EXIT_CODE});`,
    "}",
  ].join("\n");

  return [
    "sandbox",
    "--permission-profile",
    ":workspace",
    "--cd",
    workspacePath,
    "--",
    process.execPath,
    "-e",
    readSentinelScript,
    sentinelPath,
  ];
}

function buildProbeEnvironment(codexHome: string, tempRoot: string): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: codexHome,
    LANG: process.env.LANG ?? "C.UTF-8",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: tempRoot,
  };
}

function probeError(checkedAt: string): CredentialIsolationProbeResult {
  return {
    status: "ERROR",
    safeForMultiUser: false,
    evidence: "PROBE_EXECUTION_FAILED",
    checkedAt,
  };
}

async function runSandboxProbeCommand(
  request: SandboxProbeRequest,
): Promise<SandboxProbeCommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(request.binaryPath, request.args, {
      cwd: request.workspacePath,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(0, MAX_CAPTURED_OUTPUT_BYTES);
}
