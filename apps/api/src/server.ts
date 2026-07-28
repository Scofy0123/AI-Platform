import {
  EffectiveConfigOverrideSchema,
  type TaskEvent,
  type Thread,
  UserSettingsPatchSchema,
} from "@codexplatform/contracts";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { FeishuConnectionStatus, PlatformUser } from "./auth/auth-store.js";
import { MAX_TURN_ATTACHMENT_BYTES } from "./domain/attachments.js";
import {
  AllocatedModelSelectionChangedError,
  ModelCatalogUnavailableError,
  ThreadResumeSafetyError,
} from "./domain/platform-service.js";
import {
  type RuntimePathRedactionContext,
  sanitizeEventTransport,
} from "./event-payload-safety.js";
import type { AuthApi, PlatformApi } from "./web-api.js";

interface BuildAppOptions {
  auth?: AuthApi;
  platform?: PlatformApi;
  webOrigin?: string;
  runtimeDataDir?: string;
}

interface ActorSession {
  user: PlatformUser;
  csrfHash: string;
  expiresAt: Date;
  persistent: boolean;
  feishuConnectionStatus: FeishuConnectionStatus;
}

const OAUTH_BINDING_COOKIE = "codexplatform_oauth_binding";
const OAUTH_BINDING_COOKIE_PATH = "/api/auth/feishu/callback";
const SESSION_COOKIE = "codexplatform_session";
const CSRF_COOKIE = "codexplatform_csrf";
const TRUSTED_DEVICE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const runtimePathContext: RuntimePathRedactionContext = options.runtimeDataDir
    ? { runtimeDataDir: options.runtimeDataDir }
    : {};
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  app.register(cookie);
  app.register(sensible);
  app.register(cors, {
    origin: options.webOrigin ?? "http://127.0.0.1:5173",
    credentials: true,
  });
  app.register(multipart, {
    preservePath: true,
    limits: {
      files: 500,
      fileSize: 50 * 1024 * 1024,
      parts: 1_000,
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    }
    if (error instanceof ModelCatalogUnavailableError) {
      return reply.code(503).send({
        error: "MODEL_CATALOG_UNAVAILABLE",
        message: "Runtime model catalog is unavailable",
      });
    }
    if (error instanceof AllocatedModelSelectionChangedError) {
      return reply.code(409).send({
        error: "MODEL_SELECTION_CHANGED",
        message: error.message,
      });
    }
    const threadResumeError = publicThreadResumeError(error);
    if (threadResumeError) {
      return reply.code(409).send({
        error: threadResumeError.code,
        code: threadResumeError.code,
        message: threadResumeError.message,
        promptAccepted: false,
        rejoined: false,
      });
    }
    const message = error instanceof Error ? error.message : "Unexpected server error";
    const known = classifyKnownError(message);
    if (known) return reply.code(known.statusCode).send({ error: known.message });
    app.log.error(
      { error: sanitizeEventTransport(redact(message), runtimePathContext) },
      "Request failed",
    );
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "codexplatform-api",
  }));

  if (options.auth && options.platform) {
    registerRoutes(
      app,
      options.auth,
      options.platform,
      options.webOrigin ?? "http://127.0.0.1:5173",
      runtimePathContext,
    );
  }

  return app;
}

