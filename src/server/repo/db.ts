/**
 * The database boundary.
 *
 * `Db` is a structural subset of Cloudflare's D1 API -- narrow enough that a
 * real D1 binding satisfies it as-is, and small enough that anything else can
 * implement it in a few dozen lines. Nothing outside src/server/repo/ is
 * allowed to touch it.
 *
 * That is what keeps the hosting decision reversible: moving this data to
 * Postgres, or back to plain files on a machine in the office, means writing
 * one adapter, not rewriting the application.
 */

export interface DbResult<T> {
  results: T[];
  success: boolean;
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<DbResult<T>>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(query: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown[]>;
  exec?(query: string): Promise<unknown>;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** SQLite has no boolean type; 0/1 in, true/false out. */
export function toDbBool(value: boolean | null | undefined): number {
  return value ? 1 : 0;
}

export function fromDbBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

/**
 * Build the SET clause of an UPDATE from a partial patch, skipping keys the
 * caller did not supply. Returns null when there is nothing to change, so
 * callers can avoid issuing an empty UPDATE.
 */
export function buildUpdate(
  patch: Record<string, unknown>,
  allowed: readonly string[],
): { clause: string; values: unknown[] } | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const key of allowed) {
    if (!(key in patch) || patch[key] === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(patch[key] ?? null);
  }
  if (sets.length === 0) return null;
  return { clause: sets.join(', '), values };
}
