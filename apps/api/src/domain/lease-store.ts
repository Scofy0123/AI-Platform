import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const ACCOUNT_STATUSES = [
  "AVAILABLE",
  "FULL",
  "COOLDOWN",
  "EXHAUSTED",
  "REAUTH_REQUIRED",
  "DRAINING",
  "QUARANTINED",
] as const;

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
export type AccountAuthStatus = "AUTHENTICATED" | "UNAUTHENTICATED" | "EXPIRED";
export type QueueReason = "ACCOUNT_USER_LIMIT" | "USER_TURN_LIMIT" | "NO_ELIGIBLE_ACCOUNT";

export interface AccountInput {
  id: string;
  alias: string;
  codexHome?: string | null;
  status: AccountStatus;
  authStatus: AccountAuthStatus;
  maxActiveUsers: number;
  weeklyRemaining: number | null;
  quotaUpdatedAt: Date | null;
  allowUnknownQuota: boolean;
  healthScore: number;
  lastAssignedAt?: Date | null;
}

export interface AcquireTurnInput {
  userId: string;
  taskId: string;
  turnId: string;
  now: Date;
  requiredAccountId?: string | null;
}

export interface LeasedTurn {
  kind: "LEASED";
  accountId: string;
  leaseId: string;
  userId: string;
  taskId: string;
  turnId: string;
  accountSlot: number;
  turnSlot: number;
  reusedUserSlot: boolean;
}

export interface QueuedTurn {
  kind: "QUEUED";
  ticket: number;
  userId: string;
  taskId: string;
  turnId: string;
  requiredAccountId: string | null;
  position: number;
  reason: QueueReason;
  etaMs: number;
  etaEstimated: boolean;
}

export type AcquireTurnResult = LeasedTurn | QueuedTurn;

interface AccountSlotRow {
  account_id: string;
  slot_index: number;
  user_id: string;
  lease_id: string;
}

interface EligibleAccountRow {
  id: string;
  max_active_users: number;
  active_users: number;
}

interface QueueRow {
  ticket: number;
  user_id: string;
  task_id: string;
  turn_id: string;
  required_account_id: string | null;
  reason: QueueReason;
  status: "WAITING" | "ASSIGNED" | "CANCELLED";
  enqueued_at: number;
}

export interface QueueEntry {
  ticket: number;
  userId: string;
  taskId: string;
  turnId: string;
  requiredAccountId: string | null;
  reason: QueueReason;
  status: "WAITING" | "ASSIGNED" | "CANCELLED";
  enqueuedAt: Date;
  position: number;
}

export interface TaskQueueSnapshot {
  ticket: number;
  position: number;
  etaMs: number;
  etaEstimated: boolean;
}

const QUOTA_FRESHNESS_MS = 5 * 60_000;
const DEFAULT_IDLE_LEASE_MS = 30 * 60_000;
const DEFAULT_ETA_MS = 10 * 60_000;

export class SQLiteLeaseStore {
  constructor(private readonly sqlite: Database.Database) {}

