import type {
  AccountSummary,
  AdminConnector,
  AdminPolicies,
  AdminUsage,
  Bootstrap,
  ConnectionSummary,
  ModelCatalog,
  PlatformApi,
  PluginSummary,
  ProjectSummary,
  RuntimeHealth,
  Session,
  SubagentThread,
  SubagentThreadDetail,
  TaskDetail,
  TaskSummary,
  Thread,
  UserSettingsView,
  UserUsage,
} from "./types.js";

interface RawSession {
  user: Session["user"];
}

interface RawProject extends Omit<ProjectSummary, "taskCount"> {
  taskCount?: number;
}

interface RawAccount {
  id: string;
  alias: string;
  status: AccountSummary["status"];
  activeUsers: number;
  maxActiveUsers: number;
  weeklyRemaining: number | null;
  healthScore: number;
  quotaUpdatedAt?: string | null;
}

interface RawAudit {
  id: string;
  actorUserId: string;
  actorName?: string;
  accountAlias?: string | null;
  taskId?: string | null;
  action: string;
  outcome: string;
  summary: string;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const csrf = readCookie("codexplatform_csrf");
  if (csrf && init.method && init.method !== "GET") {
    headers.set("X-CSRF-Token", csrf);
  }

  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(
      payload?.message ?? payload?.error ?? `请求失败（${response.status}）`,
      response.status,
      payload?.code ?? payload?.error,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie.split("; ").find((entry) => entry.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : null;
}

export const httpApi: PlatformApi = {
  getSession: async () => {
    const session = await request<RawSession>("/api/auth/session");
    return { authenticated: true, user: session.user };
  },
  getBootstrap: () => request<Bootstrap>("/api/bootstrap"),
  listModels: (threadId) =>
    request<ModelCatalog>(
      threadId ? `/api/models?threadId=${encodeURIComponent(threadId)}` : "/api/models",
    ),
  listProjects: async () => {
    const projects = await request<RawProject[]>("/api/projects");
    return projects.map((project) => ({ ...project, taskCount: project.taskCount ?? 0 }));
  },
  createProject: (name) =>
    request<{ id: string }>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),
  listTasks: async () => {
    const tasks =
      await request<Array<Omit<TaskSummary, "status"> & { status: string }>>("/api/tasks");
    return tasks.map((task) => ({ ...task, status: normalizeTaskStatus(task.status) }));
  },
  getTask: async (taskId) => {
    const task = await request<Omit<TaskDetail, "status"> & { status: string }>(
      `/api/tasks/${encodeURIComponent(taskId)}`,
    );
    return { ...task, status: normalizeTaskStatus(task.status) };
  },
  createTask: (input) =>
    request<{ id: string }>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  startTurn: (taskId, prompt) =>
    request(`/api/tasks/${encodeURIComponent(taskId)}/turns`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  taskAction: (taskId, action, input) =>
    request(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: "POST",
      body: JSON.stringify(action === "steer" && input ? { prompt: input } : {}),
    }),
  listThreads: (projectId) =>
    request<Thread[]>(
      projectId ? `/api/threads?projectId=${encodeURIComponent(projectId)}` : "/api/threads",
    ),
  listArchivedThreads: () => request<Thread[]>("/api/threads/archived"),
  getThread: (threadId) => request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`),
  createThread: (input) =>
    request<Thread>("/api/threads", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  startThreadTurn: (threadId, prompt, config) =>
    request(`/api/threads/${encodeURIComponent(threadId)}/turns`, {
      method: "POST",
      body: JSON.stringify({ prompt, ...(config ? { config } : {}) }),
    }),
  threadAction: (threadId, action, input) =>
    request(`/api/threads/${encodeURIComponent(threadId)}/${action}`, {
      method: "POST",
      body: JSON.stringify(action === "steer" && input ? { prompt: input } : {}),
    }),
  archiveThread: (threadId) =>
    request<{ ok: true }>(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  unarchiveThread: (threadId) =>
    request<{ ok: true }>(`/api/threads/${encodeURIComponent(threadId)}/unarchive`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  listSubagents: (threadId) =>
    request<SubagentThread[]>(`/api/threads/${encodeURIComponent(threadId)}/subagents`),
  getSubagent: (threadId) =>
    request<SubagentThreadDetail>(`/api/subagents/${encodeURIComponent(threadId)}`),
  getMySettings: () => request<UserSettingsView>("/api/me/settings"),
  patchMySettings: (patch) =>
    request<UserSettingsView>("/api/me/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  getMyUsage: () => request<UserUsage>("/api/me/usage"),
  listMyConnections: () => request<ConnectionSummary[]>("/api/me/connections"),
  listMyPlugins: () => request<PluginSummary[]>("/api/me/plugins"),
  getAdminPolicies: () => request<AdminPolicies>("/api/admin/policies"),
  getAdminThread: (threadId) =>
    request<Thread>(`/api/admin/threads/${encodeURIComponent(threadId)}`),
  listAdminConnectors: () => request<AdminConnector[]>("/api/admin/connectors"),
  getAdminUsage: () => request<AdminUsage>("/api/admin/usage"),
  getAdminRuntimeHealth: () => request<RuntimeHealth>("/api/admin/runtime-health"),
  decideApproval: (approvalId, decision) =>
    request(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  listAccounts: async () => {
    const accounts = await request<RawAccount[]>("/api/admin/accounts");
    return accounts.map((account) => ({
      id: account.id,
      alias: account.alias,
      status: account.status,
      activeUsers: account.activeUsers,
      maxUsers: account.maxActiveUsers,
      weeklyRemainingPercent: account.weeklyRemaining,
      health: account.healthScore,
      quotaUpdatedAt: account.quotaUpdatedAt ?? null,
    }));
  },
  addAccount: (alias) =>
    request<{ id: string }>("/api/admin/accounts", {
      method: "POST",
      body: JSON.stringify({ alias }),
    }),
  accountAction: (accountId, action) =>
    request(`/api/admin/accounts/${encodeURIComponent(accountId)}/${action}`, { method: "POST" }),
  listAudit: async () => {
    const entries = await request<RawAudit[]>("/api/admin/audit");
    return entries.map((entry) => ({
      id: entry.id,
      timestamp: entry.createdAt,
      actorName: entry.actorName ?? entry.actorUserId,
      action: entry.action,
      resource: entry.summary,
      result: entry.outcome,
      accountAlias: entry.accountAlias ?? null,
      taskId: entry.taskId ?? null,
    }));
  },
};

function normalizeTaskStatus(status: string): TaskSummary["status"] {
  const supported = new Set<TaskSummary["status"]>([
    "DRAFT",
    "READY",
    "QUEUED",
    "RUNNING",
    "WAITING_APPROVAL",
    "COMPLETED",
    "FAILED",
    "INTERRUPTED",
    "NEEDS_RECOVERY",
  ]);
  return supported.has(status as TaskSummary["status"])
    ? (status as TaskSummary["status"])
    : "NEEDS_RECOVERY";
}
