import { type SpawnOptionsWithoutStdio, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { CodexAppServerRuntime } from "./codex-runtime.js";
import { DEFAULT_RPC_REQUEST_TIMEOUT_MS, JsonlRpcClient } from "./jsonl-rpc-client.js";

export const CODEX_PINNED_VERSION = "0.144.6";

export interface SpawnedCodexProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { env: NodeJS.ProcessEnv },
) => SpawnedCodexProcess;

type ReadVersion = (binaryPath: string, environment: NodeJS.ProcessEnv) => string;

interface SupervisorOptions {
  binaryPath?: string;
  spawnProcess?: SpawnProcess;
  readVersion?: ReadVersion;
  requestTimeoutMs?: number;
}

const CODEX_ENV_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "NIX_SSL_CERT_FILE",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "NO_COLOR",
  "FORCE_COLOR",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLUMNS",
  "LINES",
] as const;

const PROCESS_STOP_GRACE_MS = 50;
const PROCESS_KILL_GRACE_MS = 50;

export interface ManagedCodexRuntime {
  accountId: string;
  codexHome: string;
  process: SpawnedCodexProcess;
  rpc: JsonlRpcClient;
  runtime: CodexAppServerRuntime;
}

interface AccountStartState {
  cancelled: boolean;
  stopReason: Error | null;
  child: SpawnedCodexProcess | null;
  rpc: JsonlRpcClient | null;
}

interface InFlightAccountStart {
  state: AccountStartState;
  promise: Promise<ManagedCodexRuntime>;
}

interface ProcessLifecycle {
  done: boolean;
  terminated: Promise<void>;
  resolve: () => void;
}

export class CodexRuntimeSupervisor extends EventEmitter {
  private readonly binaryPath: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly readVersion: ReadVersion;
  private readonly requestTimeoutMs: number;
  private readonly runtimes = new Map<string, ManagedCodexRuntime>();
  private readonly inFlightStarts = new Map<string, InFlightAccountStart>();
  private readonly intentionallyStopping = new WeakSet<SpawnedCodexProcess>();
  private readonly processLifecycles = new WeakMap<SpawnedCodexProcess, ProcessLifecycle>();
  private readonly processStopTasks = new WeakMap<SpawnedCodexProcess, Promise<void>>();
  private versionVerified = false;

  constructor(options: SupervisorOptions = {}) {
    super();
    this.binaryPath =
      options.binaryPath ??
      process.env.CODEX_BINARY ??
      resolve(process.cwd(), "node_modules", ".bin", "codex");
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.readVersion = options.readVersion ?? defaultReadVersion;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_RPC_REQUEST_TIMEOUT_MS;
  }

  startAccount(input: { accountId: string; codexHome: string }): Promise<ManagedCodexRuntime> {
    const existing = this.runtimes.get(input.accountId);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.inFlightStarts.get(input.accountId);
    if (inFlight) return inFlight.promise;

    const state: AccountStartState = {
      cancelled: false,
      stopReason: null,
      child: null,
      rpc: null,
    };
    const promise = Promise.resolve()
      .then(() => this.initializeAccount(input, state))
      .finally(() => {
        if (this.inFlightStarts.get(input.accountId)?.state === state) {
          this.inFlightStarts.delete(input.accountId);
        }
      });
    this.inFlightStarts.set(input.accountId, { state, promise });
    return promise;
  }