  addAccount(input: AccountInput): void {
    if (!Number.isInteger(input.maxActiveUsers) || input.maxActiveUsers < 1) {
      throw new Error("maxActiveUsers must be a positive integer");
    }

    this.immediateTransaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO codex_accounts (
            id, alias, codex_home, status, auth_status, max_active_users, weekly_remaining,
            quota_updated_at, allow_unknown_quota, health_score, last_assigned_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.alias,
          input.codexHome ?? null,
          input.status,
          input.authStatus,
          input.maxActiveUsers,
          input.weeklyRemaining,
          input.quotaUpdatedAt?.getTime() ?? null,
          input.allowUnknownQuota ? 1 : 0,
          input.healthScore,
          input.lastAssignedAt?.getTime() ?? null,
          Date.now(),
        );

      const insertSlot = this.sqlite.prepare(
        "INSERT INTO account_slots (account_id, slot_index) VALUES (?, ?)",
      );
      for (let slotIndex = 0; slotIndex < input.maxActiveUsers; slotIndex += 1) {
        insertSlot.run(input.id, slotIndex);
      }
    });
  }

  updateAccount(
    accountId: string,
    changes: Partial<
      Pick<AccountInput, "status" | "authStatus" | "allowUnknownQuota" | "healthScore" | "alias">
    >,
  ): void {
    const columns: string[] = [];
    const values: unknown[] = [];
    const columnByKey = {
      status: "status",
      authStatus: "auth_status",
      allowUnknownQuota: "allow_unknown_quota",
      healthScore: "health_score",
      alias: "alias",
    } as const;

    for (const key of Object.keys(changes) as Array<keyof typeof columnByKey>) {
      const value = changes[key];
      if (value === undefined) continue;
      columns.push(`${columnByKey[key]} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }

    if (columns.length === 0) return;
    const result = this.sqlite
      .prepare(`UPDATE codex_accounts SET ${columns.join(", ")} WHERE id = ?`)
      .run(...values, accountId);
    if (result.changes !== 1) throw new Error(`Unknown Codex account: ${accountId}`);
  }

  updateQuota(
    accountId: string,
    quota: { weeklyRemaining: number | null; quotaUpdatedAt: Date },
  ): void {
    const result = this.sqlite
      .prepare("UPDATE codex_accounts SET weekly_remaining = ?, quota_updated_at = ? WHERE id = ?")
      .run(quota.weeklyRemaining, quota.quotaUpdatedAt.getTime(), accountId);
    if (result.changes !== 1) throw new Error(`Unknown Codex account: ${accountId}`);
  }

  acquireTurn(input: AcquireTurnInput): AcquireTurnResult {
    return this.immediateTransaction(() => {
      const waiting = this.sqlite
        .prepare("SELECT 1 FROM queue_entries WHERE status = 'WAITING' LIMIT 1")
        .get();
      if (waiting) {
        const reason = this.getQueueReason(input);
        return this.enqueue(input, reason);
      }
      const leased = this.tryAcquireTurn(input);
      if (leased) return leased;

      const reason = this.getQueueReason(input);
      return this.enqueue(input, reason);
    });
  }

  releaseTurn(turnId: string, now: Date): LeasedTurn[] {
    this.immediateTransaction(() => {
      this.sqlite
        .prepare(
          `UPDATE queue_entries
           SET status = 'CANCELLED'
           WHERE turn_id = ? AND status = 'WAITING'`,
        )
        .run(turnId);
      const turn = this.sqlite
        .prepare(
          `SELECT account_id, user_id, task_id, turn_id
           FROM user_turn_slots WHERE turn_id = ?`,
        )
        .get(turnId) as
        | { account_id: string; user_id: string; task_id: string; turn_id: string }
        | undefined;
      if (!turn) return;

      this.sqlite.prepare("DELETE FROM user_turn_slots WHERE turn_id = ?").run(turnId);
      this.sqlite
        .prepare(
          `UPDATE account_slots SET last_activity_at = ?
           WHERE account_id = ? AND user_id = ?`,
        )
        .run(now.getTime(), turn.account_id, turn.user_id);
      this.sqlite
        .prepare(
          `UPDATE account_leases SET last_heartbeat_at = ?
           WHERE account_id = ? AND user_id = ? AND status = 'ACTIVE'`,
        )
        .run(now.getTime(), turn.account_id, turn.user_id);
    });

    return this.promoteQueue(now);
  }

  heartbeatTurn(turnId: string, now: Date): boolean {
    return this.immediateTransaction(() => {
      const turn = this.sqlite
        .prepare("SELECT account_id, user_id FROM user_turn_slots WHERE turn_id = ?")
        .get(turnId) as { account_id: string; user_id: string } | undefined;
      if (!turn) return false;

      this.sqlite
        .prepare("UPDATE user_turn_slots SET heartbeat_at = ? WHERE turn_id = ?")
        .run(now.getTime(), turnId);
      this.sqlite
        .prepare(
          `UPDATE account_slots SET last_activity_at = ?
           WHERE account_id = ? AND user_id = ?`,
        )
        .run(now.getTime(), turn.account_id, turn.user_id);
      this.sqlite
        .prepare(
          `UPDATE account_leases SET last_heartbeat_at = ?
           WHERE account_id = ? AND user_id = ? AND status = 'ACTIVE'`,
        )
        .run(now.getTime(), turn.account_id, turn.user_id);
      return true;
    });
  }

  markStaleTurnsForRecovery(now: Date, staleAfterMs = 45_000): string[] {
    return this.immediateTransaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT turn_id FROM user_turn_slots
           WHERE status = 'RUNNING' AND heartbeat_at < ? ORDER BY acquired_at`,
        )
        .all(now.getTime() - staleAfterMs) as Array<{ turn_id: string }>;
      if (rows.length > 0) {
        const mark = this.sqlite.prepare(
          "UPDATE user_turn_slots SET status = 'NEEDS_RECOVERY' WHERE turn_id = ?",
        );
        for (const row of rows) mark.run(row.turn_id);
      }
      return rows.map((row) => row.turn_id);
    });
  }

  markAllRunningTurnsForRecovery(): string[] {
    return this.immediateTransaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT turn_id FROM user_turn_slots
           WHERE status IN ('RUNNING', 'NEEDS_RECOVERY')
           ORDER BY acquired_at, turn_id`,
        )
        .all() as Array<{ turn_id: string }>;
      if (rows.length > 0) {
        this.sqlite
          .prepare("UPDATE user_turn_slots SET status = 'NEEDS_RECOVERY' WHERE status = 'RUNNING'")
          .run();
      }
      return rows.map((row) => row.turn_id);
    });
  }

  markAccountTurnsForRecovery(accountId: string): string[] {
    return this.immediateTransaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT turn_id FROM user_turn_slots
           WHERE account_id = ? AND status IN ('RUNNING', 'NEEDS_RECOVERY')
           ORDER BY acquired_at, turn_id`,
        )
        .all(accountId) as Array<{ turn_id: string }>;
      if (rows.length > 0) {
        this.sqlite
          .prepare(
            `UPDATE user_turn_slots
             SET status = 'NEEDS_RECOVERY'
             WHERE account_id = ? AND status = 'RUNNING'`,
          )
          .run(accountId);
      }
      return rows.map((row) => row.turn_id);
    });
  }

  releaseIdleLeases(now: Date, idleAfterMs = DEFAULT_IDLE_LEASE_MS): LeasedTurn[] {
    this.immediateTransaction(() => {
      const idle = this.sqlite
        .prepare(
          `SELECT s.account_id, s.slot_index, s.user_id, s.lease_id
           FROM account_slots s
           WHERE s.user_id IS NOT NULL
             AND s.last_activity_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM user_turn_slots t
               WHERE t.account_id = s.account_id AND t.user_id = s.user_id
             )`,
        )
        .all(now.getTime() - idleAfterMs) as AccountSlotRow[];

      const releaseLease = this.sqlite.prepare(
        `UPDATE account_leases
         SET status = 'RELEASED', released_at = ?, release_reason = 'IDLE_TIMEOUT'
         WHERE id = ? AND status = 'ACTIVE'`,
      );
      const clearSlot = this.sqlite.prepare(
        `UPDATE account_slots
         SET user_id = NULL, lease_id = NULL, claimed_at = NULL, last_activity_at = NULL
         WHERE account_id = ? AND slot_index = ?`,
      );
      const makeAvailable = this.sqlite.prepare(
        "UPDATE codex_accounts SET status = 'AVAILABLE' WHERE id = ? AND status = 'FULL'",
      );

      for (const slot of idle) {
        releaseLease.run(now.getTime(), slot.lease_id);
        clearSlot.run(slot.account_id, slot.slot_index);
        makeAvailable.run(slot.account_id);
      }
    });

    return this.promoteQueue(now);
  }

  promoteQueue(now: Date): LeasedTurn[] {
    const promoted: LeasedTurn[] = [];
    while (true) {
      const result = this.immediateTransaction(() => {
        const entries = this.sqlite
          .prepare("SELECT * FROM queue_entries WHERE status = 'WAITING' ORDER BY ticket")
          .all() as QueueRow[];
        const blockedAccountIds = new Set<string>();
        for (const entry of entries) {
          const resourceAccountId =
            entry.required_account_id ??
            this.findExistingUserAccount(entry.user_id, entry.required_account_id);
          if (resourceAccountId && blockedAccountIds.has(resourceAccountId)) continue;

          const leased = this.tryAcquireTurn(
            {
              userId: entry.user_id,
              taskId: entry.task_id,
              turnId: entry.turn_id,
              now,
              requiredAccountId: entry.required_account_id,
            },
            blockedAccountIds,
          );
          if (!leased) {
            if (resourceAccountId) blockedAccountIds.add(resourceAccountId);
            continue;
          }

          this.sqlite
            .prepare(
              `UPDATE queue_entries
               SET status = 'ASSIGNED', assigned_at = ?, account_id = ?, lease_id = ?
               WHERE ticket = ? AND status = 'WAITING'`,
            )
            .run(now.getTime(), leased.accountId, leased.leaseId, entry.ticket);
          return leased;
        }
        return null;
      });
      if (!result) break;
      promoted.push(result);
    }
    return promoted;
  }

  getQueue(): QueueEntry[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM queue_entries WHERE status = 'WAITING' ORDER BY ticket")
      .all() as QueueRow[];
    return rows.map((row, index) => ({
      ticket: row.ticket,
      userId: row.user_id,
      taskId: row.task_id,
      turnId: row.turn_id,
      requiredAccountId: row.required_account_id,
      reason: row.reason,
      status: row.status,
      enqueuedAt: new Date(row.enqueued_at),
      position: index + 1,
    }));
  }

  getQueueEntry(taskId: string, userId: string): TaskQueueSnapshot | null {
    const row = this.sqlite
      .prepare(
        `SELECT q.ticket,
          (SELECT COUNT(*) FROM queue_entries preceding
           WHERE preceding.status = 'WAITING' AND preceding.ticket <= q.ticket) AS position
         FROM queue_entries q
         WHERE q.task_id = ? AND q.user_id = ? AND q.status = 'WAITING'`,
      )
      .get(taskId, userId) as { ticket: number; position: number } | undefined;
    if (!row) return null;
    const eta = this.estimateWait();
    return {
      ticket: row.ticket,
      position: row.position,
      etaMs: eta.durationMs * row.position,
      etaEstimated: eta.estimated,
    };
  }

  getAccountOccupancy(accountId: string): { activeUsers: number; activeTurns: number } {
    const row = this.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM account_slots WHERE account_id = ? AND user_id IS NOT NULL) AS active_users,
           (SELECT COUNT(*) FROM user_turn_slots WHERE account_id = ?) AS active_turns`,
      )
      .get(accountId, accountId) as { active_users: number; active_turns: number };
    return { activeUsers: row.active_users, activeTurns: row.active_turns };
  }

  recordTurnDuration(durationMs: number, completedAt: Date): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error("durationMs must be a non-negative finite number");
    }
    this.sqlite
      .prepare("INSERT INTO turn_duration_samples (duration_ms, completed_at) VALUES (?, ?)")
      .run(Math.round(durationMs), completedAt.getTime());
  }

  private tryAcquireTurn(
    input: AcquireTurnInput,
    excludedAccountIds: ReadonlySet<string> = new Set(),
  ): LeasedTurn | null {
    const requiredAccountId = input.requiredAccountId ?? null;
    const existingSlots = this.sqlite
      .prepare(
        `SELECT account_id, slot_index, user_id, lease_id
         FROM account_slots
         WHERE user_id = ? AND (? IS NULL OR account_id = ?)
         ORDER BY claimed_at`,
      )
      .all(input.userId, requiredAccountId, requiredAccountId) as AccountSlotRow[];
    const existingSlot = existingSlots.find((slot) => !excludedAccountIds.has(slot.account_id));

    if (existingSlot) {
      if (this.isAccountEligibleForExistingUser(existingSlot.account_id, input.now)) {
        const turnSlot = this.findFreeTurnSlot(existingSlot.account_id, input.userId);
        if (turnSlot === null) return null;
        this.insertTurn(input, existingSlot.account_id, turnSlot);
        this.touchLease(
          existingSlot.lease_id,
          existingSlot.account_id,
          existingSlot.slot_index,
          input.now,
        );
        return {
          kind: "LEASED",
          accountId: existingSlot.account_id,
          leaseId: existingSlot.lease_id,
          userId: input.userId,
          taskId: input.taskId,
          turnId: input.turnId,
          accountSlot: existingSlot.slot_index,
          turnSlot,
          reusedUserSlot: true,
        };
      }
      if (!this.releaseIdleUserSlot(existingSlot, input.now, "ACCOUNT_INELIGIBLE")) return null;
    }

    if (requiredAccountId) {
      const otherSlots = this.sqlite
        .prepare(
          `SELECT account_id, slot_index, user_id, lease_id
           FROM account_slots
           WHERE user_id = ? AND account_id <> ?
           ORDER BY claimed_at`,
        )
        .all(input.userId, requiredAccountId) as AccountSlotRow[];
      for (const otherSlot of otherSlots) {
        if (!this.releaseIdleUserSlot(otherSlot, input.now, "THREAD_ACCOUNT_AFFINITY")) {
          return null;
        }
      }
    }

    const account = this.selectEligibleAccount(input.now, requiredAccountId, excludedAccountIds);
    if (!account) return null;

    const freeSlot = this.sqlite
      .prepare(
        `SELECT slot_index FROM account_slots
         WHERE account_id = ? AND user_id IS NULL ORDER BY slot_index LIMIT 1`,
      )
      .get(account.id) as { slot_index: number } | undefined;
    if (!freeSlot) return null;

    const leaseId = randomUUID();
    this.sqlite
      .prepare(
        `UPDATE account_slots
         SET user_id = ?, lease_id = ?, claimed_at = ?, last_activity_at = ?
         WHERE account_id = ? AND slot_index = ? AND user_id IS NULL`,
      )
      .run(
        input.userId,
        leaseId,
        input.now.getTime(),
        input.now.getTime(),
        account.id,
        freeSlot.slot_index,
      );
    this.sqlite
      .prepare(
        `INSERT INTO account_leases (
          id, account_id, user_id, slot_index, status, acquired_at, last_heartbeat_at
         ) VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)`,
      )
      .run(
        leaseId,
        account.id,
        input.userId,
        freeSlot.slot_index,
        input.now.getTime(),
        input.now.getTime(),
      );
    this.insertTurn(input, account.id, 0);
    this.sqlite
      .prepare("UPDATE codex_accounts SET last_assigned_at = ? WHERE id = ?")
      .run(input.now.getTime(), account.id);

    if (account.active_users + 1 >= account.max_active_users) {
      this.sqlite
        .prepare("UPDATE codex_accounts SET status = 'FULL' WHERE id = ? AND status = 'AVAILABLE'")
        .run(account.id);
    }

    return {
      kind: "LEASED",
      accountId: account.id,
      leaseId,
      userId: input.userId,
      taskId: input.taskId,
      turnId: input.turnId,
      accountSlot: freeSlot.slot_index,
      turnSlot: 0,
      reusedUserSlot: false,
    };
  }

  private selectEligibleAccount(
    now: Date,
    requiredAccountId: string | null,
    excludedAccountIds: ReadonlySet<string>,
  ): EligibleAccountRow | null {
    const accounts = this.sqlite
      .prepare(
        `SELECT a.id, a.max_active_users,
                  COUNT(s.user_id) AS active_users
           FROM codex_accounts a
           LEFT JOIN account_slots s ON s.account_id = a.id
           WHERE a.status = 'AVAILABLE'
             AND a.auth_status = 'AUTHENTICATED'
             AND a.health_score > 0
             AND (? IS NULL OR a.id = ?)
             AND (
               (a.weekly_remaining IS NOT NULL
                 AND a.weekly_remaining > 0
                 AND a.quota_updated_at >= ?)
               OR (a.weekly_remaining IS NULL AND a.allow_unknown_quota = 1)
             )
           GROUP BY a.id
           HAVING active_users < a.max_active_users
           ORDER BY
             (a.weekly_remaining IS NOT NULL) DESC,
             a.weekly_remaining DESC,
             active_users ASC,
             a.health_score DESC,
             (a.last_assigned_at IS NULL) DESC,
             a.last_assigned_at ASC,
             a.id ASC
           `,
      )
      .all(
        requiredAccountId,
        requiredAccountId,
        now.getTime() - QUOTA_FRESHNESS_MS,
      ) as EligibleAccountRow[];
    return accounts.find((account) => !excludedAccountIds.has(account.id)) ?? null;
  }

  private findExistingUserAccount(userId: string, requiredAccountId: string | null): string | null {
    const row = this.sqlite
      .prepare(
        `SELECT account_id
         FROM account_slots
         WHERE user_id = ? AND (? IS NULL OR account_id = ?)
         ORDER BY claimed_at LIMIT 1`,
      )
      .get(userId, requiredAccountId, requiredAccountId) as { account_id: string } | undefined;
    return row?.account_id ?? requiredAccountId;
  }

  private getQueueReason(input: AcquireTurnInput): QueueReason {
    const requiredAccountId = input.requiredAccountId ?? null;
    const existing = this.sqlite
      .prepare(
        `SELECT account_id FROM account_slots
         WHERE user_id = ? AND (? IS NULL OR account_id = ?)
         LIMIT 1`,
      )
      .get(input.userId, requiredAccountId, requiredAccountId) as
      | { account_id: string }
      | undefined;
    if (existing) {
      return this.isAccountEligibleForExistingUser(existing.account_id, input.now)
        ? "USER_TURN_LIMIT"
        : "NO_ELIGIBLE_ACCOUNT";
    }

    if (requiredAccountId) {
      const activeOnOtherAccount = this.sqlite
        .prepare(
          `SELECT 1 FROM user_turn_slots
           WHERE user_id = ? AND account_id <> ? LIMIT 1`,
        )
        .get(input.userId, requiredAccountId);
      if (activeOnOtherAccount) return "USER_TURN_LIMIT";
    }

    const otherwiseEligible = this.sqlite
      .prepare(
        `SELECT 1 FROM codex_accounts
         WHERE status IN ('AVAILABLE', 'FULL')
           AND auth_status = 'AUTHENTICATED'
           AND health_score > 0
           AND (? IS NULL OR id = ?)
           AND (
             (weekly_remaining IS NOT NULL AND weekly_remaining > 0 AND quota_updated_at >= ?)
             OR (weekly_remaining IS NULL AND allow_unknown_quota = 1)
           ) LIMIT 1`,
      )
      .get(requiredAccountId, requiredAccountId, input.now.getTime() - QUOTA_FRESHNESS_MS);
    return otherwiseEligible ? "ACCOUNT_USER_LIMIT" : "NO_ELIGIBLE_ACCOUNT";
  }

  private isAccountEligibleForExistingUser(accountId: string, now: Date): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          `SELECT 1 FROM codex_accounts
           WHERE id = ?
             AND status IN ('AVAILABLE', 'FULL')
             AND auth_status = 'AUTHENTICATED'
             AND health_score > 0
             AND (
               (weekly_remaining IS NOT NULL
                 AND weekly_remaining > 0
                 AND quota_updated_at >= ?)
               OR (weekly_remaining IS NULL AND allow_unknown_quota = 1)
             )`,
        )
        .get(accountId, now.getTime() - QUOTA_FRESHNESS_MS),
    );
  }

  private releaseIdleUserSlot(
    slot: AccountSlotRow,
    now: Date,
    reason: "ACCOUNT_INELIGIBLE" | "THREAD_ACCOUNT_AFFINITY",
  ): boolean {
    const activeTurn = this.sqlite
      .prepare(
        `SELECT 1 FROM user_turn_slots
         WHERE account_id = ? AND user_id = ? LIMIT 1`,
      )
      .get(slot.account_id, slot.user_id);
    if (activeTurn) return false;
    this.sqlite
      .prepare(
        `UPDATE account_leases
         SET status = 'RELEASED', released_at = ?, release_reason = ?
         WHERE id = ? AND status = 'ACTIVE'`,
      )
      .run(now.getTime(), reason, slot.lease_id);
    this.sqlite
      .prepare(
        `UPDATE account_slots
         SET user_id = NULL, lease_id = NULL, claimed_at = NULL, last_activity_at = NULL
         WHERE account_id = ? AND slot_index = ? AND user_id = ?`,
      )
      .run(slot.account_id, slot.slot_index, slot.user_id);
    this.sqlite
      .prepare("UPDATE codex_accounts SET status = 'AVAILABLE' WHERE id = ? AND status = 'FULL'")
      .run(slot.account_id);
    return true;
  }

  private enqueue(input: AcquireTurnInput, reason: QueueReason): QueuedTurn {
    this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO queue_entries (
          user_id, task_id, turn_id, required_account_id, reason, status, enqueued_at
        ) VALUES (?, ?, ?, ?, ?, 'WAITING', ?)`,
      )
      .run(
        input.userId,
        input.taskId,
        input.turnId,
        input.requiredAccountId ?? null,
        reason,
        input.now.getTime(),
      );
    const row = this.sqlite
      .prepare("SELECT * FROM queue_entries WHERE turn_id = ? AND status = 'WAITING'")
      .get(input.turnId) as QueueRow;
    const positionRow = this.sqlite
      .prepare(
        "SELECT COUNT(*) AS position FROM queue_entries WHERE status = 'WAITING' AND ticket <= ?",
      )
      .get(row.ticket) as { position: number };
    const eta = this.estimateWait();
    return {
      kind: "QUEUED",
      ticket: row.ticket,
      userId: row.user_id,
      taskId: row.task_id,
      turnId: row.turn_id,
      requiredAccountId: row.required_account_id,
      position: positionRow.position,
      reason: row.reason,
      etaMs: eta.durationMs * positionRow.position,
      etaEstimated: eta.estimated,
    };
  }

  private estimateWait(): { durationMs: number; estimated: boolean } {
    const rows = this.sqlite
      .prepare(
        `SELECT duration_ms FROM turn_duration_samples
         ORDER BY completed_at DESC, id DESC LIMIT 20`,
      )
      .all() as Array<{ duration_ms: number }>;
    if (rows.length === 0) return { durationMs: DEFAULT_ETA_MS, estimated: true };
    const sorted = rows.map((row) => row.duration_ms).sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const durationMs =
      sorted.length % 2 === 1
        ? (sorted[middle] ?? DEFAULT_ETA_MS)
        : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
    return { durationMs, estimated: rows.length < 3 };
  }

  private findFreeTurnSlot(accountId: string, userId: string): number | null {
    const rows = this.sqlite
      .prepare(
        `SELECT slot_index FROM user_turn_slots
         WHERE account_id = ? AND user_id = ? ORDER BY slot_index`,
      )
      .all(accountId, userId) as Array<{ slot_index: number }>;
    const occupied = new Set(rows.map((row) => row.slot_index));
    for (let slotIndex = 0; slotIndex < 2; slotIndex += 1) {
      if (!occupied.has(slotIndex)) return slotIndex;
    }
    return null;
  }

  private insertTurn(input: AcquireTurnInput, accountId: string, turnSlot: number): void {
    this.sqlite
      .prepare(
        `INSERT INTO user_turn_slots (
          account_id, user_id, slot_index, task_id, turn_id, status, acquired_at, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?)`,
      )
      .run(
        accountId,
        input.userId,
        turnSlot,
        input.taskId,
        input.turnId,
        input.now.getTime(),
        input.now.getTime(),
      );
  }

  private touchLease(leaseId: string, accountId: string, accountSlot: number, now: Date): void {
    this.sqlite
      .prepare(
        `UPDATE account_slots SET last_activity_at = ?
         WHERE account_id = ? AND slot_index = ?`,
      )
      .run(now.getTime(), accountId, accountSlot);
    this.sqlite
      .prepare(
        `UPDATE account_leases SET last_heartbeat_at = ?
         WHERE id = ? AND status = 'ACTIVE'`,
      )
      .run(now.getTime(), leaseId);
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
