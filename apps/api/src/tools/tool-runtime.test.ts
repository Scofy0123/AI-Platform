import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SafeDemoDatabase } from "./demo-db.js";
import { EnterpriseToolRuntime } from "./tool-runtime.js";

describe("EnterpriseToolRuntime", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  test("binds dynamic tool calls to the active Feishu actor and deduplicates callId", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, hasMore: false, results: [] });
    const onInvocation = vi.fn();
    const runtime = createRuntime({ search }, onInvocation);
    const call = {
      accountId: "account-1",
      connectionGeneration: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "feishu_wiki_search",
      arguments: { query: "AI" },
    };

    const first = await runtime.invoke(call);
    const second = await runtime.invoke(call);

    expect(first).toEqual(second);
    expect(search).toHaveBeenCalledTimes(1);
    expect(onInvocation).toHaveBeenCalledTimes(1);
    expect(onInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        userId: "user-1",
        callId: "call-1",
        tool: "feishu_wiki_search",
        success: true,
      }),
    );
    expect(search).toHaveBeenCalledWith("AI", {});
    expect(first).toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ total: 0, hasMore: false, results: [] }),
        },
      ],
    });
  });

  test("rejects a stale turn so another user cannot replay a tool call", async () => {
    const runtime = createRuntime();

    await expect(
      runtime.invoke({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "thread-1",
        turnId: "turn-other",
        callId: "call-1",
        namespace: null,
        tool: "demo_business_get",
        arguments: { resource: "order", id: "order-1" },
      }),
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Tool call is not bound to an active user turn" }],
    });
  });

  test("fails closed when the immutable ActorContext does not grant the requested Tool Scope", async () => {
    const runtime = createRuntime({}, undefined, ["feishu_doc_read"]);

    await expect(
      runtime.invoke({
        accountId: "account-1",
        connectionGeneration: 1,
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "scope-denied",
        namespace: null,
        tool: "demo_db_query",
        arguments: { sql: "SELECT id FROM demo_orders" },
      }),
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "Enterprise tool is not allowed for this actor" }],
    });
  });

  test("exposes only the four MVP tools and runs safe demo queries", async () => {
    const runtime = createRuntime();
    expect(runtime.definitions().map((tool) => tool.name)).toEqual([
      "feishu_wiki_search",
      "feishu_doc_read",
      "demo_db_query",
      "demo_business_get",
    ]);

    const result = await runtime.invoke({
      accountId: "account-1",
      connectionGeneration: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-db",
      namespace: null,
      tool: "demo_db_query",
      arguments: { sql: "SELECT id, status FROM demo_orders" },
    });
    expect(result.success).toBe(true);
    expect(result.contentItems[0]?.text).toContain("order-1");
  });

  function createRuntime(
    feishuOverrides: Record<string, unknown> = {},
    onInvocation?: ConstructorParameters<typeof EnterpriseToolRuntime>[0]["onInvocation"],
    toolScopes = ["feishu_wiki_search", "feishu_doc_read", "demo_db_query", "demo_business_get"],
  ) {
    const sqlite = new Database(":memory:");
    databases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE demo_orders (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO demo_orders VALUES ('order-1', 'PAID');
    `);
    const feishu = {
      search: vi.fn().mockResolvedValue({ total: 0, hasMore: false, results: [] }),
      readDocument: vi.fn().mockResolvedValue({ title: "Doc", blocks: [] }),
      ...feishuOverrides,
    };
    return new EnterpriseToolRuntime({
      resolveActor: (identity) =>
        identity.accountId === "account-1" &&
        identity.connectionGeneration === 1 &&
        identity.threadId === "thread-1" &&
        identity.turnId === "turn-1"
          ? {
              taskId: "task-1",
              tenantKey: "tenant-1",
              userId: "user-1",
              role: "MEMBER" as const,
              toolScopes,
              approvalPolicy: "ASK",
              accessToken: "user-token",
            }
          : null,
      createFeishuClient: () => feishu,
      demoDatabase: new SafeDemoDatabase(sqlite, { allowedTables: ["demo_orders"] }),
      ...(onInvocation ? { onInvocation } : {}),
    });
  }
});
