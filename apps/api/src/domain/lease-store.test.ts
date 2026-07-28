import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type PlatformDatabase } from "../infra/db/database.js";
import { migrateDatabase } from "../infra/db/migrate.js";
import { SQLiteLeaseStore } from "./lease-store.js";

const NOW = new Date("2026-07-21T08:00:00.000Z");

describe("SQLiteLeaseStore", () => {
  let database: PlatformDatabase;
  let store: SQLiteLeaseStore;

  beforeEach(() => {
    database = createDatabase(":memory:");
    migrateDatabase(database.sqlite);
    store = new SQLiteLeaseStore(database.sqlite);
  });

  afterEach(() => {
    database.sqlite.close();
  });

  test("grants four unique users and queues the fifth on a single account", () => {
    store.addAccount(account("account-1"));

    const results = Array.from({ length: 5 }, (_, index) =>
      store.acquireTurn({
        userId: `user-${index + 1}`,
        taskId: `task-${index + 1}`,
        turnId: `turn-${index + 1}`,
        now: NOW,
      }),
    );

    expect(results.slice(0, 4).every((result) => result.kind === "LEASED")).toBe(true);
    expect(results[4]).toMatchObject({
      kind: "QUEUED",
      position: 1,
      reason: "ACCOUNT_USER_LIMIT",
      etaMs: 600_000,
      etaEstimated: true,
    });
    expect(store.getAccountOccupancy("account-1")).toEqual({ activeUsers: 4, activeTurns: 4 });
  });

  test("two turns from one user share a user slot and a third turn queues", () => {
    store.addAccount(account("account-1"));

    const first = store.acquireTurn(request("user-1", "task-1", "turn-1"));
    const second = store.acquireTurn(request("user-1", "task-2", "turn-2"));
    const third = store.acquireTurn(request("user-1", "task-3", "turn-3"));

    expect(first).toMatchObject({ kind: "LEASED", accountId: "account-1", reusedUserSlot: false });
    expect(second).toMatchObject({ kind: "LEASED", accountId: "account-1", reusedUserSlot: true });
    expect(third).toMatchObject({
      kind: "QUEUED",
      position: 1,
      reason: "USER_TURN_LIMIT",
    });
    expect(store.getAccountOccupancy("account-1")).toEqual({ activeUsers: 1, activeTurns: 2 });
  });

  test("selects by weekly remaining, active users, health, then least recently assigned", () => {
    store.addAccount(account("quota-low", { weeklyRemaining: 20, healthScore: 100 }));
    store.addAccount(account("quota-high", { weeklyRemaining: 80, healthScore: 10 }));

    expect(store.acquireTurn(request("user-1", "task-1", "turn-1"))).toMatchObject({
      kind: "LEASED",
      accountId: "quota-high",
    });

    store.updateQuota("quota-low", { weeklyRemaining: 80, quotaUpdatedAt: NOW });
    expect(store.acquireTurn(request("user-2", "task-2", "turn-2"))).toMatchObject({
      kind: "LEASED",
      accountId: "quota-low",
    });

    store.updateAccount("quota-low", { healthScore: 5 });
    store.releaseTurn("turn-1", new Date(NOW.getTime() + 1_000));
    store.releaseIdleLeases(new Date(NOW.getTime() + 31 * 60_000));
    store.updateQuota("quota-high", {
      weeklyRemaining: 80,
      quotaUpdatedAt: new Date(NOW.getTime() + 31 * 60_000),
    });
    store.updateQuota("quota-low", {
      weeklyRemaining: 80,
      quotaUpdatedAt: new Date(NOW.getTime() + 31 * 60_000),
    });

    expect(store.acquireTurn(request("user-3", "task-3", "turn-3", 32 * 60_000))).toMatchObject({
      kind: "LEASED",
      accountId: "quota-high",
    });
  });

  test("projects the same eligible account set used for model-catalog routing", () => {
    store.addAccount(account("quota-high", { weeklyRemaining: 80, maxActiveUsers: 1 }));
    store.addAccount(account("quota-low", { weeklyRemaining: 20 }));

    expect(store.listEligibleAccountIdsForUser("user-1", NOW)).toEqual(["quota-high", "quota-low"]);
    expect(store.acquireTurn(request("user-1", "task-1", "turn-1"))).toMatchObject({
      kind: "LEASED",
      accountId: "quota-high",
    });

    expect(store.listEligibleAccountIdsForUser("user-1", NOW)).toEqual(["quota-high"]);
    expect(store.listEligibleAccountIdsForUser("user-2", NOW)).toEqual(["quota-low"]);
    expect(store.listEligibleAccountIdsForUser("user-1", NOW, "quota-low")).toEqual([]);
    expect(store.listModelRoutingAccountIdsForUser("user-2", NOW)).toEqual([
      "quota-high",
      "quota-low",
    ]);
    expect(store.listModelRoutingAccountIdsForUser("user-1", NOW, "quota-low")).toEqual([
      "quota-low",
    ]);
  });

  test("lists FULL accounts as assignable only for the user that already owns a slot", () => {
    store.addAccount(account("available", { weeklyRemaining: 80 }));
    store.addAccount(
      account("full", { weeklyRemaining: 90, maxActiveUsers: 1, status: "AVAILABLE" }),
    );

    expect(store.acquireTurn(request("user-with-slot", "task-1", "turn-1"))).toMatchObject({
      kind: "LEASED",
      accountId: "full",
    });

    expect(store.listAssignableAccountIdsForUser("new-user", NOW)).toEqual(["available"]);
    expect(store.listAssignableAccountIdsForUser("user-with-slot", NOW)).toEqual(["full"]);
  });

  test("selects the account required by an existing Thread instead of a higher-quota account", () => {
    store.addAccount(account("thread-account", { weeklyRemaining: 10 }));
    store.addAccount(account("higher-quota-account", { weeklyRemaining: 90 }));

    expect(
      store.acquireTurn({
        ...request("user-1", "task-1", "turn-1"),
        requiredAccountId: "thread-account",
      }),
    ).toMatchObject({
      kind: "LEASED",
      accountId: "thread-account",
    });
  });

  test("persists required account affinity and promotes only onto that account", () => {
    store.addAccount(account("thread-account", { weeklyRemaining: 10 }));
    store.addAccount(account("other-account", { weeklyRemaining: 90 }));
    expect(store.acquireTurn(request("user-1", "task-1", "turn-on-other"))).toMatchObject({
      kind: "LEASED",
      accountId: "other-account",
    });

    expect(
      store.acquireTurn({
        ...request("user-1", "task-2", "turn-pinned"),
        requiredAccountId: "thread-account",
      }),
    ).toMatchObject({
      kind: "QUEUED",
    });
    expect(store.getQueue()).toEqual([
      expect.objectContaining({
        taskId: "task-2",
        turnId: "turn-pinned",
        requiredAccountId: "thread-account",
      }),
    ]);

    const promoted = store.releaseTurn("turn-on-other", new Date(NOW.getTime() + 1_000));
    expect(promoted).toEqual([
      expect.objectContaining({
        kind: "LEASED",
        accountId: "thread-account",
        taskId: "task-2",
        turnId: "turn-pinned",
      }),
    ]);
    expect(store.getAccountOccupancy("other-account")).toEqual({
      activeUsers: 0,
      activeTurns: 0,
    });
  });

  test("queues a required account when it is unavailable instead of falling back", () => {
    store.addAccount(account("thread-account", { status: "QUARANTINED" }));
    store.addAccount(account("fallback-account", { weeklyRemaining: 100 }));

    expect(
      store.acquireTurn({
        ...request("user-1", "task-1", "turn-1"),
        requiredAccountId: "thread-account",
      }),
    ).toMatchObject({
      kind: "QUEUED",
      reason: "NO_ELIGIBLE_ACCOUNT",
    });
    expect(store.getQueue()).toEqual([
      expect.objectContaining({
        requiredAccountId: "thread-account",
      }),
    ]);
    expect(store.getAccountOccupancy("fallback-account")).toEqual({
      activeUsers: 0,
      activeTurns: 0,
    });
  });

  test.each(["DRAINING", "QUARANTINED", "REAUTH_REQUIRED", "EXHAUSTED"] as const)(
    "does not assign an account in %s state",
    (status) => {
      store.addAccount(account("blocked", { status }));

      expect(store.acquireTurn(request("user-1", "task-1", "turn-1"))).toMatchObject({
        kind: "QUEUED",
        reason: "NO_ELIGIBLE_ACCOUNT",
      });
    },
  );

  test.each(["DRAINING", "QUARANTINED", "REAUTH_REQUIRED", "EXHAUSTED"] as const)(
    "does not reuse an existing user slot after the account becomes %s",
    (status) => {
      store.addAccount(account("blocked-after-lease"));
      store.acquireTurn(request("user-1", "task-1", "turn-1"));
      store.releaseTurn("turn-1", new Date(NOW.getTime() + 1_000));
      store.updateAccount("blocked-after-lease", { status });

      expect(store.acquireTurn(request("user-1", "task-2", "turn-2", 2_000))).toMatchObject({
        kind: "QUEUED",
        reason: "NO_ELIGIBLE_ACCOUNT",
      });
    },
  );

  test("moves an idle retained user slot to a healthy account at the next Turn boundary", () => {
    store.addAccount(account("primary", { weeklyRemaining: 90 }));
    store.addAccount(account("fallback", { weeklyRemaining: 50 }));
    expect(store.acquireTurn(request("user-1", "task-1", "turn-1"))).toMatchObject({
      kind: "LEASED",
      accountId: "primary",
    });
    store.releaseTurn("turn-1", new Date(NOW.getTime() + 1_000));
    store.updateAccount("primary", { status: "QUARANTINED" });

    expect(store.acquireTurn(request("user-1", "task-2", "turn-2", 2_000))).toMatchObject({
      kind: "LEASED",
      accountId: "fallback",
      reusedUserSlot: false,
    });
    expect(store.getAccountOccupancy("primary")).toEqual({ activeUsers: 0, activeTurns: 0 });
    expect(store.getAccountOccupancy("fallback")).toEqual({ activeUsers: 1, activeTurns: 1 });
  });

  test("does not reuse a slot after authentication, health, or quota becomes ineligible", () => {
    const assertBlockedAfter = (id: string, block: () => void, offsetMs: number) => {
      store.addAccount(account(id));
      store.acquireTurn(request(`user-${id}`, `task-${id}-1`, `turn-${id}-1`, offsetMs));
      store.releaseTurn(`turn-${id}-1`, new Date(NOW.getTime() + offsetMs + 1));
      block();
      expect(
        store.acquireTurn(request(`user-${id}`, `task-${id}-2`, `turn-${id}-2`, offsetMs + 2)),
      ).toMatchObject({ kind: "QUEUED", reason: "NO_ELIGIBLE_ACCOUNT" });
    };

    assertBlockedAfter("auth", () => store.updateAccount("auth", { authStatus: "EXPIRED" }), 0);
    assertBlockedAfter("health", () => store.updateAccount("health", { healthScore: 0 }), 10);
    assertBlockedAfter(
      "quota",
      () => store.updateQuota("quota", { weeklyRemaining: 0, quotaUpdatedAt: NOW }),
      20,
    );
  });

  test("rejects stale and unknown weekly quota unless an administrator enables the override", () => {
    store.addAccount(
      account("stale", {
        weeklyRemaining: 90,
        quotaUpdatedAt: new Date(NOW.getTime() - 5 * 60_000 - 1),
      }),
    );
    store.addAccount(
      account("unknown", {
        weeklyRemaining: null,
        quotaUpdatedAt: NOW,
        allowUnknownQuota: false,
      }),
    );

    expect(store.acquireTurn(request("user-1", "task-1", "turn-1"))).toMatchObject({
      kind: "QUEUED",
      reason: "NO_ELIGIBLE_ACCOUNT",
    });

    store.updateAccount("unknown", { allowUnknownQuota: true });
    expect(store.promoteQueue(new Date(NOW.getTime() + 1))).toEqual([
      expect.objectContaining({
        kind: "LEASED",
        accountId: "unknown",
        taskId: "task-1",
      }),
    ]);
    expect(store.acquireTurn(request("user-2", "task-2", "turn-2"))).toMatchObject({
      kind: "LEASED",
      accountId: "unknown",
    });
  });

  test("promotes the FIFO head when a user slot is released", () => {
    store.addAccount(account("account-1"));
    for (let index = 1; index <= 4; index += 1) {
      store.acquireTurn(request(`user-${index}`, `task-${index}`, `turn-${index}`));
    }
    store.acquireTurn(request("user-5", "task-5", "turn-5"));
    store.acquireTurn(request("user-6", "task-6", "turn-6"));

    store.releaseTurn("turn-1", new Date(NOW.getTime() + 1_000));
    store.updateQuota("account-1", {
      weeklyRemaining: 50,
      quotaUpdatedAt: new Date(NOW.getTime() + 31 * 60_000),
    });
    const promoted = store.releaseIdleLeases(new Date(NOW.getTime() + 31 * 60_000));

    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      kind: "LEASED",
      accountId: "account-1",
      taskId: "task-5",
      turnId: "turn-5",
    });
    expect(store.getQueue()).toEqual([
      expect.objectContaining({ taskId: "task-6", position: 1, status: "WAITING" }),
    ]);
  });

  test("promotes the earliest runnable queue entry without starving another account", () => {
    store.addAccount(account("blocked-account", { status: "QUARANTINED" }));
    store.addAccount(
      account("healthy-account", {
        status: "QUARANTINED",
        maxActiveUsers: 1,
        weeklyRemaining: 90,
      }),
    );
    store.acquireTurn({
      ...request("user-1", "task-pinned", "turn-pinned"),
      requiredAccountId: "blocked-account",
    });
    store.acquireTurn(request("user-2", "task-runnable", "turn-runnable", 1));
    store.updateAccount("healthy-account", { status: "AVAILABLE" });

    expect(store.promoteQueue(new Date(NOW.getTime() + 2))).toEqual([
      expect.objectContaining({
        taskId: "task-runnable",
        turnId: "turn-runnable",
        accountId: "healthy-account",
      }),
    ]);
    expect(store.getQueue()).toEqual([
      expect.objectContaining({
        taskId: "task-pinned",
        requiredAccountId: "blocked-account",
        position: 1,
      }),
    ]);
  });

  test("does not let a new request take capacity from an earlier runnable queue entry", () => {
    store.addAccount(account("blocked-account", { status: "QUARANTINED" }));
    store.addAccount(
      account("healthy-account", {
        status: "QUARANTINED",
        maxActiveUsers: 1,
        weeklyRemaining: 90,
      }),
    );
    store.acquireTurn({
      ...request("user-1", "task-pinned", "turn-pinned"),
      requiredAccountId: "blocked-account",
    });
    store.acquireTurn(request("user-2", "task-earlier", "turn-earlier", 1));
    store.updateAccount("healthy-account", { status: "AVAILABLE" });

    expect(store.acquireTurn(request("user-3", "task-new", "turn-new", 2))).toMatchObject({
      kind: "QUEUED",
    });
    expect(store.promoteQueue(new Date(NOW.getTime() + 3))).toEqual([
      expect.objectContaining({
        taskId: "task-earlier",
        turnId: "turn-earlier",
        accountId: "healthy-account",
      }),
    ]);
    expect(store.getQueue()).toEqual([
      expect.objectContaining({ taskId: "task-pinned", position: 1 }),
      expect.objectContaining({ taskId: "task-new", position: 2 }),
    ]);
  });

  test("preserves FIFO for waiting Turns that target the same account resource", () => {
    store.addAccount(account("account-a", { maxActiveUsers: 4 }));
    store.acquireTurn(request("user-1", "task-running-1", "turn-running-1"));
    store.acquireTurn(request("user-1", "task-running-2", "turn-running-2", 1));
    expect(
      store.acquireTurn({
        ...request("user-1", "task-first", "turn-first", 2),
        requiredAccountId: "account-a",
      }),
    ).toMatchObject({ kind: "QUEUED", position: 1 });
    expect(
      store.acquireTurn({
        ...request("user-2", "task-second", "turn-second", 3),
        requiredAccountId: "account-a",
      }),
    ).toMatchObject({ kind: "QUEUED", position: 2 });

    expect(store.promoteQueue(new Date(NOW.getTime() + 4))).toEqual([]);
    expect(store.releaseTurn("turn-running-1", new Date(NOW.getTime() + 5))).toEqual([
      expect.objectContaining({
        accountId: "account-a",
        taskId: "task-first",
        turnId: "turn-first",
      }),
      expect.objectContaining({
        accountId: "account-a",
        taskId: "task-second",
        turnId: "turn-second",
      }),
    ]);
    expect(store.getQueue()).toEqual([]);
  });

  test("cancels a queued Turn when recovery releases its scheduler allocation", () => {
    store.addAccount(account("account-1", { maxActiveUsers: 1 }));
    store.acquireTurn(request("user-1", "task-1", "turn-running"));
    expect(store.acquireTurn(request("user-2", "task-2", "turn-recovering"))).toMatchObject({
      kind: "QUEUED",
      position: 1,
    });

    expect(store.releaseTurn("turn-recovering", new Date(NOW.getTime() + 1_000))).toEqual([]);
    expect(store.getQueue()).toEqual([]);
    expect(store.releaseTurn("turn-running", new Date(NOW.getTime() + 2_000))).toEqual([]);
  });

  test("uses the rolling median of the latest twenty completed turns for ETA", () => {
    store.addAccount(account("account-1", { maxActiveUsers: 1 }));
    store.recordTurnDuration(100_000, new Date(NOW.getTime() - 3_000));
    store.recordTurnDuration(300_000, new Date(NOW.getTime() - 2_000));
    store.recordTurnDuration(200_000, new Date(NOW.getTime() - 1_000));
    store.acquireTurn(request("user-1", "task-1", "turn-1"));

    expect(store.acquireTurn(request("user-2", "task-2", "turn-2"))).toMatchObject({
      kind: "QUEUED",
      etaMs: 200_000,
      etaEstimated: false,
    });
  });

  test("returns a fresh owner-scoped queue position and ETA for task detail", () => {
    store.addAccount(account("account-1", { maxActiveUsers: 1 }));
    store.recordTurnDuration(100_000, new Date(NOW.getTime() - 3_000));
    store.recordTurnDuration(300_000, new Date(NOW.getTime() - 2_000));
    store.recordTurnDuration(200_000, new Date(NOW.getTime() - 1_000));
    store.acquireTurn(request("user-1", "task-1", "turn-1"));
    store.acquireTurn(request("user-2", "task-2", "turn-2"));
    store.acquireTurn(request("user-3", "task-3", "turn-3"));

    expect(store.getQueueEntry("task-3", "user-3")).toEqual({
      ticket: 2,
      position: 2,
      etaMs: 400_000,
      etaEstimated: false,
    });
    expect(store.getQueueEntry("task-3", "user-2")).toBeNull();
    expect(store.getQueueEntry("missing", "user-3")).toBeNull();
  });

  test("keeps restart recovery slots discoverable until they are released", () => {
    store.addAccount(account("account-1"));
    store.acquireTurn(request("user-1", "task-1", "turn-1"));
    store.acquireTurn(request("user-2", "task-2", "turn-2"));

    expect(store.markAllRunningTurnsForRecovery()).toEqual(["turn-1", "turn-2"]);
    expect(store.markAllRunningTurnsForRecovery()).toEqual(["turn-1", "turn-2"]);
    store.releaseTurn("turn-1", new Date(NOW.getTime() + 1_000));
    expect(store.markAllRunningTurnsForRecovery()).toEqual(["turn-2"]);
    expect(
      database.sqlite.prepare("SELECT turn_id, status FROM user_turn_slots ORDER BY turn_id").all(),
    ).toEqual([{ turn_id: "turn-2", status: "NEEDS_RECOVERY" }]);
  });
});

function account(
  id: string,
  overrides: Partial<Parameters<SQLiteLeaseStore["addAccount"]>[0]> = {},
): Parameters<SQLiteLeaseStore["addAccount"]>[0] {
  return {
    id,
    alias: id,
    status: "AVAILABLE",
    authStatus: "AUTHENTICATED",
    maxActiveUsers: 4,
    weeklyRemaining: 50,
    quotaUpdatedAt: NOW,
    allowUnknownQuota: false,
    healthScore: 100,
    ...overrides,
  };
}

function request(userId: string, taskId: string, turnId: string, offsetMs = 0) {
  return {
    userId,
    taskId,
    turnId,
    now: new Date(NOW.getTime() + offsetMs),
  };
}
