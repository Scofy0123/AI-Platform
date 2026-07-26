import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema.js";

export interface PlatformDatabase {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
}

export function createDatabase(filename: string): PlatformDatabase {
  const sqlite = new Database(filename);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("journal_mode = WAL");

  return {
    sqlite,
    orm: drizzle(sqlite, { schema }),
  };
}
