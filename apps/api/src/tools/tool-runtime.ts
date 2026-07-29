import { createHash } from "node:crypto";
import type { ActorContext as EnterpriseActorContext } from "@codexplatform/contracts";
import type { DynamicToolDefinition } from "../infra/codex/codex-runtime.js";
import type { JsonValue } from "../infra/codex/generated/serde_json/JsonValue.js";
import type { SafeDemoDatabase } from "./demo-db.js";
import type { FeishuContentClient } from "./feishu-client.js";

export interface DynamicToolCall {
  accountId: string;
  connectionGeneration: number;
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

interface ActorContext extends EnterpriseActorContext {
  taskId: string;
  accessToken: string;
}

interface FeishuClientPort {
  search(query: string, options?: { pageSize?: number; pageToken?: string }): Promise<unknown>;
  readDocument(url: string): Promise<unknown>;
  createDocument(input: { title: string; content: string; folderToken?: string }): Promise<unknown>;
  updateDocument(input: { url: string; content: string }): Promise<unknown>;
}

interface EnterpriseToolRuntimeOptions {
  resolveActor: (identity: {
    accountId: string;
    connectionGeneration: number;
    threadId: string;
    turnId: string;
  }) => ActorContext | null | Promise<ActorContext | null>;
  createFeishuClient: (accessToken: string) => FeishuClientPort | FeishuContentClient;
  demoDatabase: SafeDemoDatabase;
  onInvocation?: (event: ToolInvocationAudit) => void | Promise<void>;
  claimWriteInvocation?: (
    event: Omit<ToolInvocationAudit, "response" | "success" | "completedAt">,
  ) =>
    | Promise<
        | { kind: "CLAIMED" }
        | { kind: "IN_PROGRESS" }
        | { kind: "CONFLICT" }
        | { kind: "REPLAY"; response: unknown }
      >
    | { kind: "CLAIMED" }
    | { kind: "IN_PROGRESS" }
    | { kind: "CONFLICT" }
    | { kind: "REPLAY"; response: unknown };
  completeWriteInvocation?: (event: ToolInvocationAudit) => void | Promise<void>;
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
      definition(
        "feishu_doc_create",
        "Create a Feishu Docx as the authenticated employee. This is an external write and requires an automatically approved Turn.",
        {
          type: "object",
          additionalProperties: false,
          required: ["title", "content"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 800 },
            content: { type: "string", minLength: 1, maxLength: 100_000 },
            folderToken: { type: "string", minLength: 4, maxLength: 256 },
          },
        },
      ),
      definition(
        "feishu_doc_update",
        "Append content to a Feishu Docx visible to the authenticated employee. This is an external write and requires an automatically approved Turn.",
        {
          type: "object",
          additionalProperties: false,
          required: ["url", "content"],
          properties: {
            url: { type: "string", format: "uri" },
            content: { type: "string", minLength: 1, maxLength: 100_000 },
          },
        },
      ),
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
    const actor = await this.options.resolveActor({
      accountId: call.accountId,
      connectionGeneration: call.connectionGeneration,
      threadId: call.threadId,
      turnId: call.turnId,
    });
    if (!actor) return failure("Tool call is not bound to an active user turn");
    if (!actor.toolScopes.includes(call.tool)) {
      return failure("Enterprise tool is not allowed for this actor");
    }
    if (isFeishuWriteTool(call.tool) && actor.approvalPolicy !== "AUTO") {
      return failure("Feishu document writes require Approve for me or Full access for this Turn");
    }

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
    let durableWriteClaimed = false;
    if (isFeishuWriteTool(call.tool) && this.options.claimWriteInvocation) {
      const claim = await this.options.claimWriteInvocation({
        callId: call.callId,
        taskId: actor.taskId,
        threadId: call.threadId,
        turnId: call.turnId,
        userId: actor.userId,
        tool: call.tool,
        arguments: call.arguments,
        startedAt,
      });
      if (claim.kind === "REPLAY") return storedDynamicToolResponse(claim.response);
      if (claim.kind === "IN_PROGRESS") {
        return failure("Feishu write outcome is awaiting recovery; the write was not repeated");
      }
      if (claim.kind === "CONFLICT") {
        return failure("Tool callId was replayed with different arguments");
      }
      durableWriteClaimed = true;
    }
    let response: DynamicToolResponse;
    try {
      const args = asRecord(call.arguments);
      switch (call.tool) {
        case "feishu_wiki_search":
          response = success(
            await this.options
              .createFeishuClient(actor.accessToken)
              .search(requiredString(args.query, "query"), {}),
          );
          break;
        case "feishu_doc_read":
          response = success(
            await this.options
              .createFeishuClient(actor.accessToken)
              .readDocument(requiredString(args.url, "url")),
          );
          break;
        case "feishu_doc_create": {
          const folderToken = optionalString(args.folderToken, "folderToken");
          response = success(
            await this.options.createFeishuClient(actor.accessToken).createDocument({
              title: requiredString(args.title, "title"),
              content: requiredString(args.content, "content"),
              ...(folderToken ? { folderToken } : {}),
            }),
          );
          break;
        }
        case "feishu_doc_update":
          response = success(
            await this.options.createFeishuClient(actor.accessToken).updateDocument({
              url: requiredString(args.url, "url"),
              content: requiredString(args.content, "content"),
            }),
          );
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
    const invocation = {
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
    } satisfies ToolInvocationAudit;
    if (durableWriteClaimed && this.options.completeWriteInvocation) {
      try {
        await this.options.completeWriteInvocation(invocation);
      } catch {
        response = failure(
          "Feishu write completed but its durable receipt failed; recovery is required",
        );
      }
    } else if (this.options.onInvocation) {
      try {
        await this.options.onInvocation(invocation);
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
  inputSchema: JsonValue,
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

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${field}`);
  return value;
}

function isFeishuWriteTool(tool: string): boolean {
  return tool === "feishu_doc_create" || tool === "feishu_doc_update";
}

function storedDynamicToolResponse(value: unknown): DynamicToolResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failure("Stored Tool receipt is invalid; recovery is required");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.success !== "boolean" || !Array.isArray(record.contentItems)) {
    return failure("Stored Tool receipt is invalid; recovery is required");
  }
  const contentItems = record.contentItems.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const content = item as Record<string, unknown>;
    return content.type === "inputText" && typeof content.text === "string"
      ? [{ type: "inputText" as const, text: content.text }]
      : [];
  });
  if (contentItems.length !== record.contentItems.length) {
    return failure("Stored Tool receipt is invalid; recovery is required");
  }
  return { success: record.success, contentItems };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Enterprise tool failed";
  return message.replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{32,}/g, "[REDACTED]");
}
