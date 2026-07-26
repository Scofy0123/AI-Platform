import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type PlatformDatabase } from "../infra/db/database.js";
import { migrateDatabase } from "../infra/db/migrate.js";
import { AccountAdminStore } from "./account-admin-store.js";
import { SQLiteLeaseStore } from "./lease-store.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");

describe("AccountAdminStore", () => {
  let database: PlatformDatabase;
  let leases: SQLiteLeaseStore;
  let accounts: AccountAdminStore;

  beforeEach(() => {
    database = createDatabase(":memory:");
    migrateDatabase(database.sqlite);
    database.sqlite
      .prepare(
        `INSERT INTO users (id, tenant_key, open_id, name, role, created_at, updated_at)
         VALUES ('admin-1', 'tenant-1', 'ou_admin', 'Admin', 'ADMIN', ?, ?)`,
      )
      .run(NOW.getTime(), NOW.getTime());
    leases = new SQLiteLeaseStore(database.sqlite);
    accounts = new AccountAdminStore(database.sqlite);
    leases.addAccount({
      id: "account-1",
      alias: "Codex A",
      codexHome: "/private/accounts/account-1",
      status: "REAUTH_REQUIRED",
      authStatus: "UNAUTHENTICATED",
      maxActiveUsers: 4,
      weeklyRemaining: null,
      quotaUpdatedAt: null,
      allowUnknownQuota: false,
      healthScore: 100,
    });
  });

  afterEach(() => database.sqlite.close());

  test("returns safe admin summaries and keeps CODEX_HOME internal", () => {
    expect(accounts.list()).toEqual([
      expect.objectContaining({
        id: "account-1",
        alias: "Codex A",
        status: "REAUTH_REQUIRED",
        activeUsers: 0,
        maxActiveUsers: 4,
      }),
    ]);
    expect(JSON.stringify(accounts.list())).not.toContain("/private/accounts");
    expect(accounts.getInternal("account-1")).toMatchObject({
      codexHome: "/private/accounts/account-1",
    });
  });

  test("tracks authentication, exact weekly quota and account state", () => {
    accounts.markAuthenticated("account-1", NOW);
    accounts.updateWeeklyQuota("account-1", {
      remainingPercent: 73,
      resetsAt: new Date(NOW.getTime() + 86_400_000),
      observedAt: NOW,
    });
    accounts.setState("account-1", "DRAINING");

    expect(accounts.list()[0]).toMatchObject({
      status: "DRAINING",
      authStatus: "AUTHENTICATED",
      weeklyRemaining: 73,
      quotaUpdatedAt: NOW.toISOString(),
    });
  });

  test("changes an account state and writes its actor-attributed audit in one transaction", () => {
    accounts.setState("account-1", "DRAINING", { actorUserId: "admin-1", now: NOW });

    expect(accounts.list()[0]).toMatchObject({ status: "DRAINING" });
    expect(
      database.sqlite
        .prepare(
          `SELECT actor_user_id, account_id, account_alias, action, outcome, summary
           FROM audit_events`,
        )
        .all(),
    ).toEqual([
      {
        actor_user_id: "admin-1",
        account_id: "account-1",
        account_alias: "Codex A",
        action: "ACCOUNT_STATE_CHANGED",
        outcome: "SUCCESS",
        summary: "Codex account state changed: REAUTH_REQUIRED -> DRAINING",
      },
    ]);
  });

  test("records account lifecycle attempts without exposing account credentials", () => {
    accounts.recordLifecycleEvent({
      accountId: "account-1",
      actorUserId: "admin-1",
      action: "ACCOUNT_LOGIN_STARTED",
      outcome: "SUCCESS",
      summary: "Codex interactive login started",
      now: NOW,
    });

    expect(
      database.sqlite
        .prepare("SELECT account_alias, action, outcome, summary FROM audit_events")
        .get(),
    ).toEqual({
      account_alias: "Codex A",
      action: "ACCOUNT_LOGIN_STARTED",
      outcome: "SUCCESS",
      summary: "Codex interactive login started",
    });
    expect(
      JSON.stringify(database.sqlite.prepare("SELECT * FROM audit_events").get()),
    ).not.toContain("/private/accounts");
  });
});
