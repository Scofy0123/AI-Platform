import { describe, expect, test } from "vitest";
import { ActorRegistry } from "./actor-registry.js";

describe("ActorRegistry", () => {
  test("stores an immutable full ActorContext and rejects a conflicting binding", () => {
    const registry = new ActorRegistry();
    const toolScopes = ["feishu_doc_read"];
    const binding = {
      accountId: "account-1",
      connectionGeneration: 7,
      threadId: "thread-1",
      turnId: "turn-1",
      taskId: "task-1",
      actorContext: {
        tenantKey: "tenant-1",
        userId: "user-1",
        role: "MEMBER" as const,
        toolScopes,
        approvalPolicy: "ASK",
      },
    };
    registry.bind(binding);
    toolScopes.push("demo_db_query");

    expect(
      registry.resolve({
        accountId: "account-1",
        connectionGeneration: 7,
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).toMatchObject({
      taskId: "task-1",
      actorContext: {
        tenantKey: "tenant-1",
        userId: "user-1",
        toolScopes: ["feishu_doc_read"],
      },
    });
    expect(() =>
      registry.bind({
        ...binding,
        taskId: "other-task",
        actorContext: { ...binding.actorContext, userId: "user-2" },
      }),
    ).toThrow(/conflict/i);
  });
});