  private async initializeAccount(
    input: {
      accountId: string;
      codexHome: string;
    },
    state: AccountStartState,
  ): Promise<ManagedCodexRuntime> {
    this.throwIfStartCancelled(input.accountId, state);
    const environment = buildCodexEnvironment(input.codexHome);
    this.verifyVersion(environment);

    await mkdir(input.codexHome, { recursive: true, mode: 0o700 });
    this.throwIfStartCancelled(input.accountId, state);
    await chmod(input.codexHome, 0o700);
    this.throwIfStartCancelled(input.accountId, state);

    const child = this.spawnProcess(
      this.binaryPath,
      [
        "app-server",
        "--stdio",
        "--strict-config",
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        'model_provider="codexplatform_openai_https"',
        "-c",
        'model_providers.codexplatform_openai_https.name="OpenAI"',
        "-c",
        'model_providers.codexplatform_openai_https.base_url="https://chatgpt.com/backend-api/codex"',
        "-c",
        'model_providers.codexplatform_openai_https.wire_api="responses"',
        "-c",
        "model_providers.codexplatform_openai_https.requires_openai_auth=true",
        "-c",
        "model_providers.codexplatform_openai_https.supports_websockets=false",
      ],
      {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    state.child = child;
    child.stderr.on("data", () => undefined);
    const rpc = new JsonlRpcClient({
      readable: child.stdout,
      writable: child.stdin,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    state.rpc = rpc;
    const runtime = new CodexAppServerRuntime(rpc);
    const managed: ManagedCodexRuntime = {
      accountId: input.accountId,
      codexHome: input.codexHome,
      process: child,
      rpc,
      runtime,
    };
    this.observeProcess(input.accountId, managed);

    try {
      await runtime.initialize();
      this.throwIfStartCancelled(input.accountId, state);
      this.runtimes.set(input.accountId, managed);
      return managed;
    } catch (error) {
      const reason =
        state.stopReason ??
        (error instanceof Error ? error : new Error("Codex initialization failed"));
      rpc.close(reason);
      await this.stopProcess(child);
      throw reason;
    }
  }

  private throwIfStartCancelled(accountId: string, state: AccountStartState): void {
    if (!state.cancelled) return;
    if (!state.stopReason) {
      state.stopReason = new Error(`Codex App Server start cancelled for account ${accountId}`);
    }
    throw state.stopReason;
  }

  private observeProcess(accountId: string, managed: ManagedCodexRuntime): void {
    const child = managed.process;
    let resolveTermination: () => void = () => undefined;
    const lifecycle: ProcessLifecycle = {
      done: false,
      terminated: new Promise<void>((resolvePromise) => {
        resolveTermination = resolvePromise;
      }),
      resolve: () => resolveTermination(),
    };
    this.processLifecycles.set(child, lifecycle);

    const finish = (reason: Error, exitCode: number | null, signal: string | null) => {
      if (lifecycle.done) return;
      lifecycle.done = true;
      const wasIntentional = this.intentionallyStopping.delete(child);
      if (this.runtimes.get(accountId) === managed) {
        this.runtimes.delete(accountId);
      }
      managed.rpc.close(reason);
      if (!wasIntentional) {
        this.emit("accountCrashed", {
          accountId,
          exitCode,
          signal,
        });
      }
      lifecycle.resolve();
    };

    child.once("exit", (exitCode, signal) => {
      finish(
        new Error(`Codex App Server exited (${exitCode ?? signal ?? "unknown"})`),
        typeof exitCode === "number" ? exitCode : null,
        typeof signal === "string" ? signal : null,
      );
    });
    child.on("error", (error) => finish(error, null, null));
  }

  hasAccount(accountId: string): boolean {
    return this.runtimes.has(accountId);
  }

  getAccount(accountId: string): ManagedCodexRuntime | null {
    return this.runtimes.get(accountId) ?? null;
  }

  async stopAccount(accountId: string): Promise<void> {
    const reason = new Error(`Codex App Server stopped for account ${accountId}`);
    const inFlight = this.inFlightStarts.get(accountId);
    const started = inFlight
      ? inFlight.promise.then(
          (managed) => managed,
          () => null,
        )
      : Promise.resolve(null);
    const children = new Set<SpawnedCodexProcess>();

    if (inFlight) {
      inFlight.state.cancelled = true;
      inFlight.state.stopReason = reason;
      inFlight.state.rpc?.close(reason);
      if (inFlight.state.child) children.add(inFlight.state.child);
    }

    const managed = this.runtimes.get(accountId);
    if (managed) {
      this.runtimes.delete(accountId);
      managed.rpc.close(reason);
      children.add(managed.process);
    }

    const stopTasks = [...children].map((child) => this.stopProcess(child));
    const [startedRuntime] = await Promise.all([started, Promise.all(stopTasks)]);
    if (startedRuntime) await this.stopManagedRuntime(startedRuntime, reason);

    const resurrected = this.runtimes.get(accountId);
    if (resurrected) await this.stopManagedRuntime(resurrected, reason);
  }

  async stopAll(): Promise<void> {
    const accountIds = new Set([...this.runtimes.keys(), ...this.inFlightStarts.keys()]);
    await Promise.all([...accountIds].map((accountId) => this.stopAccount(accountId)));
  }

  private async stopManagedRuntime(managed: ManagedCodexRuntime, reason: Error): Promise<void> {
    if (this.runtimes.get(managed.accountId) === managed) {
      this.runtimes.delete(managed.accountId);
    }
    managed.rpc.close(reason);
    await this.stopProcess(managed.process);
  }

  private stopProcess(child: SpawnedCodexProcess): Promise<void> {
    const lifecycle = this.processLifecycles.get(child);
    if (lifecycle?.done) return Promise.resolve();
    this.intentionallyStopping.add(child);
    const existing = this.processStopTasks.get(child);
    if (existing) return existing;
    const stop = this.stopProcessOnce(child, lifecycle);
    this.processStopTasks.set(child, stop);
    return stop;
  }

  private async stopProcessOnce(
    child: SpawnedCodexProcess,
    lifecycle: ProcessLifecycle | undefined,
  ): Promise<void> {
    safelyKill(child, "SIGTERM");
    if (!lifecycle || (await waitForTermination(lifecycle, PROCESS_STOP_GRACE_MS))) return;
    safelyKill(child, "SIGKILL");
    await waitForTermination(lifecycle, PROCESS_KILL_GRACE_MS);
  }

  private verifyVersion(environment: NodeJS.ProcessEnv): void {
    if (this.versionVerified) return;
    const received = this.readVersion(this.binaryPath, environment).trim();
    if (received !== `codex-cli ${CODEX_PINNED_VERSION}`) {
      throw new Error(`Expected Codex ${CODEX_PINNED_VERSION}, received ${received}`);
    }
    this.versionVerified = true;
  }
}

const defaultSpawn: SpawnProcess = (command, args, options) => {
  return spawn(command, args, options) as unknown as SpawnedCodexProcess;
};

function defaultReadVersion(binaryPath: string, environment: NodeJS.ProcessEnv): string {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    env: environment,
  });
  if (result.error) {
    throw new Error(`Unable to execute Codex binary at ${binaryPath}`);
  }
  if (result.status !== 0) {
    const termination =
      result.status === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.status}`;
    throw new Error(`Unable to verify Codex binary at ${binaryPath} (${termination})`);
  }
  return result.stdout;
}

function buildCodexEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of CODEX_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.HOME = codexHome;
  environment.CODEX_HOME = codexHome;
  return environment;
}

function safelyKill(child: SpawnedCodexProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // The process may already have terminated between the lifecycle check and the signal.
  }
}

function waitForTermination(lifecycle: ProcessLifecycle, timeoutMs: number): Promise<boolean> {
  if (lifecycle.done) return Promise.resolve(true);
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (terminated: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(terminated);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    lifecycle.terminated.then(() => finish(true));
  });
}
