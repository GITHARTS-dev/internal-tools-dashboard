/**
 * Apply the migrations to Supabase.
 *
 * The same files the SQLite tests apply, in the same order -- there is one
 * schema definition, not a SQLite one and a Postgres one. Everything in them
 * is spelled identically in both engines, and tests/postgres.test.ts runs
 * against real Postgres to keep it that way.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npm run migrate:pg
 *   DATABASE_URL="postgresql://..." npm run migrate:pg -- --dry-run
 *
 * Use the DIRECT connection (port 5432) here, not the transaction pooler
 * (6543). The pooler does not hold a session across statements, which is
 * exactly what a migration transaction needs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const dryRun = process.argv.includes('--dry-run');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    'DATABASE_URL is not set.\n\n' +
      'Supabase → Project Settings → Database → Connection string → URI.\n' +
      'Use the DIRECT connection on port 5432 for migrations, not the pooler.',
  );
  process.exit(1);
}

if (/:6543\//.test(connectionString)) {
  console.error(
    'That looks like the transaction pooler (port 6543).\n' +
      'Migrations need the direct connection on port 5432; the pooler does not\n' +
      'keep a session across statements, so the migration transaction breaks.',
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const pending = files.filter((name) => !applied.has(name));

  if (pending.length === 0) {
    console.log(`Up to date — ${files.length} migration(s) already applied.`);
    process.exit(0);
  }

  console.log(`${pending.length} migration(s) to apply:\n${pending.map((p) => `  ${p}`).join('\n')}`);
  if (dryRun) {
    console.log('\n--dry-run: nothing was written.');
    process.exit(0);
  }

  for (const name of pending) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    process.stdout.write(`  applying ${name} ... `);

    // Each migration is one transaction, so a failure halfway leaves the
    // schema as it was rather than half-migrated.
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (error) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw error;
    }
  }

  console.log('\nDone.');
} finally {
  await client.end();
}
