/**
 * A `Db` implementation backed by better-sqlite3.
 *
 * Used by the test suite so the API can be exercised against a real SQLite
 * engine in plain Node -- same SQL, same constraints, same behaviour as the
 * D1 binding, without needing a Workers runtime to run a unit test.
 *
 * Not imported by the Worker itself.
 */

import type { Db, DbResult, DbStatement } from './db';

interface BetterSqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
  reader: boolean;
}

interface BetterSqliteDatabase {
  prepare(sql: string): BetterSqliteStatement;
  exec(sql: string): unknown;
}

class SqliteStatement implements DbStatement {
  constructor(
    private readonly stmt: BetterSqliteStatement,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): DbStatement {
    return new SqliteStatement(this.stmt, values);
  }

  async first<T = unknown>(): Promise<T | null> {
    return (this.stmt.get(...this.params) as T | undefined) ?? null;
  }

  async all<T = unknown>(): Promise<DbResult<T>> {
    return { results: this.stmt.all(...this.params) as T[], success: true };
  }

  async run(): Promise<unknown> {
    return this.stmt.run(...this.params);
  }
}

export function sqliteDb(database: BetterSqliteDatabase): Db {
  return {
    prepare(query: string): DbStatement {
      return new SqliteStatement(database.prepare(query));
    },
    async batch(statements: DbStatement[]): Promise<unknown[]> {
      const out: unknown[] = [];
      for (const stmt of statements) out.push(await stmt.run());
      return out;
    },
    async exec(query: string): Promise<unknown> {
      return database.exec(query);
    },
  };
}
