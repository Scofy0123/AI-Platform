import type {
  Bootstrap,
  ComposerCapability,
  ComposerState,
  ComposerStatePatch,
  DraftAttachment,
  EffectiveConfigOverride,
  ModelCatalog,
  SubagentThread,
  SubagentThreadDetail,
  TaskDetail as TaskDetailDto,
  TaskEvent,
  TaskSummary,
  Thread,
  ThreadGoalInput,
  ThreadGoalPatch,
  ThreadGoalView,
  UserSettingsPatch,
  UserSettingsView,
} from "@codexplatform/contracts";

export type {
  Bootstrap,
  ComposerCapability,
  ComposerState,
  ComposerStatePatch,
  DraftAttachment,
  ModelCatalog,
  ModelOption,
  SubagentThread,
  SubagentThreadDetail,
  TaskEvent,
  TaskStatus,
  TaskSummary,
  Thread,
  ThreadGoalInput,
  ThreadGoalPatch,
  ThreadGoalView,
  UserSettingsPatch,
  UserSettingsView,
} from "@codexplatform/contracts";

export type UserRole = "ADMIN" | "MEMBER";

export interface Session {
  authenticated: boolean;
  expiresAt: string;
  persistent: boolean;
  feishuConnectionStatus: "CONNECTED" | "REFRESHING" | "REAUTH_REQUIRED";
  user: {
    id: string;
    name: string;
    role: UserRole;
    avatarUrl?: string | null;
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  taskCount: number;
  updatedAt: string;
}

export interface TaskDetail extends TaskDetailDto {
  events?: TaskEvent[];
}

export interface AccountSummary {
  id: string;
  alias: string;
  status:
    | "AVAILABLE"
    | "FULL"
    | "COOLDOWN"
    | "EXHAUSTED"
    | "REAUTH_REQUIRED"
    | "DRAINING"
    | "QUARANTINED";
  activeUsers: number;
  maxUsers: number;
  weeklyRemainingPercent: number | null;
  authStatus?: "AUTHENTICATED" | "UNAUTHENTICATED" | "EXPIRED";
  health: number;
  quotaUpdatedAt?: string | null;
  quotaResetsAt?: string | null;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actorName: string;
  action: string;
  resource: string;
  result: string;
  accountAlias?: string | null;
  taskId?: string | null;
}

export interface UserUsage {
  threads: number;
  turns: number;
  toolCalls: number;
  subagents: number;
  tokenUsage: {
    scope: "OWNED_THREAD_TREES";
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null;
  tokenUsageStatus: "KNOWN" | "UNKNOWN";
  quota: {
    scope: "SHARED_CODEX_ACCOUNT";
    attributableToUser: false;
  };
}

export interface ConnectionSummary {
  id: string;
  name: string;
  managed: boolean;
  connected: boolean;
  status: string;
  scopes: string[];
}

export interface PluginSummary {
  id: string;
  name: string;
  status: string;
  description?: string | null;
}

export interface AdminPolicies {
  productModes: {
    enabled: readonly string[];
    disabled: readonly string[];
  };
  settings: {
    allowedModels: string[] | null;
    allowedReasoningEfforts: readonly string[];
    allowedPermissionModes: readonly string[];
    allowedApprovalPreferences: readonly string[];
    lockedFields: readonly string[];
  };
  memory: { nativeSharedAccountMemory: boolean };
  deploymentStage: string;
  productionMultiUserEnabled: boolean;
}

export interface AdminConnector {
  id: string;
  name: string;
  managed: boolean;
  mode: string;
  status: string;
}

export interface AdminUsage {
  users: number;
  threads: number;
  turns: number;
  toolCalls: number;
  subagents: number;
  tokenUsage: UserUsage["tokenUsage"];
  tokenUsageStatus: "KNOWN" | "UNKNOWN";
  quota: UserUsage["quota"];
}

export interface RuntimeHealth {
  deploymentStage: string;
  multiUserReady: boolean;
  workerIsolation: string;
  safetyMode: string;
  safetyAllowedForActor: boolean;
  accounts: {
    total: number;
    available: number;
    unhealthy: number;
  };
}

export interface PlatformApi {
  getSession(): Promise<Session>;
  logout?(): Promise<void>;
  getBootstrap?(): Promise<Bootstrap>;
  listModels?(threadId?: string): Promise<ModelCatalog>;
  listComposerCapabilities?(threadId?: string): Promise<ComposerCapability[]>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(name: string): Promise<{ id: string }>;
  listTasks(): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  createTask(input: { title: string; projectId: string }): Promise<{ id: string }>;
  startTurn(taskId: string, prompt: string): Promise<unknown>;
  taskAction(taskId: string, action: "interrupt" | "steer", input?: string): Promise<unknown>;
  decideApproval(approvalId: string, decision: "accept" | "decline"): Promise<unknown>;
  listThreads?(projectId?: string): Promise<Thread[]>;
  listArchivedThreads?(): Promise<Thread[]>;
  getThread?(threadId: string): Promise<Thread>;
  getAdminThread?(threadId: string): Promise<Thread>;
  createThread?(input: {
    projectId: string;
    title: string;
    config?: EffectiveConfigOverride;
  }): Promise<Thread>;
  createDraft?(input: { projectId: string }): Promise<{ id: string }>;
  getDraft?(threadId: string): Promise<{
    id: string;
    projectId: string;
    lifecycleState: "DRAFT";
  }>;
  deleteDraft?(threadId: string): Promise<void>;
  uploadAttachments?(threadId: string, files: readonly File[]): Promise<DraftAttachment>;
  listThreadAttachments?(threadId: string): Promise<DraftAttachment[]>;
  deleteAttachment?(threadId: string, attachmentId: string): Promise<void>;
  getThreadGoal?(threadId: string): Promise<ThreadGoalView>;
  putThreadGoal?(threadId: string, input: ThreadGoalInput): Promise<ThreadGoalView>;
  patchThreadGoal?(threadId: string, patch: ThreadGoalPatch): Promise<ThreadGoalView>;
  deleteThreadGoal?(
    threadId: string,
  ): Promise<{ cleared: true; runtimeSyncState: "PENDING" | "SYNCED" }>;
  getThreadComposer?(threadId: string): Promise<ComposerState>;
  patchThreadComposer?(threadId: string, patch: ComposerStatePatch): Promise<ComposerState>;
  startThreadTurn?(
    threadId: string,
    prompt: string,
    config?: EffectiveConfigOverride,
    attachmentIds?: readonly string[],
  ): Promise<unknown>;
  threadAction?(
    threadId: string,
    action: "interrupt" | "steer",
    input?: string,
    attachmentIds?: readonly string[],
  ): Promise<unknown>;
  archiveThread?(threadId: string): Promise<{ ok: true }>;
  unarchiveThread?(threadId: string): Promise<{ ok: true }>;
  listSubagents?(threadId: string): Promise<SubagentThread[]>;
  getSubagent?(threadId: string): Promise<SubagentThreadDetail>;
  getMySettings?(): Promise<UserSettingsView>;
  patchMySettings?(patch: UserSettingsPatch): Promise<UserSettingsView>;
  getMyUsage?(): Promise<UserUsage>;
  listMyConnections?(): Promise<ConnectionSummary[]>;
  listMyPlugins?(): Promise<PluginSummary[]>;
  getAdminPolicies?(): Promise<AdminPolicies>;
  listAdminConnectors?(): Promise<AdminConnector[]>;
  getAdminUsage?(): Promise<AdminUsage>;
  getAdminRuntimeHealth?(): Promise<RuntimeHealth>;
  listAccounts(): Promise<AccountSummary[]>;
  addAccount(alias: string): Promise<{ id: string }>;
  accountAction(
    accountId: string,
    action: "login" | "drain" | "quarantine" | "restore" | "refresh-quota",
  ): Promise<unknown>;
  listAudit(): Promise<AuditEntry[]>;
}

export type TaskEventSubscriber = (
  taskId: string,
  onEvent: (event: TaskEvent) => void,
  options?: {
    initialLastEventId?: number;
    onConnectionChange?: (state: "connecting" | "connected" | "reconnecting") => void;
  },
) => () => void;
