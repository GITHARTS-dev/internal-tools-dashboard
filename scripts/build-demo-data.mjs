/**
 * Snapshot the demo database into a JSON file the standalone demo build can
 * embed, so the browser-only version starts with exactly the same worked
 * example the real app seeds.
 *
 *   node scripts/build-demo-data.mjs > src/client/demo/data.json
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../seed/dev-seed.sql', import.meta.url), 'utf8'));

const snapshot = {
  tools: db.prepare('SELECT * FROM tools').all().map((t) => ({ ...t, auto_renew: t.auto_renew === 1 })),
  payments: db.prepare('SELECT * FROM payments').all(),
  audit: db.prepare('SELECT * FROM audit_log').all(),
  settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value])),
};

process.stdout.write(JSON.stringify(snapshot));
