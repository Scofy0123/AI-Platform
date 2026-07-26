import type { TaskDetail, TaskEvent, TaskSummary } from "@codexplatform/contracts";
import type { PlatformUser } from "./auth/auth-store.js";

export interface AuthApi {
  startLogin(): { state: string; browserBinding: string; authorizationUrl: string };
  completeLogin(input: { code: string; state: string; browserBinding: string }): Promise<{
    user: PlatformUser;
    sessionToken: string;
    csrfToken: string;
  }>;
  resolveSession(
    sessionToken: string,
  ): { user: PlatformUser; csrfHash: string; expiresAt: Date } | null;
  verifyCsrf(expectedHash: string, providedToken: string): boolean;
}

export interface PlatformApi {
  createProject(userId: string, input: { name: string }): Promise<unknown>;
  listProjects(userId: string): Promise<unknown>;
  createTask(userId: string, input: { projectId: string; title: string }): Promise<unknown>;
  listTasks(userId: string, projectId?: string): Promise<TaskSummary[]>;
  getTask(taskId: string, userId: string): Promise<TaskDetail | null>;
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
  setAccountState(
    accountId: string,
    state: "DRAINING" | "QUARANTINED" | "AVAILABLE",
    adminUserId: string,
  ): Promise<unknown>;
  listAudit(): Promise<unknown>;
}
