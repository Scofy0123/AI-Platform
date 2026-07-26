import type Database from "better-sqlite3";

interface SafeDemoDatabaseOptions {
  allowedTables: string[];
  maxRows?: number;
  maxResultBytes?: number;
}

export interface DemoQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: false;
}

export class SafeDemoDatabase {
  private readonly allowedTables: Set<string>;
  private readonly maxRows: number;
  private readonly maxResultBytes: number;

  constructor(
    private readonly sqlite: Database.Database,
    options: SafeDemoDatabaseOptions,
  ) {
    this.allowedTables = new Set(options.allowedTables.map((table) => table.toLowerCase()));
    this.maxRows = options.maxRows ?? 100;
    this.maxResultBytes = options.maxResultBytes ?? 256 * 1024;
  }

  query(sql: string): DemoQueryResult {
    const statementSql = validateSql(sql, this.allowedTables);
    const boundedSql = `SELECT * FROM (${statementSql}) AS codexplatform_query LIMIT ${this.maxRows + 1}`;
    const statement = this.sqlite.prepare(boundedSql);
    if (!statement.reader || !statement.readonly) {
      throw new Error("Demo database accepts read-only SELECT statements only");
    }
    const rows = statement.all() as Array<Record<string, unknown>>;
    if (rows.length > this.maxRows) {
      throw new Error(`Demo query exceeded the ${this.maxRows} row limit`);
    }
    const serialized = JSON.stringify(rows);
    if (Buffer.byteLength(serialized, "utf8") > this.maxResultBytes) {
      throw new Error(`Demo query exceeded the ${this.maxResultBytes} byte result limit`);
    }
    return {
      columns: statement.columns().map((column) => column.name),
      rows,
      rowCount: rows.length,
      truncated: false,
    };
  }
}

function validateSql(sql: string, allowedTables: Set<string>): string {
  if (sql.length > 10_000) throw new Error("Demo SQL exceeds the 10,000 character limit");
  if (/--|\/\*|\*\//.test(sql)) throw new Error("SQL comments are not allowed");
  const trimmed = sql.trim();
  const withoutTrailingSemicolon = trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed;
  if (withoutTrailingSemicolon.includes(";"))
    throw new Error("Multiple SQL statements are not allowed");
  if (!/^select\b/i.test(withoutTrailingSemicolon)) {
    throw new Error("Demo database accepts SELECT statements only");
  }
  if (
    /\b(insert|update|delete|replace|create|alter|drop|attach|detach|pragma|vacuum|reindex)\b/i.test(
      withoutTrailingSemicolon,
    )
  ) {
    throw new Error("SQL contains a forbidden operation");
  }
  if (/\bsqlite_/i.test(withoutTrailingSemicolon)) {
    throw new Error("SQLite system objects are not allowed");
  }

  const referencedTables = [
    ...withoutTrailingSemicolon.matchAll(/\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi),
  ].map((match) => match[1]?.toLowerCase());
  if (
    referencedTables.length === 0 ||
    referencedTables.some((table) => !table || !allowedTables.has(table))
  ) {
    throw new Error("SQL references a table that is not allowlisted");
  }
  return withoutTrailingSemicolon;
}
