import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountStatus } from "./lease-store.js";

export interface AccountSummary {
  id: string;
  alias: string;
  status: AccountStatus;
  authStatus: string;
  activeUsers: number;
  activeTurns: number;
  maxActiveUsers: number;
  weeklyRemaining: number | null;
  quotaUpdatedAt: string | null;
  quotaResetsAt: string | null;
  allowUnknownQuota: boolean;
  healthScore: number;
}

export interface InternalAccount extends AccountSummary {
  codexHome: string;
}

interface AccountAuditContext {
  actorUserId: string;
  now: Date;
}

interface AccountLifecycleEvent extends AccountAuditContext {
  accountId: string;
  action: string;
  outcome: "SUCCESS" | "FAILED";
  summary: string;
}

interface AccountRow {
  id: string;
  alias: string;
  codex_home: string | null;
  status: AccountStatus;
  auth_status: string;
  max_active_users: number;
  weekly_remaining: number | null;
  quota_updated_at: number | null;
  quota_resets_at: number | null;
  allow_unknown_quota: number;
  health_score: number;
  active_users: number;
  active_turns: number;
}

export class AccountAdminStore {
  constructor(private readonly sqlite: Database.Database) {}

  list(): AccountSummary[] {
    return this.rows().map(mapSummary);
  }

  count(): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_accounts").get() as {
      count: number;
    };
    return row.count;
  }

  getInternal(accountId: string): InternalAccount | null {
    const row = this.row(accountId);
    if (!row) return null;
    if (!row.codex_home) throw new Error(`Codex account ${accountId} has no CODEX_HOME`);
    return { ...mapSummary(row), codexHome: row.codex_home };
  }

  markAuthenticated(accountId: string, now: Date): void {
    const result = this.sqlite
      .prepare(
        `UPDATE codex_accounts
         SET auth_status = 'AUTHENTICATED', status = 'AVAILABLE', health_score = 100
         WHERE id = ?`,
      )
      .run(accountId);
    if (result.changes !== 1) throw new Error(`Unknown Codex account: ${accountId}`);
    this.sqlite
      .prepare(
        "UPDATE codex_accounts SET last_assigned_at = COALESCE(last_assigned_at, ?) WHERE id = ?",
      )
      .run(now.getTime() - 1, accountId);
  }

  markReauthenticationRequired(accountId: string): void {
    const result = this.sqlite
      .prepare(
        "UPDATE codex_accounts SET auth_status = 'EXPIRED', status = 'REAUTH_REQUIRED' WHERE id = ?",
      )
      .run(accountId);
    if (result.changes !== 1) throw new Error(`Unknown Codex account: ${accountId}`);
  }

  updateWeeklyQuota(
    accountId: string,
    input: { remainingPercent: number | null; resetsAt: Date | null; observedAt: Date },
  ): void {
    const result = this.sqlite
      .prepare(
        `UPDATE codex_accounts
         SET weekly_remaining = ?, quota_updated_at = ?, quota_resets_at = ?,
             status = CASE
               WHEN ? <= 0 THEN 'EXHAUSTED'
               WHEN status = 'EXHAUSTED' THEN 'AVAILABLE'
               ELSE status
             END
         WHERE id = ?`,
      )
      .run(
        input.remainingPercent,
        input.observedAt.getTime(),
        input.resetsAt?.getTime() ?? null,
        input.remainingPercent,
        accountId,
      );
    if (result.changes !== 1) throw new Error(`Unknown Codex account: ${accountId}`);
  }

  setState(
    accountId: string,
    state: "DRAINING" | "QUARANTINED" | "AVAILABLE",
    audit?: AccountAuditContext,
  ): void {
    const update = () => {
      const before = this.row(accountId);
      if (!before) throw new Error(`Unknown Codex account: ${accountId}`);
      const result = this.sqlite
        .prepare(
          `UPDATE codex_accounts SET status = CASE
             WHEN ? = 'AVAILABLE' AND auth_status != 'AUTHENTICATED' THEN 'REAUTH_REQUIRED'
             WHEN ? = 'AVAILABLE' AND (
               SELECT COUNT(*) FROM account_slots WHERE account_id = ? AND user_id IS NOT NULL
             ) >= max_active_users THEN 'FULL'
             ELSE ? END
           WHERE id = ?`,
        )
        .run(state, state, accountId, state, accountId);
      if (result.changes !== 1) throw new Error(`Unknown Codex account: ${accountId}`);
      if (audit) {
        const after = this.row(accountId);
        if (!after) throw new Error(`Unknown Codex account: ${accountId}`);
        this.insertLifecycleAudit({
          accountId,
          actorUserId: audit.actorUserId,
          action: "ACCOUNT_STATE_CHANGED",
          outcome: "SUCCESS",
          summary: `Codex account state changed: ${before.status} -> ${after.status}`,
          now: audit.now,
        });
      }
    };
    if (audit) this.immediateTransaction(update);
    else update();
  }

  recordLifecycleEvent(input: AccountLifecycleEvent): void {
    this.immediateTransaction(() => this.insertLifecycleAudit(input));
  }

  private rows(): AccountRow[] {
    return this.sqlite
      .prepare(
        `SELECT a.*,
          (SELECT COUNT(*) FROM account_slots s
           WHERE s.account_id = a.id AND s.user_id IS NOT NULL) AS active_users,
          (SELECT COUNT(*) FROM user_turn_slots t
           WHERE t.account_id = a.id) AS active_turns
         FROM codex_accounts a ORDER BY a.created_at, a.id`,
      )
      .all() as AccountRow[];
  }

  private row(accountId: string): AccountRow | null {
    return this.rows().find((row) => row.id === accountId) ?? null;
  }

  private insertLifecycleAudit(input: AccountLifecycleEvent): void {
    const account = this.row(input.accountId);
    if (!account) throw new Error(`Unknown Codex account: ${input.accountId}`);
    this.sqlite
      .prepare(
        `INSERT INTO audit_events (
          id, actor_user_id, account_id, account_alias, action, outcome, summary, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.actorUserId,
        input.accountId,
        account.alias,
        input.action,
        input.outcome,
        input.summary,
        input.now.getTime(),
      );
  }

  private immediateTransaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    alias: row.alias,
    status: row.status,
    authStatus: row.auth_status,
    activeUsers: row.active_users,
    activeTurns: row.active_turns,
    maxActiveUsers: row.max_active_users,
    weeklyRemaining: row.weekly_remaining,
    quotaUpdatedAt: row.quota_updated_at ? new Date(row.quota_updated_at).toISOString() : null,
    quotaResetsAt: row.quota_resets_at ? new Date(row.quota_resets_at).toISOString() : null,
    allowUnknownQuota: row.allow_unknown_quota === 1,
    healthScore: row.health_score,
  };
}
