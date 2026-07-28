export interface E2eIdentity {
  userId: string;
  tenantKey: string;
  openId: string;
  name: string;
  role: "ADMIN" | "MEMBER";
  sessionToken: string;
  csrfToken: string;
}

export const e2eIdentity = {
  userId: "e2e-admin",
  tenantKey: "e2e-tenant",
  openId: "ou_e2e_admin",
  name: "E2E 管理员",
  role: "ADMIN",
  sessionToken: "codexplatform-e2e-session",
  csrfToken: "codexplatform-e2e-csrf",
} as const satisfies E2eIdentity;

export const e2eMemberIdentity = {
  userId: "e2e-member",
  tenantKey: e2eIdentity.tenantKey,
  openId: "ou_e2e_member",
  name: "E2E 成员",
  role: "MEMBER",
  sessionToken: "codexplatform-e2e-member-session",
  csrfToken: "codexplatform-e2e-member-csrf",
} as const satisfies E2eIdentity;

export const e2eCanaries = {
  accountAlias: "E2E_ACCOUNT_ALIAS_CANARY",
  codexHome: "E2E_CODEX_HOME_CANARY",
  credentialSecret: "E2E_CREDENTIAL_SECRET_CANARY",
  rawReasoning: "E2E_RAW_REASONING_CANARY",
  encryptedReasoning: "E2E_ENCRYPTED_REASONING_CANARY",
} as const;

export const seededFixture = {
  projectId: "e2e-private-project",
  threadId: "e2e-private-thread",
  runtimeThreadId: "e2e-private-runtime-thread",
  turnId: "e2e-private-turn",
  queuedThreadId: "e2e-queued-thread",
  queuedTurnId: "e2e-queued-turn",
  runningThreadId: "e2e-running-thread",
  runningTurnId: "e2e-running-turn",
  runningRuntimeThreadId: "e2e-running-runtime-thread",
  activeSubagentId: "e2e-subagent-active",
  doneSubagentId: "e2e-subagent-done",
} as const;
