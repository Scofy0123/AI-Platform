import { EventEmitter, once } from "node:events";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CODEX_PINNED_VERSION,
  CodexRuntimeSupervisor,
  type SpawnedCodexProcess,
} from "./runtime-supervisor.js";

describe("CodexRuntimeSupervisor", () => {
  const supervisors: CodexRuntimeSupervisor[] = [];

  afterEach(async () => {
    await Promise.all(supervisors.map((supervisor) => supervisor.stopAll()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("creates a private CODEX_HOME and reuses one initialized process per account", async () => {
    const child = new FakeCodexProcess();
    const spawnProcess = vi.fn(() => child);
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess,
      readVersion: () => `codex-cli ${CODEX_PINNED_VERSION}`,
    });
    supervisors.push(supervisor);
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const codexHome = join(root, "account-1");

    const first = await supervisor.startAccount({ accountId: "account-1", codexHome });
    const second = await supervisor.startAccount({ accountId: "account-1", codexHome });

    expect(second).toBe(first);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/codex",
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
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_HOME: codexHome }),
      }),
    );
    expect((await stat(codexHome)).mode & 0o777).toBe(0o700);
    expect(child.received).toEqual([
      expect.objectContaining({ id: 1, method: "initialize" }),
      { method: "initialized" },
    ]);
  });

  test("passes only explicitly allowed environment variables to Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const codexHome = join(root, "account-1");
    const child = new FakeCodexProcess();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    let versionProbeEnv: NodeJS.ProcessEnv | undefined;
    const spawnProcess = vi.fn((...args: unknown[]) => {
      spawnedEnv = (args[2] as { env: NodeJS.ProcessEnv }).env;
      return child;
    });
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess,
      readVersion: (...args: unknown[]) => {
        versionProbeEnv = args[1] as NodeJS.ProcessEnv | undefined;
        return `codex-cli ${CODEX_PINNED_VERSION}`;
      },
    });
    supervisors.push(supervisor);

    await withProcessEnvironment(
      {
        HOME: "/Users/platform-operator",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        TMPDIR: "/private/tmp/platform-operator/",
        USER: "platform-operator",
        SHELL: "/bin/zsh",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.internal:8080",
        HTTP_PROXY: "http://proxy-user:proxy-password@proxy.internal:8080",
        ALL_PROXY: "socks5://proxy-user:proxy-password@proxy.internal:1080",
        FTP_PROXY: "http://proxy-user:proxy-password@proxy.internal:8080",
        NO_PROXY: "localhost,127.0.0.1",
        https_proxy: "http://proxy-user:proxy-password@proxy.internal:8080",
        http_proxy: "http://proxy-user:proxy-password@proxy.internal:8080",
        all_proxy: "socks5://proxy-user:proxy-password@proxy.internal:1080",
        ftp_proxy: "http://proxy-user:proxy-password@proxy.internal:8080",
        no_proxy: "localhost,127.0.0.1",
        NODE_EXTRA_CA_CERTS: "/etc/company-ca.pem",
        TERM: "xterm-256color",
        FEISHU_APP_SECRET: "feishu-secret-value",
        FEISHU_TOKEN_ENCRYPTION_KEY: "token-encryption-key-value",
        CODEXPLATFORM_REVIEW_SENTINEL: "review-sentinel-value",
        ARBITRARY_CALLER_VARIABLE: "must-not-cross-the-boundary",
      },
      () => supervisor.startAccount({ accountId: "account-1", codexHome }),
    );

    const expectedEnvironment = {
      CODEX_HOME: codexHome,
      HOME: codexHome,
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      TMPDIR: "/private/tmp/platform-operator/",
      USER: "platform-operator",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      NODE_EXTRA_CA_CERTS: "/etc/company-ca.pem",
      TERM: "xterm-256color",
    };
    const expectedKeys = Object.keys(expectedEnvironment).sort();
    expect(Object.keys(spawnedEnv ?? {}).sort()).toEqual(expectedKeys);
    expect(spawnedEnv).toEqual(expectedEnvironment);
    expect(Object.keys(versionProbeEnv ?? {}).sort()).toEqual(expectedKeys);
    expect(versionProbeEnv).toEqual(expectedEnvironment);
  });

  test("uses the safe environment for the real default version probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const binaryPath = join(root, "fake-codex");
    await writeFile(
      binaryPath,
      [
        "#!/bin/sh",
        'if [ -n "$FEISHU_APP_SECRET" ] || [ -n "$FEISHU_TOKEN_ENCRYPTION_KEY" ] || [ -n "$CODEXPLATFORM_REVIEW_SENTINEL" ]; then',
        "  printf '%s\\n' 'version-probe-received-secret' >&2",
        "  exit 86",
        "fi",
        `printf '%s\\n' 'codex-cli ${CODEX_PINNED_VERSION}'`,
      ].join("\n"),
      { mode: 0o700 },
    );
    const spawnProcess = vi.fn(() => new FakeCodexProcess());
    const supervisor = new CodexRuntimeSupervisor({ binaryPath, spawnProcess });
    supervisors.push(supervisor);

    await withProcessEnvironment(
      {
        HOME: "/Users/platform-operator",
        PATH: "/usr/bin:/bin",
        FEISHU_APP_SECRET: "raw-feishu-secret",
        FEISHU_TOKEN_ENCRYPTION_KEY: "raw-encryption-key",
        CODEXPLATFORM_REVIEW_SENTINEL: "raw-review-sentinel",
      },
      () =>
        supervisor.startAccount({
          accountId: "account-1",
          codexHome: join(root, "account-1"),
        }),
    );

    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  test("does not include raw version-probe stderr in failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const binaryPath = join(root, "failing-codex");
    const stderrSecret = "RAW_VERSION_STDERR_SECRET";
    await writeFile(
      binaryPath,
      ["#!/bin/sh", `printf '%s\\n' '${stderrSecret}' >&2`, "exit 42"].join("\n"),
      { mode: 0o700 },
    );
    const spawnProcess = vi.fn(() => new FakeCodexProcess());
    const supervisor = new CodexRuntimeSupervisor({ binaryPath, spawnProcess });
    supervisors.push(supervisor);

    const error = await supervisor
      .startAccount({ accountId: "account-1", codexHome: join(root, "account-1") })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Unable to verify Codex binary at ${binaryPath} (exit 42)`,
    );
    expect((error as Error).message).not.toContain(stderrSecret);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  test("shares one in-flight initialization between concurrent starts for an account", async () => {
    const children: FakeCodexProcess[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeCodexProcess();
      children.push(child);
      return child;
    });
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess,
      readVersion: () => `codex-cli ${CODEX_PINNED_VERSION}`,
    });
    supervisors.push(supervisor);
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const input = { accountId: "account-1", codexHome: join(root, "account-1") };

    const [first, second] = await Promise.all([
      supervisor.startAccount(input),
      supervisor.startAccount(input),
    ]);

    expect(second).toBe(first);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
  });

  test("clears a failed in-flight initialization so the account can retry", async () => {
    let failInitialization = true;
    const children: FakeCodexProcess[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeCodexProcess(
        failInitialization
          ? { initializeError: "initialization failed", emitExitOnKill: false }
          : { emitExitOnKill: true },
      );
      children.push(child);
      return child;
    });
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess,
      readVersion: () => `codex-cli ${CODEX_PINNED_VERSION}`,
    });
    supervisors.push(supervisor);
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const input = { accountId: "account-1", codexHome: join(root, "account-1") };

    const [firstFailure, secondFailure] = await Promise.allSettled([
      supervisor.startAccount(input),
      supervisor.startAccount(input),
    ]);
    expect(firstFailure.status).toBe("rejected");
    expect(secondFailure.status).toBe("rejected");
    if (firstFailure.status !== "rejected" || secondFailure.status !== "rejected") {
      throw new Error("Both concurrent starts must reject when shared initialization fails");
    }
    expect(secondFailure.reason).toBe(firstFailure.reason);

    const failedChild = children[0];
    if (!failedChild) throw new Error("Expected the failed Codex process to be captured");
    failInitialization = false;
    const retried = await supervisor.startAccount(input);

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(supervisor.getAccount(input.accountId)).toBe(retried);

    failedChild.emit("exit", 0, null);
    expect(supervisor.getAccount(input.accountId)).toBe(retried);
  });

  test("stopAccount cancels deferred initialization and escalates to SIGKILL", async () => {
    const startingChild = new FakeCodexProcess({
      initializeDeferred: true,
      exitOnSignals: ["SIGKILL"],
    });
    const retryChild = new FakeCodexProcess();
    const spawnProcess = vi
      .fn<() => FakeCodexProcess>()
      .mockReturnValueOnce(startingChild)
      .mockReturnValueOnce(retryChild);
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess,
      readVersion: () => `codex-cli ${CODEX_PINNED_VERSION}`,
    });
    supervisors.push(supervisor);
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const input = { accountId: "account-1", codexHome: join(root, "account-1") };

    const startOutcome = settle(supervisor.startAccount(input));
    await vi.waitFor(() => {
      expect(startingChild.received).toContainEqual(
        expect.objectContaining({ method: "initialize" }),
      );
    });

    await supervisor.stopAccount(input.accountId);
    startingChild.completeInitialize();

    await expect(startOutcome).resolves.toMatchObject({ status: "rejected" });
    expect(startingChild.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(supervisor.hasAccount(input.accountId)).toBe(false);

    const retried = await supervisor.startAccount(input);
    expect(retried.process).toBe(retryChild);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  test("stopAll cancels and waits for every deferred initialization", async () => {
    const children = [
      new FakeCodexProcess({ initializeDeferred: true }),
      new FakeCodexProcess({ initializeDeferred: true }),
    ];
    let nextChild = 0;
    const spawnProcess = vi.fn(() => {
      const child = children[nextChild];
      nextChild += 1;
      if (!child) throw new Error("Unexpected extra Codex spawn");
      return child;
    });
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess,
      readVersion: () => `codex-cli ${CODEX_PINNED_VERSION}`,
    });
    supervisors.push(supervisor);
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const starts = [
      settle(
        supervisor.startAccount({ accountId: "account-1", codexHome: join(root, "account-1") }),
      ),
      settle(
        supervisor.startAccount({ accountId: "account-2", codexHome: join(root, "account-2") }),
      ),
    ];
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));

    await supervisor.stopAll();
    for (const child of children) child.completeInitialize();

    const outcomes = await Promise.all(starts);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(children.map((child) => child.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
    expect(supervisor.hasAccount("account-1")).toBe(false);
    expect(supervisor.hasAccount("account-2")).toBe(false);
  });

  test("consumes child process errors during initialization and allows retry", async () => {
    const failingChild = new FakeCodexProcess({ initializeDeferred: true });
    const retryChild = new FakeCodexProcess();
    const spawnProcess = vi
      .fn<() => FakeCodexProcess>()
      .mockReturnValueOnce(failingChild)
      .mockReturnValueOnce(retryChild);
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess,
      readVersion: () => `codex-cli ${CODEX_PINNED_VERSION}`,
    });
    supervisors.push(supervisor);
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    const input = { accountId: "account-1", codexHome: join(root, "account-1") };

    const startOutcome = settle(supervisor.startAccount(input));
    await vi.waitFor(() => {
      expect(failingChild.received).toContainEqual(
        expect.objectContaining({ method: "initialize" }),
      );
    });
    const errorListenerCount = failingChild.listenerCount("error");
    let emittedError: unknown;
    try {
      failingChild.emit("error", new Error("spawn transport failed"));
    } catch (error) {
      emittedError = error;
      failingChild.completeInitialize();
    }

    expect(emittedError).toBeUndefined();
    await expect(startOutcome).resolves.toMatchObject({ status: "rejected" });
    expect(errorListenerCount).toBeGreaterThan(0);

    const retried = await supervisor.startAccount(input);
    expect(retried.process).toBe(retryChild);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  test("drains child stderr without logging its contents", async () => {
    const child = new FakeCodexProcess();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess: () => child,
      readVersion: () => `codex-cli ${CODEX_PINNED_VERSION}`,
    });
    supervisors.push(supervisor);
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));

    await supervisor.startAccount({
      accountId: "account-1",
      codexHome: join(root, "account-1"),
    });
    child.stderr.write("FEISHU_APP_SECRET=must-not-be-logged");

    expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);
    expect(child.stderr.readableLength).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("fails closed when the installed Codex version differs from the pinned protocol", async () => {
    const spawnProcess = vi.fn(() => new FakeCodexProcess());
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess,
      readVersion: () => "codex-cli 0.145.0",
    });
    supervisors.push(supervisor);

    await expect(
      supervisor.startAccount({ accountId: "account-1", codexHome: "/tmp/not-created" }),
    ).rejects.toThrow(`Expected Codex ${CODEX_PINNED_VERSION}, received codex-cli 0.145.0`);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  test("removes crashed runtimes and reports that their tasks need recovery", async () => {
    const child = new FakeCodexProcess();
    const supervisor = new CodexRuntimeSupervisor({
      binaryPath: "/opt/codex",
      spawnProcess: () => child,
      readVersion: () => `codex-cli ${CODEX_PINNED_VERSION}`,
    });
    supervisors.push(supervisor);
    const root = await mkdtemp(join(tmpdir(), "codexplatform-supervisor-"));
    await supervisor.startAccount({ accountId: "account-1", codexHome: join(root, "account-1") });
    const crash = once(supervisor, "accountCrashed");

    child.emit("exit", 9, null);

    await expect(crash).resolves.toEqual([
      expect.objectContaining({ accountId: "account-1", exitCode: 9 }),
    ]);
    expect(supervisor.hasAccount("account-1")).toBe(false);
  });
});

interface FakeCodexProcessOptions {
  initializeError?: string;
  initializeDeferred?: boolean;
  emitExitOnKill?: boolean;
  exitOnSignals?: NodeJS.Signals[];
}

class FakeCodexProcess extends EventEmitter implements SpawnedCodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Array<Record<string, unknown>> = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly pid = 12_345;
  killed = false;
  private initializeId: number | string | undefined;

  constructor(private readonly options: FakeCodexProcessOptions = {}) {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>;
        this.received.push(message);
        if (message.method === "initialize") {
          if (typeof message.id !== "number" && typeof message.id !== "string") {
            throw new Error("Expected initialize request id");
          }
          this.initializeId = message.id;
          if (this.options.initializeError) {
            this.stdout.write(
              `${JSON.stringify({
                id: message.id,
                error: { code: -32_000, message: this.options.initializeError },
              })}\n`,
            );
            continue;
          }
          if (!this.options.initializeDeferred) this.completeInitialize();
        }
      }
    });
  }

  completeInitialize(): void {
    if (this.initializeId === undefined) throw new Error("No deferred initialize request exists");
    this.stdout.write(
      `${JSON.stringify({
        id: this.initializeId,
        result: {
          userAgent: `codex/${CODEX_PINNED_VERSION}`,
          codexHome: "/tmp/fake",
          platformFamily: "unix",
          platformOs: "macos",
        },
      })}\n`,
    );
    this.initializeId = undefined;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    const shouldExit = this.options.exitOnSignals
      ? this.options.exitOnSignals.includes(signal)
      : (this.options.emitExitOnKill ?? true);
    if (shouldExit) this.emit("exit", null, signal);
    return true;
  }
}

async function withProcessEnvironment<T>(
  environment: NodeJS.ProcessEnv,
  callback: () => Promise<T>,
): Promise<T> {
  const originalEnvironment = process.env;
  process.env = environment;
  try {
    return await callback();
  } finally {
    process.env = originalEnvironment;
  }
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}