function registerRoutes(
  app: FastifyInstance,
  auth: AuthApi,
  platform: PlatformApi,
  webOrigin: string,
  runtimePathContext: RuntimePathRedactionContext,
): void {
  const secureCookies = new URL(webOrigin).protocol === "https:";
  app.get("/api/bootstrap", async () => platform.getBootstrap());

  app.get("/api/models", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const query = z.object({ threadId: z.string().min(1).optional() }).parse(request.query);
    return platform.listModels(actor.user.id, query.threadId);
  });

  app.get("/api/composer/capabilities", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const query = z.object({ threadId: z.string().min(1).optional() }).parse(request.query);
    if (query.threadId && !(await platform.getThread(query.threadId, actor.user.id))) {
      return reply.code(404).send({ error: "Thread not found" });
    }
    return platform.listComposerCapabilities(actor.user.id, query.threadId);
  });

  app.get("/api/auth/feishu/start", async (_request, reply) => {
    const login = auth.startLogin();
    reply.setCookie(OAUTH_BINDING_COOKIE, login.browserBinding, {
      path: OAUTH_BINDING_COOKIE_PATH,
      maxAge: 10 * 60,
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    });
    return reply.redirect(login.authorizationUrl);
  });

  app.get("/api/auth/feishu/callback", async (request, reply) => {
    clearOAuthBindingCookie(reply);
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1), error: z.string().optional() })
      .safeParse(request.query);
    if (!query.success || query.data.error) {
      return reply.code(400).send({ error: "Feishu authorization was denied or malformed" });
    }
    const browserBinding = request.cookies[OAUTH_BINDING_COOKIE];
    if (!browserBinding) {
      return reply.code(400).send({ error: "OAuth browser binding is missing" });
    }
    const result = await auth.completeLogin({
      code: query.data.code,
      state: query.data.state,
      browserBinding,
    });
    setAuthCookies(reply, result.sessionToken, result.csrfToken, secureCookies);
    return reply.redirect(webOrigin);
  });

  app.get("/api/auth/session", async (request, reply) => {
    const session = requireSession(request, reply, auth);
    if (!session) return;
    return serializeSession(session);
  });

  app.post("/api/auth/session/persist", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const sessionToken = request.cookies[SESSION_COOKIE];
    const csrfToken = request.cookies[CSRF_COOKIE];
    if (!sessionToken || !csrfToken) {
      clearAuthCookies(reply, secureCookies);
      return reply.code(401).send({ error: "Authentication required" });
    }
    const persisted = auth.persistSession(sessionToken);
    if (!persisted) {
      clearAuthCookies(reply, secureCookies);
      return reply.code(401).send({ error: "Authentication required" });
    }
    setAuthCookies(reply, sessionToken, csrfToken, secureCookies);
    return serializeSession(persisted);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const sessionToken = request.cookies[SESSION_COOKIE];
    if (sessionToken) auth.revokeSession(sessionToken);
    clearAuthCookies(reply, secureCookies);
    return reply.code(204).send();
  });

  app.get("/api/projects", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    return platform.listProjects(actor.user.id);
  });

  app.post("/api/projects", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const body = parseBody(
      z.object({ name: z.string().trim().min(1).max(120) }),
      request.body,
      reply,
    );
    if (!body) return;
    return reply.code(201).send(await platform.createProject(actor.user.id, body));
  });

  app.get("/api/threads", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return (await platform.listThreads(actor.user.id, query.projectId)).map((thread) =>
      projectBrowserThread(thread, runtimePathContext),
    );
  });

  app.get("/api/threads/archived", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    return (await platform.listArchivedThreads(actor.user.id)).map((thread) =>
      projectBrowserThread(thread, runtimePathContext),
    );
  });

  app.post("/api/threads", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const body = parseBody(
      z.object({
        projectId: z.string().min(1),
        title: z.string().trim().min(1).max(200),
        config: EffectiveConfigOverrideSchema.optional(),
      }),
      request.body,
      reply,
    );
    if (!body) return;
    return reply.code(201).send(
      projectBrowserThread(
        await platform.createThread(actor.user.id, {
          projectId: body.projectId,
          title: body.title,
          ...(body.config ? { config: body.config } : {}),
        }),
        runtimePathContext,
      ),
    );
  });

  app.get("/api/threads/:id", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const thread = await platform.getThread(id, actor.user.id);
    return thread
      ? projectBrowserThread(thread, runtimePathContext)
      : reply.code(404).send({ error: "Thread not found" });
  });

  app.post("/api/threads/drafts", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const body = parseBody(
      z.object({ projectId: z.string().min(1) }).strict(),
      request.body,
      reply,
    );
    if (!body) return;
    return reply.code(201).send(await platform.createDraft(actor.user.id, body));
  });

  app.delete("/api/threads/:id/draft", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    await platform.deleteDraft(id, actor.user.id);
    return reply.code(204).send();
  });

  app.post("/api/threads/:id/attachments", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const files: Array<{
      name: string;
      relativePath: string;
      mimeType: string;
      content: Buffer;
    }> = [];
    let aggregateBytes = 0;
    for await (const file of request.files()) {
      const content = await readMultipartStream(
        file.file,
        MAX_TURN_ATTACHMENT_BYTES - aggregateBytes,
      );
      aggregateBytes += content.byteLength;
      if (file.file.truncated) {
        return reply.code(413).send({ error: "Attachment exceeds the 50 MiB file limit" });
      }
      files.push({
        name: file.filename.split("/").at(-1) ?? file.filename,
        relativePath: file.filename,
        mimeType: file.mimetype,
        content,
      });
    }
    if (files.length === 0) return reply.code(400).send({ error: "Missing attachment file" });
    return reply.code(201).send(
      await platform.uploadAttachment(id, actor.user.id, {
        files,
      }),
    );
  });

  app.delete("/api/threads/:id/attachments/:attachmentId", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };
    await platform.deleteAttachment(id, attachmentId, actor.user.id);
    return reply.code(204).send();
  });

  app.post("/api/threads/:id/archive", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    return platform.archiveThread(id, actor.user.id);
  });

  app.post("/api/threads/:id/unarchive", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    return platform.unarchiveThread(id, actor.user.id);
  });

  app.post("/api/threads/:id/turns", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const body = parseBody(
      z
        .object({
          prompt: z.string().trim().max(100_000),
          config: EffectiveConfigOverrideSchema.optional(),
          attachmentIds: z.array(z.string().min(1)).max(32).default([]),
        })
        .refine((body) => body.prompt.length > 0 || body.attachmentIds.length > 0, {
          message: "A Turn requires a prompt or at least one attachment",
        }),
      request.body,
      reply,
    );
    if (!body) return;
    const result =
      body.config || body.attachmentIds.length > 0
        ? await platform.startThreadTurn(
            id,
            actor.user.id,
            body.prompt,
            body.config,
            body.attachmentIds,
          )
        : await platform.startThreadTurn(id, actor.user.id, body.prompt);
    const refreshed = await platform.getThread(id, actor.user.id);
    return reply
      .code(202)
      .send(projectThreadStartTurnResult(result, refreshed?.currentTurn?.id ?? null));
  });

  app.post("/api/threads/:id/steer", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const body = parseBody(
      z
        .object({
          prompt: z.string().trim().max(100_000),
          attachmentIds: z.array(z.string().min(1)).max(32).default([]),
        })
        .refine((input) => input.prompt.length > 0 || input.attachmentIds.length > 0, {
          message: "A Steer requires a prompt or at least one attachment",
        }),
      request.body,
      reply,
    );
    if (!body) return;
    return reply
      .code(202)
      .send(
        body.attachmentIds.length > 0
          ? await platform.steerThread(id, actor.user.id, body.prompt, body.attachmentIds)
          : await platform.steerThread(id, actor.user.id, body.prompt),
      );
  });

  app.post("/api/threads/:id/interrupt", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    return reply.code(202).send(await platform.interruptThread(id, actor.user.id));
  });

  app.get("/api/threads/:id/events", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const afterSequence = parseLastEventId(request.headers["last-event-id"]);
    if (!String(request.headers.accept ?? "").includes("text/event-stream")) {
      const replay = await platform.listThreadEvents(id, actor.user.id, afterSequence);
      return (
        replay?.map((event) => projectTaskEvent(event, true, runtimePathContext)) ??
        reply.code(404).send({ error: "Thread not found" })
      );
    }
    const thread = await platform.getThread(id, actor.user.id);
    if (!thread) return reply.code(404).send({ error: "Thread not found" });
    await streamTaskEvents(reply, {
      afterSequence,
      loadReplay: async () =>
        (await platform.listThreadEvents(id, actor.user.id, afterSequence)) ?? [],
      subscribe: (listener) => platform.subscribeThreadEvents(id, listener),
      sessionExpiresAt: actor.expiresAt,
      isSessionValid: () => {
        const token = request.cookies.codexplatform_session;
        const current = token ? auth.resolveSession(token) : null;
        return current?.user.id === actor.user.id;
      },
      hideAccountAlias: true,
      ...(runtimePathContext.runtimeDataDir
        ? { runtimeDataDir: runtimePathContext.runtimeDataDir }
        : {}),
    });
  });

  app.get("/api/threads/:id/subagents", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const subagents = await platform.listSubagents(id, actor.user.id);
    return subagents ?? reply.code(404).send({ error: "Thread not found" });
  });

  app.get("/api/subagents/:threadId", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const { threadId } = request.params as { threadId: string };
    const subagent = await platform.getSubagent(threadId, actor.user.id);
    return subagent ?? reply.code(404).send({ error: "Subagent not found" });
  });

  app.get("/api/me/settings", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    return platform.getMySettings(actor.user.id);
  });

  app.patch("/api/me/settings", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const body = parseBody(UserSettingsPatchSchema, request.body, reply);
    if (!body) return;
    return platform.patchMySettings(actor.user.id, body);
  });

  app.get("/api/me/usage", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    return platform.getMyUsage(actor.user.id);
  });

  app.get("/api/me/connections", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    return platform.getMyConnections(actor.user.id);
  });

  app.get("/api/me/plugins", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    return platform.getMyPlugins(actor.user.id);
  });

  app.get("/api/tasks", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return platform.listTasks(actor.user.id, query.projectId);
  });

  app.post("/api/tasks", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const body = parseBody(
      z.object({ projectId: z.string().min(1), title: z.string().trim().min(1).max(200) }),
      request.body,
      reply,
    );
    if (!body) return;
    return reply.code(201).send(await platform.createTask(actor.user.id, body));
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const task = await platform.getTask(id, actor.user.id);
    return task ? projectLegacyTaskDetail(task) : reply.code(404).send({ error: "Task not found" });
  });

  app.post("/api/tasks/:id/turns", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const body = parseBody(
      z.object({ prompt: z.string().trim().min(1).max(100_000) }),
      request.body,
      reply,
    );
    if (!body) return;
    return reply
      .code(202)
      .send(projectStartTurnResult(await platform.startTurn(id, actor.user.id, body.prompt)));
  });

  app.post("/api/tasks/:id/steer", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const body = parseBody(
      z
        .object({
          prompt: z.string().trim().max(100_000),
          attachmentIds: z.array(z.string().min(1)).max(32).default([]),
        })
        .refine((input) => input.prompt.length > 0 || input.attachmentIds.length > 0, {
          message: "A Steer requires a prompt or at least one attachment",
        }),
      request.body,
      reply,
    );
    if (!body) return;
    return reply
      .code(202)
      .send(
        body.attachmentIds.length > 0
          ? await platform.steerTask(id, actor.user.id, body.prompt, body.attachmentIds)
          : await platform.steerTask(id, actor.user.id, body.prompt),
      );
  });

  app.post("/api/tasks/:id/interrupt", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    return reply.code(202).send(await platform.interruptTask(id, actor.user.id));
  });

  app.get("/api/tasks/:id/events", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const afterSequence = parseLastEventId(request.headers["last-event-id"]);
    if (!String(request.headers.accept ?? "").includes("text/event-stream")) {
      const replay = await platform.listTaskEvents(id, actor.user.id, afterSequence);
      return (
        replay?.map((event) => projectTaskEvent(event, true, runtimePathContext)) ??
        reply.code(404).send({ error: "Task not found" })
      );
    }
    const task = await platform.getTask(id, actor.user.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    await streamTaskEvents(reply, {
      afterSequence,
      loadReplay: async () =>
        (await platform.listTaskEvents(id, actor.user.id, afterSequence)) ?? [],
      subscribe: (listener) => platform.subscribeTaskEvents(id, listener),
      sessionExpiresAt: actor.expiresAt,
      isSessionValid: () => {
        const token = request.cookies.codexplatform_session;
        const current = token ? auth.resolveSession(token) : null;
        return current?.user.id === actor.user.id;
      },
      hideAccountAlias: true,
      ...(runtimePathContext.runtimeDataDir
        ? { runtimeDataDir: runtimePathContext.runtimeDataDir }
        : {}),
    });
  });

  app.get("/api/tasks/:id/approvals", async (request, reply) => {
    const actor = requireSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const approvals = await platform.listApprovals(id, actor.user.id);
    return Array.isArray(approvals)
      ? approvals.map(projectApproval)
      : reply.code(404).send({ error: "Task not found" });
  });

  app.post("/api/approvals/:id/decision", async (request, reply) => {
    const actor = requireWriteSession(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const body = parseBody(
      z.object({ decision: z.enum(["accept", "decline", "cancel"]) }),
      request.body,
      reply,
    );
    if (!body) return;
    return projectApproval(await platform.decideApproval(id, actor.user.id, body.decision));
  });

  app.get("/api/admin/accounts", async (request, reply) => {
    const actor = requireAdmin(request, reply, auth);
    if (!actor) return;
    return platform.listAccounts();
  });

  app.post("/api/admin/accounts", async (request, reply) => {
    const actor = requireAdminWrite(request, reply, auth);
    if (!actor) return;
    const body = parseBody(
      z.object({ alias: z.string().trim().min(1).max(80) }),
      request.body,
      reply,
    );
    if (!body) return;
    return reply.code(201).send(await platform.addAccount(body, actor.user.id));
  });

  app.post("/api/admin/accounts/:id/login", async (request, reply) => {
    const actor = requireAdminWrite(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    return platform.loginAccount(id, actor.user.id);
  });

  app.post("/api/admin/accounts/:id/refresh-quota", async (request, reply) => {
    const actor = requireAdminWrite(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    return platform.refreshAccountQuotaNow(id, actor.user.id);
  });

  app.post("/api/admin/accounts/:id/:action", async (request, reply) => {
    const actor = requireAdminWrite(request, reply, auth);
    if (!actor) return;
    const { id, action } = request.params as { id: string; action: string };
    const state = {
      drain: "DRAINING",
      quarantine: "QUARANTINED",
      restore: "AVAILABLE",
    }[action] as "DRAINING" | "QUARANTINED" | "AVAILABLE" | undefined;
    if (!state) return reply.code(404).send({ error: "Unknown account action" });
    return platform.setAccountState(id, state, actor.user.id);
  });

  app.get("/api/admin/audit", async (request, reply) => {
    const actor = requireAdmin(request, reply, auth);
    if (!actor) return;
    const entries = await platform.listAudit();
    return Array.isArray(entries) ? entries.map(projectAuditEntry) : [];
  });

  app.get("/api/admin/threads/:id", async (request, reply) => {
    const actor = requireAdmin(request, reply, auth);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const thread = await platform.getAdminThread(id, actor.user.id);
    return thread
      ? projectBrowserThread(thread, runtimePathContext)
      : reply.code(404).send({ error: "Thread not found" });
  });

  app.get("/api/admin/policies", async (request, reply) => {
    const actor = requireAdmin(request, reply, auth);
    if (!actor) return;
    return platform.getAdminPolicies();
  });

  app.get("/api/admin/connectors", async (request, reply) => {
    const actor = requireAdmin(request, reply, auth);
    if (!actor) return;
    return platform.getAdminConnectors();
  });

  app.get("/api/admin/usage", async (request, reply) => {
    const actor = requireAdmin(request, reply, auth);
    if (!actor) return;
    return platform.getAdminUsage();
  });

  app.get("/api/admin/runtime-health", async (request, reply) => {
    const actor = requireAdmin(request, reply, auth);
    if (!actor) return;
    return platform.getAdminRuntimeHealth(actor.user.id);
  });
}

function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthApi,
): ActorSession | null {
  const token = request.cookies.codexplatform_session;
  const session = token ? auth.resolveSession(token) : null;
  if (!session) {
    if (token || request.cookies.codexplatform_csrf) {
      clearAuthCookies(reply, request.protocol === "https");
    }
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return session;
}

function requireWriteSession(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthApi,
): ActorSession | null {
  const session = requireSession(request, reply, auth);
  if (!session) return null;
  const csrf = request.headers["x-csrf-token"];
  if (typeof csrf !== "string" || !auth.verifyCsrf(session.csrfHash, csrf)) {
    reply.code(403).send({ error: "CSRF validation failed" });
    return null;
  }
  return session;
}

function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthApi,
): ActorSession | null {
  const session = requireSession(request, reply, auth);
  if (!session) return null;
  if (session.user.role !== "ADMIN") {
    reply.code(403).send({ error: "Administrator access required" });
    return null;
  }
  return session;
}

function requireAdminWrite(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthApi,
): ActorSession | null {
  const session = requireWriteSession(request, reply, auth);
  if (!session) return null;
  if (session.user.role !== "ADMIN") {
    reply.code(403).send({ error: "Administrator access required" });
    return null;
  }
  return session;
}

function parseBody<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  reply: FastifyReply,
): z.output<Schema> | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    reply.code(400).send({ error: "Invalid request", issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

function parseLastEventId(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function streamTaskEvents(
  reply: FastifyReply,
  input: {
    afterSequence: number;
    loadReplay: () => Promise<TaskEvent[]>;
    subscribe: (listener: (event: TaskEvent) => void) => () => void;
    sessionExpiresAt: Date;
    isSessionValid: () => boolean;
    hideAccountAlias?: boolean;
    runtimeDataDir?: string;
  },
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let unsubscribe: () => void = () => undefined;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const cleanup = once(() => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (expiry) clearTimeout(expiry);
    unsubscribe();
  });
  const expire = () => {
    cleanup();
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  };
  const scheduleExpiry = () => {
    if (closed) return;
    const remaining = input.sessionExpiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    // Node timers use a signed 32-bit delay. A 30 day trusted-device
    // session must therefore be checked in bounded segments.
    expiry = setTimeout(scheduleExpiry, Math.min(remaining, 2_147_000_000));
  };
  heartbeat = setInterval(() => {
    let valid = false;
    try {
      valid = input.isSessionValid();
    } catch {
      valid = false;
    }
    if (!valid || Date.now() >= input.sessionExpiresAt.getTime()) {
      expire();
      return;
    }
    reply.raw.write(": heartbeat\n\n");
  }, 15_000);
  scheduleExpiry();
  reply.raw.once("close", cleanup);
  try {
    unsubscribe = await subscribeWithReplay({
      afterSequence: input.afterSequence,
      loadReplay: input.loadReplay,
      subscribe: input.subscribe,
      emit: (event) =>
        reply.raw.write(
          encodeSse(
            event,
            input.hideAccountAlias ?? true,
            input.runtimeDataDir ? { runtimeDataDir: input.runtimeDataDir } : {},
          ),
        ),
    });
    if (closed) unsubscribe();
  } catch (error) {
    cleanup();
    reply.raw.destroy(error instanceof Error ? error : new Error("Task event stream failed"));
  }
}

export async function subscribeWithReplay<T extends { sequence: number }>(input: {
  afterSequence: number;
  loadReplay: () => Promise<T[]>;
  subscribe: (listener: (event: T) => void) => () => void;
  emit: (event: T) => void;
}): Promise<() => void> {
  let buffering = true;
  let lastSequence = input.afterSequence;
  const buffered: T[] = [];
  const unsubscribe = input.subscribe((event) => {
    if (event.sequence <= lastSequence) return;
    if (buffering) {
      buffered.push(event);
      return;
    }
    lastSequence = event.sequence;
    input.emit(event);
  });
  try {
    const replay = await input.loadReplay();
    for (const event of [...replay, ...buffered].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      if (event.sequence <= lastSequence) continue;
      lastSequence = event.sequence;
      input.emit(event);
    }
    buffering = false;
    return once(unsubscribe);
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

export async function readMultipartStream(
  stream: AsyncIterable<Buffer | Uint8Array | string> & { destroy?: (error?: Error) => void },
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      const error = new Error("Attachments exceed the aggregate upload limit");
      stream.destroy?.(error);
      chunks.length = 0;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

export function encodeSse(
  event: TaskEvent,
  hideAccountAlias = true,
  runtimePathContext: RuntimePathRedactionContext = {},
): string {
  const projected = projectTaskEvent(event, hideAccountAlias, runtimePathContext);
  return `id: ${projected.sequence}\nevent: ${projected.type}\ndata: ${JSON.stringify(projected)}\n\n`;
}

function projectTaskEvent(
  event: TaskEvent,
  hideAccountAlias = false,
  runtimePathContext: RuntimePathRedactionContext = {},
): TaskEvent {
  const payload = sanitizeBrowserEventPayload(event, hideAccountAlias, runtimePathContext);
  delete payload.requestId;
  delete payload.leaseId;
  delete payload.ticket;
  return { ...event, payload } as TaskEvent;
}

function sanitizeBrowserEventPayload(
  event: TaskEvent,
  hideAccountAlias: boolean,
  runtimePathContext: RuntimePathRedactionContext = {},
): Record<string, unknown> {
  const source = objectValue(event.payload);
  if (event.type === "REASONING_SUMMARY_DELTA") {
    return sanitizeEventTransport(
      {
        ...(typeof source.itemId === "string" ? { itemId: source.itemId } : {}),
        ...(typeof source.delta === "string" ? { delta: source.delta } : {}),
      },
      runtimePathContext,
    ) as Record<string, unknown>;
  }
  if (event.type === "RECOVERY_REQUIRED") {
    return sanitizeEventTransport(
      typeof source.reason === "string" ? { reason: source.reason } : {},
      runtimePathContext,
    ) as Record<string, unknown>;
  }
  if (event.type === "LEASE_ACQUIRED" && hideAccountAlias) return {};
  return sanitizeEventTransport(source, runtimePathContext) as Record<string, unknown>;
}

function projectBrowserThread(
  thread: Thread,
  runtimePathContext: RuntimePathRedactionContext = {},
): Thread {
  return {
    ...thread,
    items: thread.items.map((item) => ({
      ...item,
      payload: sanitizeBrowserEventPayload(
        {
          taskId: thread.id,
          threadId: item.threadId,
          turnId: item.turnId,
          itemId: item.id,
          sequence: item.sequence,
          timestamp: item.timestamp,
          type: item.type,
          payload: item.payload,
        } as TaskEvent,
        true,
        runtimePathContext,
      ),
    })),
  };
}

function projectStartTurnResult(value: unknown): Record<string, unknown> {
  const source = objectValue(value);
  const status = typeof source.status === "string" ? source.status : "UNKNOWN";
  if (status === "QUEUED") {
    return {
      status,
      ...(typeof source.position === "number" ? { position: source.position } : {}),
      ...(typeof source.etaMs === "number" ? { etaMs: source.etaMs } : {}),
      ...(typeof source.etaEstimated === "boolean" ? { etaEstimated: source.etaEstimated } : {}),
    };
  }
  return { status };
}

function projectThreadStartTurnResult(
  value: unknown,
  platformTurnId: string | null,
): Record<string, unknown> {
  const projected = projectStartTurnResult(value);
  delete projected.accountAlias;
  if (platformTurnId) projected.turnId = platformTurnId;
  return projected;
}

function projectLegacyTaskDetail(value: unknown): Record<string, unknown> {
  return { ...objectValue(value), accountAlias: null };
}

function projectApproval(value: unknown): Record<string, unknown> {
  const source = objectValue(value);
  return {
    ...(typeof source.id === "string" ? { id: source.id } : {}),
    ...(typeof source.taskId === "string" ? { taskId: source.taskId } : {}),
    ...(typeof source.turnId === "string" ? { turnId: source.turnId } : {}),
    ...(typeof source.sourceThreadId === "string" &&
    typeof source.parentTurnId === "string" &&
    source.parentTurnId !== source.turnId
      ? {
          parentTurnId: source.parentTurnId,
          sourceThreadId: source.sourceThreadId,
          sourceSubagent: true,
        }
      : {}),
    ...(typeof source.itemId === "string" ? { itemId: source.itemId } : {}),
    ...(typeof source.approvalType === "string" ? { approvalType: source.approvalType } : {}),
    ...(typeof source.status === "string" ? { status: source.status } : {}),
    ...(typeof source.decision === "string" || source.decision === null
      ? { decision: source.decision }
      : {}),
    ...(typeof source.requestedAt === "string" ? { requestedAt: source.requestedAt } : {}),
    ...(typeof source.decidedAt === "string" || source.decidedAt === null
      ? { decidedAt: source.decidedAt }
      : {}),
  };
}

function projectAuditEntry(value: unknown): Record<string, unknown> {
  const source = objectValue(value);
  return {
    ...(typeof source.id === "string" ? { id: source.id } : {}),
    ...(typeof source.actorUserId === "string" ? { actorUserId: source.actorUserId } : {}),
    ...(typeof source.actorName === "string" ? { actorName: source.actorName } : {}),
    ...(typeof source.accountAlias === "string" ? { accountAlias: source.accountAlias } : {}),
    ...(typeof source.taskId === "string" ? { taskId: source.taskId } : {}),
    ...(typeof source.action === "string" ? { action: source.action } : {}),
    ...(typeof source.outcome === "string" ? { outcome: source.outcome } : {}),
    ...(typeof source.summary === "string" ? { summary: source.summary } : {}),
    ...(typeof source.createdAt === "string" ? { createdAt: source.createdAt } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function classifyKnownError(
  message: string,
): { statusCode: 400 | 403 | 404 | 409 | 413; message: string } | null {
  if (/not found$/i.test(message)) return { statusCode: 404, message };
  if (/^OAuth (?:state|browser binding)\b/i.test(message)) {
    return { statusCode: 400, message };
  }
  if (/already (?:decided|used|has an active Turn)/i.test(message)) {
    return { statusCode: 409, message };
  }
  if (/cannot be archived$/i.test(message)) return { statusCode: 409, message };
  if (/^Thread is archived$/i.test(message)) return { statusCode: 409, message };
  if (/^Attachments? exceed\b/i.test(message)) return { statusCode: 413, message };
  if (/credential isolation|real codex multi-user execution is disabled/i.test(message)) {
    return { statusCode: 403, message };
  }
  if (/^(?:invalid|missing|unknown|unsupported)\b/i.test(message)) {
    return { statusCode: 400, message };
  }
  if (
    /^(?:Attachment root limit|Folder exceeds|Duplicate attachment path|Unsafe attachment|Executable attachment content|Attachment size does not match)/i.test(
      message,
    )
  ) {
    return { statusCode: 400, message };
  }
  return null;
}

function publicThreadResumeError(error: unknown): {
  code: "ACTIVE_TURN_RESUME_CONFLICT" | "INVALID_THREAD_RESUME_RESPONSE";
  message: string;
} | null {
  if (!(error instanceof ThreadResumeSafetyError)) return null;
  if (error.code === "ACTIVE_TURN_RESUME_CONFLICT") {
    return {
      code: error.code,
      message: "Thread already has an active Turn; the new prompt was not accepted",
    };
  }
  if (error.code === "INVALID_THREAD_RESUME_RESPONSE") {
    return {
      code: error.code,
      message: "Thread resume response is unsafe; the new prompt was not accepted",
    };
  }
  return null;
}

function redact(value: string): string {
  return value.replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/g, "[REDACTED]");
}

function clearOAuthBindingCookie(reply: FastifyReply): void {
  reply.setCookie(OAUTH_BINDING_COOKIE, "", {
    path: OAUTH_BINDING_COOKIE_PATH,
    maxAge: 0,
    httpOnly: true,
    sameSite: "lax",
    secure: false,
  });
}

function setAuthCookies(
  reply: FastifyReply,
  sessionToken: string,
  csrfToken: string,
  secure: boolean,
): void {
  reply.setCookie(SESSION_COOKIE, sessionToken, {
    path: "/",
    maxAge: TRUSTED_DEVICE_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: "strict",
    secure,
  });
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    path: "/",
    maxAge: TRUSTED_DEVICE_MAX_AGE_SECONDS,
    httpOnly: false,
    sameSite: "strict",
    secure,
  });
}

function clearAuthCookies(reply: FastifyReply, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: true,
    sameSite: "strict",
    secure,
  });
  reply.setCookie(CSRF_COOKIE, "", {
    path: "/",
    maxAge: 0,
    httpOnly: false,
    sameSite: "strict",
    secure,
  });
}

function serializeSession(session: ActorSession) {
  return {
    user: session.user,
    expiresAt: session.expiresAt.toISOString(),
    persistent: session.persistent,
    feishuConnectionStatus: session.feishuConnectionStatus,
  };
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
