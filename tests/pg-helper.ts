import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { postgresDb, type PgClient, type PgPool, type PgQueryResult } from '../src/server/repo/postgres';
import { migrationFiles, MIGRATIONS_DIR } from './db-helper';
import type { Db } from '../src/server/repo/db';

/**
 * A real Postgres, in-process.
 *
 * PGlite is Postgres compiled to WASM, so this is the actual engine and the
 * actual parser -- not a Postgres-flavoured mock. That matters because the
 * dialect differences worth catching are the ones that parse fine in SQLite and
 * are rejected by Postgres (SELECT DISTINCT with an ORDER BY expression outside
 * the select list being the one that already bit us).
 *
 * Running the same suite against both engines is what keeps the shared
 * migrations and the shared repository SQL honest.
 */

/** Adapts PGlite's query surface to the small `PgPool` the adapter expects. */
function pglitePool(pg: PGlite): PgPool {
  const run = async (text: string, values?: unknown[]): Promise<PgQueryResult> => {
    const result = await pg.query(text, values as never[]);
    return { rows: result.rows as unknown[], rowCount: result.affectedRows ?? result.rows.length };
  };

  // PGlite is a single connection, so a "client" is the same thing. That is
  // fine for the transaction in `batch`: BEGIN/COMMIT work as normal.
  const client: PgClient = { query: run, release: () => {} };

  return {
    query: run,
    connect: async () => client,
    end: () => pg.close(),
  };
}

export interface PgTestDb {
  db: Db;
  pg: PGlite;
  close(): Promise<void>;
}

export async function testPgDb(): Promise<PgTestDb> {
  const pg = new PGlite();
  await pg.waitReady;

  for (const file of migrationFiles()) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    await pg.exec(sql);
  }

  return {
    db: postgresDb(pglitePool(pg)),
    pg,
    close: () => pg.close(),
  };
}
