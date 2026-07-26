import { PassThrough, Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { JsonlRpcClient, type RpcError } from "./jsonl-rpc-client.js";

describe("JsonlRpcClient", () => {
  test("correlates requests and responses over newline-delimited JSON", async () => {
    const serverOutput = new PassThrough();
    const clientOutput = new PassThrough();
    const client = new JsonlRpcClient({
      readable: serverOutput,
      writable: clientOutput,
      requestTimeoutMs: 1_000,
    });

    const requestPromise = client.request<{ userAgent: string }>("initialize", {
      clientInfo: { name: "codexplatform" },
    });
    const request = await readJsonLine(clientOutput);

    expect(request).toEqual({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "codexplatform" } },
    });

    serverOutput.write(`${JSON.stringify({ id: 1, result: { userAgent: "codex/0.144.6" } })}\n`);
    await expect(requestPromise).resolves.toEqual({ userAgent: "codex/0.144.6" });
    client.close();
  });

  test("handles fragmented notifications and server requests", async () => {
    const serverOutput = new PassThrough();
    const clientOutput = new PassThrough();
    const notification = vi.fn();
    const serverRequest = vi.fn();
    const client = new JsonlRpcClient({
      readable: serverOutput,
      writable: clientOutput,
      requestTimeoutMs: 1_000,
    });
    client.on("notification", notification);
    client.on("serverRequest", serverRequest);

    serverOutput.write('{"method":"turn/plan/updated","params":{"plan":');
    serverOutput.write('[]}}\n{"id":"approval-1","method":"item/fileChange/requestApproval",');
    serverOutput.write('"params":{"threadId":"thread-1"}}\n');
    await nextTick();

    expect(notification).toHaveBeenCalledWith({
      method: "turn/plan/updated",
      params: { plan: [] },
    });
    expect(serverRequest).toHaveBeenCalledWith({
      id: "approval-1",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1" },
    });
    await client.respond("approval-1", { decision: "accept" });
    expect(await readJsonLine(clientOutput)).toEqual({
      id: "approval-1",
      result: { decision: "accept" },
    });
    client.close();
  });

  test("maps protocol errors and rejects pending requests when the transport closes", async () => {
    const serverOutput = new PassThrough();
    const clientOutput = new PassThrough();
    const client = new JsonlRpcClient({
      readable: serverOutput,
      writable: clientOutput,
      requestTimeoutMs: 1_000,
    });

    const failed = client.request("account/read");
    await readJsonLine(clientOutput);
    serverOutput.write(
      `${JSON.stringify({ id: 1, error: { code: -32_000, message: "not authenticated" } })}\n`,
    );
    await expect(failed).rejects.toEqual(
      expect.objectContaining<RpcError>({
        name: "RpcError",
        code: -32_000,
        message: "not authenticated",
      }),
    );

    const interrupted = client.request("thread/read", { threadId: "thread-1" });
    await readJsonLine(clientOutput);
    client.close(new Error("app-server exited"));
    await expect(interrupted).rejects.toThrow("app-server exited");
  });

  test("does not acknowledge a response until the writable callback completes", async () => {
    const writable = new DeferredWritable();
    const client = new JsonlRpcClient({
      readable: new PassThrough(),
      writable,
      requestTimeoutMs: 1_000,
    });
    let settled = false;

    const response = client.respond(7, { decision: "accept" }).finally(() => {
      settled = true;
    });
    await nextTick();

    expect(settled).toBe(false);
    writable.completeNextWrite();
    await expect(response).resolves.toBeUndefined();
    client.close();
  });

  test("rejects an awaited response on asynchronous write failure or transport close", async () => {
    const writable = new DeferredWritable();
    const client = new JsonlRpcClient({
      readable: new PassThrough(),
      writable,
      requestTimeoutMs: 1_000,
    });

    const failedWrite = client.respond(7, { decision: "accept" });
    writable.completeNextWrite(new Error("async write failed"));
    await expect(failedWrite).rejects.toThrow("async write failed");

    const secondWritable = new DeferredWritable();
    const secondClient = new JsonlRpcClient({
      readable: new PassThrough(),
      writable: secondWritable,
      requestTimeoutMs: 1_000,
    });
    const closedWrite = secondClient.respondError(8, {
      code: -32_601,
      message: "unsupported",
    });
    secondWritable.emit("close");
    await expect(closedWrite).rejects.toThrow("writable transport closed");
  });
});

class DeferredWritable extends Writable {
  private readonly pendingWrites: Array<(error?: Error | null) => void> = [];

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pendingWrites.push(callback);
  }

  completeNextWrite(error?: Error): void {
    const callback = this.pendingWrites.shift();
    if (!callback) throw new Error("No pending write callback");
    callback(error);
  }
}

async function readJsonLine(stream: PassThrough): Promise<Record<string, unknown>> {
  const chunk = await new Promise<Buffer>((resolve) => stream.once("data", resolve));
  return JSON.parse(chunk.toString("utf8").trim()) as Record<string, unknown>;
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
