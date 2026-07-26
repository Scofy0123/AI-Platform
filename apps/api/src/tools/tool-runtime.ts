import { createHash } from "node:crypto";
import type { DynamicToolDefinition } from "../infra/codex/codex-runtime.js";
import type { SafeDemoDatabase } from "./demo-db.js";
import type { FeishuContentClient } from "./feishu-client.js";

export interface DynamicToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolResponse {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
}

interface ActorContext {
  taskId: string;
  userId: string;
  accessToken: string;
}

interface FeishuClientPort {
  search(query: string, options?: { pageSize?: number; pageToken?: string }): Promise<unknown>;
  readDocument(url: string): Promise<unknown>;
}

interface EnterpriseToolRuntimeOptions {
  resolveActor: (
    threadId: string,
    turnId: string,
  ) => ActorContext | null | Promise<ActorContext | null>;
  createFeishuClient: (accessToken: string) => FeishuClientPort | FeishuContentClient;
  demoDatabase: SafeDemoDatabase;
  onInvocation?: (event: ToolInvocationAudit) => void | Promise<void>;
}

export interface ToolInvocationAudit {
  callId: string;
  taskId: string;
  threadId: string;
  turnId: string;
  userId: string;
  tool: string;
  arguments: unknown;
  response: DynamicToolResponse;
  success: boolean;
  startedAt: Date;
  completedAt: Date;
}

interface CachedCall {
  fingerprint: string;
  response: DynamicToolResponse;
}

export class EnterpriseToolRuntime {
  private readonly calls = new Map<string, CachedCall>();

  constructor(private readonly options: EnterpriseToolRuntimeOptions) {}

  definitions(): DynamicToolDefinition[] {
    return [
      definition(
        "feishu_wiki_search",
        "Search Feishu Wiki and cloud documents visible to the user",
        {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: { query: { type: "string", maxLength: 30 } },
        },
      ),
      definition("feishu_doc_read", "Read a Feishu Wiki or Docx document visible to the user", {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string", format: "uri" } },
      }),
      definition("demo_db_query", "Run one read-only SELECT against the demo database", {
        type: "object",
        additionalProperties: false,
        required: ["sql"],
        properties: { sql: { type: "string", maxLength: 10_000 } },
      }),
      definition("demo_business_get", "Get deterministic demo business data", {
        type: "object",
        additionalProperties: false,
        required: ["resource", "id"],
        properties: {
          resource: { type: "string", enum: ["order", "customer"] },
          id: { type: "string" },
        },
      }),
    ];
  }

  async invoke(call: DynamicToolCall): Promise<DynamicToolResponse> {
    const actor = await this.options.resolveActor(call.threadId, call.turnId);
    if (!actor) return failure("Tool call is not bound to an active user turn");

    const key = `${call.threadId}:${call.turnId}:${call.callId}`;
    const fingerprint = digest({
      tool: call.tool,
      arguments: call.arguments,
      userId: actor.userId,
    });
    const cached = this.calls.get(key);
    if (cached) {
      return cached.fingerprint === fingerprint
        ? cached.response
        : failure("Tool callId was replayed with different arguments");
    }

    const startedAt = new Date();
    let response: DynamicToolResponse;
    try {
      const args = asRecord(call.arguments);
      const feishu = this.options.createFeishuClient(actor.accessToken);
      switch (call.tool) {
        case "feishu_wiki_search":
          response = success(await feishu.search(requiredString(args.query, "query"), {}));
          break;
        case "feishu_doc_read":
          response = success(await feishu.readDocument(requiredString(args.url, "url")));
          break;
        case "demo_db_query":
          response = success(this.options.demoDatabase.query(requiredString(args.sql, "sql")));
          break;
        case "demo_business_get":
          response = success(
            demoBusinessGet(
              requiredString(args.resource, "resource"),
              requiredString(args.id, "id"),
            ),
          );
          break;
        default:
          response = failure(`Unknown enterprise tool: ${call.tool}`);
      }
    } catch (error) {
      response = failure(safeErrorMessage(error));
    }
    if (this.options.onInvocation) {
      try {
        await this.options.onInvocation({
          callId: call.callId,
          taskId: actor.taskId,
          threadId: call.threadId,
          turnId: call.turnId,
          userId: actor.userId,
          tool: call.tool,
          arguments: call.arguments,
          response,
          success: response.success,
          startedAt,
          completedAt: new Date(),
        });
      } catch {
        response = failure("Tool audit persistence failed");
      }
    }
    this.calls.set(key, { fingerprint, response });
    return response;
  }
}

function definition(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): DynamicToolDefinition {
  return { type: "function", name, description, inputSchema };
}

function success(value: unknown): DynamicToolResponse {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

function failure(message: string): DynamicToolResponse {
  return { success: false, contentItems: [{ type: "inputText", text: message }] };
}

function demoBusinessGet(resource: string, id: string): Record<string, unknown> {
  if (resource === "order") {
    return { id, resource, status: id === "order-1" ? "PAID" : "PENDING", source: "mock" };
  }
  if (resource === "customer") {
    return { id, resource, tier: id.endsWith("1") ? "GOLD" : "STANDARD", source: "mock" };
  }
  throw new Error("Demo business resource must be order or customer");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Enterprise tool failed";
  return message.replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{32,}/g, "[REDACTED]");
}
