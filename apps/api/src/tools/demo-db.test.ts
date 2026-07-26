import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SafeDemoDatabase } from "./demo-db.js";

describe("SafeDemoDatabase", () => {
  let sqlite: Database.Database;
  let demo: SafeDemoDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE demo_orders (id TEXT PRIMARY KEY, status TEXT, amount INTEGER);
      CREATE TABLE private_secrets (id TEXT PRIMARY KEY, secret TEXT);
      INSERT INTO demo_orders VALUES ('order-1', 'PAID', 1200), ('order-2', 'PENDING', 500);
      INSERT INTO private_secrets VALUES ('secret-1', 'never-return');
    `);
    demo = new SafeDemoDatabase(sqlite, { allowedTables: ["demo_orders"], maxRows: 10 });
  });

  afterEach(() => sqlite.close());

  test("executes a single bounded SELECT against an allowlisted table", () => {
    expect(demo.query("SELECT id, status FROM demo_orders ORDER BY id")).toEqual({
      columns: ["id", "status"],
      rows: [
        { id: "order-1", status: "PAID" },
        { id: "order-2", status: "PENDING" },
      ],
      rowCount: 2,
      truncated: false,
    });
  });

  test.each([
    "UPDATE demo_orders SET status = 'PAID'",
    "DELETE FROM demo_orders",
    "DROP TABLE demo_orders",
    "SELECT * FROM demo_orders; SELECT * FROM demo_orders",
    "SELECT * FROM private_secrets",
    "SELECT * FROM demo_orders -- bypass",
    "PRAGMA table_info(demo_orders)",
  ])("rejects unsafe SQL: %s", (sql) => {
    expect(() => demo.query(sql)).toThrow();
  });

  test("rejects rather than silently truncating an oversized result", () => {
    const limited = new SafeDemoDatabase(sqlite, { allowedTables: ["demo_orders"], maxRows: 1 });
    expect(() => limited.query("SELECT * FROM demo_orders ORDER BY id")).toThrow(
      "Demo query exceeded the 1 row limit",
    );
  });
});
