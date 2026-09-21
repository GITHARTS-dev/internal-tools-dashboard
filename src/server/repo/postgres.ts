/**
 * A `Db` implementation backed by Postgres (Supabase).
 *
 * This is the adapter the narrow `Db` interface in db.ts exists for. The
 * repository layer above it is unchanged: same SQL, same call sites. Only two
 * things genuinely differ between SQLite/D1 and Postgres for the queries this
 * app issues, and both are handled here rather than at 40 call sites:
 *
 *   1. Placeholders. SQLite uses `?`; Postgres uses `$1, $2, ...` and cares
 *      about the order.
 *   2. `batch()`. D1 runs a statement list atomically; here that is a
 *      transaction on a single pooled connection.
 *
 * Everything else the app relies on -- `ON CONFLICT ... DO UPDATE SET
 * excluded.x`, `ON CONFLICT ... DO NOTHING`, `CHECK` constraints, foreign keys
 * with `ON DELETE SET NULL` -- is spelled identically in both engines, which is
 * why the migrations are shared rather than forked.
 *
 * Connection note: serverless functions must use Supabase's TRANSACTION POOLER
 * (port 6543), not a direct connection (5432). A function instance that opens
 * a direct connection per invocation exhausts Postgres' connection limit under
 * even light concurrency.
 */

import type { Db, DbResult, DbStatement } from './db';

/** The subset of `pg` this adapter needs, so the driver is not a hard import. */
export interface PgQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

export interface PgClient {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  release?(): void;
}

export interface PgPool {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

/**
 * Rewrite `?` placeholders to `$1, $2, ...`.
 *
 * Quoted text is skipped. A naive global replace would corrupt any literal
 * containing a question mark -- a tool named "What's next?" in a LIKE pattern,
 * say -- and would do it silently, producing a query that still runs but binds
 * the wrong values.
 */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let index = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;

    if (inSingle) {
      out += ch;
      // '' inside a single-quoted string is an escaped quote, not the end.
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += sql[++i];
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === '?') {
      out += `$${++index}`;
      continue;
    }
    out += ch;
  }

  return out;
}

/**
 * SQLite stores the booleans in this schema as 0/1 INTEGER and the repository
 * layer reads them back with `fromDbBool`. Postgres returns whatever the column
 * type is; the shared migrations declare these columns INTEGER, so the values
 * come back as numbers and `fromDbBool` keeps working unchanged.
 *
 * Postgres does return BIGINT and NUMERIC as strings, though, which would turn
 * a money total into string concatenation. The columns this app aggregates are
 * INTEGER, so that does not bite -- but COUNT(*) is BIGINT, and its callers
 * expect a number.
 */
function coerceRow(row: unknown): unknown {
  if (row === null || typeof row !== 'object') return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    // COUNT(*) and other BIGINT results arrive as strings from node-postgres.
    if (typeof value === 'string' && /^-?\d+$/.test(value) && (key === 'n' || key.endsWith('_count') || key === 'months')) {
      const asNumber = Number(value);
      out[key] = Number.isSafeInteger(asNumber) ? asNumber : value;
    } else if (typeof value === 'boolean') {
      // A genuine boolean column would break fromDbBool's 0/1 expectation.
      out[key] = value ? 1 : 0;
    } else {
      out[key] = value;
    }
  }
  return out;
}

class PgStatement implements DbStatement {
  constructor(
    private readonly runner: { query(text: string, values?: unknown[]): Promise<PgQueryResult> },
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): DbStatement {
    return new PgStatement(this.runner, this.sql, values);
  }

  /** The prepared text and values, for the transaction path in `batch`. */
  toQuery(): { text: string; values: unknown[] } {
    return { text: this.sql, values: this.params };
  }

  async first<T = unknown>(): Promise<T | null> {
    const result = await this.runner.query(this.sql, this.params);
    const row = result.rows[0];
    return row === undefined ? null : (coerceRow(row) as T);
  }

  async all<T = unknown>(): Promise<DbResult<T>> {
    const result = await this.runner.query(this.sql, this.params);
    return { results: result.rows.map(coerceRow) as T[], success: true };
  }

  async run(): Promise<unknown> {
    const result = await this.runner.query(this.sql, this.params);
    return { success: true, meta: { changes: result.rowCount ?? 0 } };
  }
}

export function postgresDb(pool: PgPool): Db {
  return {
    prepare(query: string): DbStatement {
      return new PgStatement(pool, toPgPlaceholders(query));
    },

    /**
     * All-or-nothing, on one connection.
     *
     * D1's batch is atomic, and the callers here depend on that: loading the
     * demo data deletes the old rows and inserts the new ones in a single
     * batch, so a failure halfway must not leave the table empty.
     */
    async batch(statements: DbStatement[]): Promise<unknown[]> {
      if (statements.length === 0) return [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out: unknown[] = [];
        for (const statement of statements) {
          const { text, values } = (statement as PgStatement).toQuery();
          const result = await client.query(text, values);
          out.push({ success: true, meta: { changes: result.rowCount ?? 0 } });
        }
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {
          // The original error is the one worth reporting.
        });
        throw error;
      } finally {
        client.release?.();
      }
    },

    async exec(query: string): Promise<unknown> {
      return pool.query(query);
    },
  };
}
