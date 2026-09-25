/**
 * The local API server.
 *
 * Runs the same Hono app the Azure Function serves, over a local SQLite file
 * rather than Supabase. That keeps `npm run dev` instant and offline: no cloud
 * project, no connection string, no network round trip per query.
 *
 * The fidelity that costs is bought back in tests/postgres.test.ts, which runs
 * the whole API against real Postgres (PGlite) on every `npm test`. Local speed
 * and production fidelity each live where they belong.
 *
 * Point this at a real Postgres instead by setting DATABASE_URL -- useful for
 * checking against Supabase before a deploy. `npm run dev:api` loads
 * `.env.local` into this process (if the file exists), so a `DATABASE_URL=`
 * line there is enough. Vite reads the same file but only passes `VITE_*`
 * names to the browser, so the connection string never reaches the bundle.
 */

import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app } from './index';
import { sqliteDb } from './repo/sqlite';
import { postgresDb } from './repo/postgres';
import type { Env } from './context';
import type { Db } from './repo/db';

const PORT = Number(process.env['PORT'] ?? 8788);
const DB_FILE = process.env['SQLITE_FILE'] ?? '.data/dev.sqlite';
const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));

function pendingMigrations(applied: Set<string>): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => !applied.has(name))
    .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
}

function openSqlite(): { db: Db; label: string } {
  mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const raw = new Database(DB_FILE);
  raw.exec('PRAGMA foreign_keys = ON');

  // Same files, same order as production -- there is one schema definition.
  raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
  const applied = new Set(
    (raw.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  for (const { name, sql } of pendingMigrations(applied)) {
    raw.exec(sql);
    raw.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    console.log(`  applied ${name}`);
  }

  return { db: sqliteDb(raw), label: `SQLite · ${DB_FILE}` };
}

function openPostgres(connectionString: string): { db: Db; label: string } {
  const local = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  const pool = new Pool({
    connectionString,
    max: 4,
    ...(local ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  return { db: postgresDb(pool), label: 'Postgres · DATABASE_URL' };
}

const connectionString = process.env['DATABASE_URL'];
const { db, label } = connectionString ? openPostgres(connectionString) : openSqlite();

const env = { DB: db, ...process.env } as unknown as Env;

serve({ fetch: (request: Request) => app.fetch(request, env), port: PORT }, (info) => {
  console.log(`API on http://127.0.0.1:${info.port}  ·  ${label}`);
  if (!process.env['REMINDER_TOKEN']) {
    console.log('REMINDER_TOKEN unset, so /api/reminders/run is open locally.');
  }
});
