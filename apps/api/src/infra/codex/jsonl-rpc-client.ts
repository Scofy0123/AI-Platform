import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type RpcId = number | string;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface PendingWrite {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface JsonlRpcClientOptions {
  readable: Readable;
  writable: Writable;
  requestTimeoutMs?: number;
}

export class RpcError extends Error {
  readonly name = "RpcError";

  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class JsonlRpcClient extends EventEmitter {
  private readonly writable: Writable;
  private readonly requestTimeoutMs: number;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pendingWrites = new Set<PendingWrite>();
  private nextId = 1;
  private closed = false;

  constructor(options: JsonlRpcClientOptions) {
    super();
    this.writable = options.writable;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.lines = createInterface({ input: options.readable, crlfDelay: Number.POSITIVE_INFINITY });
    this.lines.on("line", (line) => this.handleLine(line));
    this.lines.on("close", () => this.close(new Error("Codex App Server transport closed")));
    options.readable.on("error", (error) => this.close(error));
    options.writable.on("error", (error) => this.close(error));
    options.writable.on("close", () =>
      this.close(new Error("Codex App Server writable transport closed")),
    );
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex App Server transport is closed"));
    const id = this.nextId;
    this.nextId += 1;

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
    });
    this.write({ id, method, ...(params === undefined ? {} : { params }) });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: RpcId, result: unknown): Promise<void> {
    return this.writeAwaited({ id, result });
  }

  respondError(id: RpcId, error: { code: number; message: string; data?: unknown }): Promise<void> {
    return this.writeAwaited({ id, error });
  }

  close(reason: Error = new Error("Codex App Server transport closed")): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pending.clear();
    for (const pendingWrite of this.pendingWrites) pendingWrite.reject(reason);
    this.pendingWrites.clear();
    this.emit("closed", reason);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.emit(
        "protocolError",
        new Error(`Invalid JSONL from Codex App Server`, { cause: error }),
      );
      return;
    }

    if ("method" in message) {
      this.emit("id" in message ? "serverRequest" : "notification", message);
      return;
    }

    if (typeof message.id !== "number") {
      this.emit("protocolError", new Error("RPC response is missing a numeric id"));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (isRpcError(message.error)) {
      pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      return;
    }
    pending.resolve(message.result);
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) throw new Error("Codex App Server transport is closed");
    this.writable.write(`${JSON.stringify(message)}\n`);
  }

  private writeAwaited(message: Record<string, unknown>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex App Server transport is closed"));

    let serialized: string;
    try {
      serialized = `${JSON.stringify(message)}\n`;
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<void>((resolve, reject) => {
      const pendingWrite: PendingWrite = { resolve, reject };
      this.pendingWrites.add(pendingWrite);
      const settle = (error?: Error | null): void => {
        if (!this.pendingWrites.delete(pendingWrite)) return;
        if (error) reject(error);
        else resolve();
      };
      try {
        this.writable.write(serialized, settle);
      } catch (error) {
        if (!this.pendingWrites.delete(pendingWrite)) return;
        reject(error);
      }
    });
  }
}

function isRpcError(value: unknown): value is { code: number; message: string; data?: unknown } {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === "number" && typeof error.message === "string";
}
