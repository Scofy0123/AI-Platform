import type {
  Bootstrap,
  ComposerCapability,
  EffectiveConfigOverride,
  ModelCatalog,
  SubagentThread,
  SubagentThreadDetail,
  TaskDetail,
  TaskEvent,
  TaskSummary,
  Thread,
  UserSettingsPatch,
  UserSettingsView,
} from "@codexplatform/contracts";
import type { PlatformUser, ResolvedAuthSession } from "./auth/auth-store.js";

export interface AuthApi {
  startLogin(): { state: string; browserBinding: string; authorizationUrl: string };
  completeLogin(input: { code: string; state: string; browserBinding: string }): Promise<{
    user: PlatformUser;
    sessionToken: string;
    csrfToken: string;
  }>;
  resolveSession(sessionToken: string): ResolvedAuthSession | null;
  verifyCsrf(expectedHash: string, providedToken: string): boolean;
  persistSession(sessionToken: string): ResolvedAuthSession | null;
  revokeSession(sessionToken: string): void;
  refreshExpiringCredentials(): Promise<void>;
}

export interface PlatformApi {
  getBootstrap(): Promise<Bootstrap>;
  listModels(userId: string, threadId?: string): Promise<ModelCatalog>;
  listComposerCapabilities(userId: string, threadId?: string): Promise<ComposerCapability[]>;
  createProject(userId: string, input: { name: string }): Promise<unknown>;
  listProjects(userId: string): Promise<unknown>;
  createTask(userId: string, input: { projectId: string; title: string }): Promise<unknown>;
  listTasks(userId: string, projectId?: string): Promise<TaskSummary[]>;
  getTask(taskId: string, userId: string): Promise<TaskDetail | null>;
  createThread(
    userId: string,
    input: { projectId: string; title: string; config?: EffectiveConfigOverride },
  ): Promise<Thread>;
  listThreads(userId: string, projectId?: string): Promise<Thread[]>;
  listArchivedThreads(userId: string): Promise<Thread[]>;
  archiveThread(threadId: string, userId: string): Promise<{ ok: true }>;
  unarchiveThread(threadId: string, userId: string): Promise<{ ok: true }>;
  getThread(threadId: string, userId: string): Promise<Thread | null>;
  getAdminThread(threadId: string, adminUserId: string): Promise<Thread | null>;
  startThreadTurn(
    threadId: string,
    userId: string,
    prompt: string,
    config?: EffectiveConfigOverride,
  ): Promise<unknown>;
  steerThread(threadId: string, userId: string, prompt: string): Promise<unknown>;
  interruptThread(threadId: string, userId: string): Promise<unknown>;
  listThreadEvents(
    threadId: string,
    userId: string,
    afterSequence: number,
  ): Promise<TaskEvent[] | null>;
  subscribeThreadEvents(threadId: string, listener: (event: TaskEvent) => void): () => void;
  listSubagents(threadId: string, userId: string): Promise<SubagentThread[] | null>;
  getSubagent(threadId: string, userId: string): Promise<SubagentThreadDetail | null>;
  getMySettings(userId: string): Promise<UserSettingsView>;
  patchMySettings(userId: string, patch: UserSettingsPatch): Promise<UserSettingsView>;
  getMyUsage(userId: string): Promise<unknown>;
  getMyConnections(userId: string): Promise<unknown>;
  getMyPlugins(userId: string): Promise<unknown>;
  startTurn(taskId: string, userId: string, prompt: string): Promise<unknown>;
  steerTask(taskId: string, userId: string, prompt: string): Promise<unknown>;
  interruptTask(taskId: string, userId: string): Promise<unknown>;
  listTaskEvents(
    taskId: string,
    userId: string,
    afterSequence: number,
  ): Promise<TaskEvent[] | null>;
  subscribeTaskEvents(taskId: string, listener: (event: TaskEvent) => void): () => void;
  listApprovals(taskId: string, userId: string): Promise<unknown | null>;
  decideApproval(approvalId: string, userId: string, decision: string): Promise<unknown>;
  listAccounts(): Promise<unknown>;
  addAccount(input: { alias: string }, adminUserId: string): Promise<unknown>;
  loginAccount(accountId: string, adminUserId: string): Promise<unknown>;
  refreshAccountQuotaNow(accountId: string, adminUserId: string): Promise<unknown>;
  setAccountState(
    accountId: string,
    state: "DRAINING" | "QUARANTINED" | "AVAILABLE",
    adminUserId: string,
  ): Promise<unknown>;
  listAudit(): Promise<unknown>;
  getAdminPolicies(): Promise<unknown>;
  getAdminConnectors(): Promise<unknown>;
  getAdminUsage(): Promise<unknown>;
  getAdminRuntimeHealth(adminUserId: string): Promise<unknown>;
}
