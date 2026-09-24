/**
 * Rebuild the local SQLite database from scratch and load the demo data.
 *
 * The production equivalent is `npm run migrate:pg` against Supabase, which
 * does NOT load the seed -- the demo rows are fictional and have no business
 * being in a real deployment.
 */

import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DB_FILE = process.env.SQLITE_FILE ?? '.data/dev.sqlite';
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const SEED = fileURLToPath(new URL('../seed/dev-seed.sql', import.meta.url));

mkdirSync(path.dirname(DB_FILE), { recursive: true });
for (const suffix of ['', '-shm', '-wal']) {
  rmSync(`${DB_FILE}${suffix}`, { force: true });
}

const db = new Database(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');

const files = readdirSync(MIGRATIONS)
  .filter((n) => n.endsWith('.sql'))
  .sort();

for (const name of files) {
  db.exec(readFileSync(path.join(MIGRATIONS, name), 'utf8'));
  db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
  console.log(`  applied ${name}`);
}

db.exec(readFileSync(SEED, 'utf8'));

const tools = db.prepare('SELECT COUNT(*) AS n FROM tools').get().n;
const payments = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
db.close();

console.log(`\n${DB_FILE} rebuilt — ${files.length} migration(s), ${tools} tools, ${payments} payments.`);
