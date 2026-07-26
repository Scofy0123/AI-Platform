import type { TaskDetail as TaskDetailDto, TaskEvent, TaskSummary } from "@codexplatform/contracts";

export type { TaskStatus, TaskSummary } from "@codexplatform/contracts";

export type UserRole = "ADMIN" | "MEMBER";

export interface Session {
  authenticated: boolean;
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
  health: number;
  quotaUpdatedAt?: string | null;
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

export interface PlatformApi {
  getSession(): Promise<Session>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(name: string): Promise<{ id: string }>;
  listTasks(): Promise<TaskSummary[]>;
  getTask(taskId: string): Promise<TaskDetail>;
  createTask(input: { title: string; projectId: string }): Promise<{ id: string }>;
  startTurn(taskId: string, prompt: string): Promise<unknown>;
  taskAction(taskId: string, action: "interrupt" | "steer", input?: string): Promise<unknown>;
  decideApproval(approvalId: string, decision: "accept" | "decline"): Promise<unknown>;
  listAccounts(): Promise<AccountSummary[]>;
  addAccount(alias: string): Promise<{ id: string }>;
  accountAction(
    accountId: string,
    action: "login" | "drain" | "quarantine" | "restore",
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
