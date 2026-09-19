/**
 * Loading and removing the demo dataset.
 *
 * The demo rows come from seed/dev-seed.sql, the same file `npm run seed:local`
 * applies, so there is one definition of the worked example. Every demo row
 * has an id starting `seed-`, which is what lets "remove demo data" take out
 * exactly those rows and leave anything a person entered themselves alone.
 */

import seedSql from '../../../seed/dev-seed.sql';
import type { DataStatus } from '../../shared/types';
import type { Db } from './db';

export const DEMO_ID_PREFIX = 'seed-';
const DEMO_LIKE = `${DEMO_ID_PREFIX}%`;

/**
 * One INSERT per line is how the generator writes the file, so the inserts can
 * be lifted out without a SQL parser. The DELETEs at the top are skipped on
 * purpose: they would wipe the user's own rows, and removal is handled here.
 */
function seedInserts(): string[] {
  return seedSql.split('\n').filter((line) => line.startsWith('INSERT INTO '));
}

async function count(db: Db, sql: string, ...params: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function dataStatus(db: Db): Promise<DataStatus> {
  const tools = await count(db, 'SELECT COUNT(*) AS n FROM tools');
  const demo = await count(db, 'SELECT COUNT(*) AS n FROM tools WHERE id LIKE ?', DEMO_LIKE);
  const payments = await count(db, 'SELECT COUNT(*) AS n FROM payments');
  return { tools, payments, demo_tools: demo, own_tools: tools - demo };
}

/** Removes every demo row. Children go first so this works with or without cascades. */
function demoDeletes(db: Db) {
  return [
    db.prepare('DELETE FROM notification_log WHERE tool_id LIKE ? OR payment_id LIKE ?').bind(DEMO_LIKE, DEMO_LIKE),
    db.prepare('DELETE FROM documents WHERE tool_id LIKE ?').bind(DEMO_LIKE),
    db.prepare('DELETE FROM payments WHERE tool_id LIKE ?').bind(DEMO_LIKE),
    db.prepare('DELETE FROM tools WHERE id LIKE ?').bind(DEMO_LIKE),
    db.prepare('DELETE FROM audit_log WHERE id LIKE ? OR entity_id LIKE ?').bind(DEMO_LIKE, DEMO_LIKE),
  ];
}

export async function removeDemoData(db: Db): Promise<void> {
  await db.batch(demoDeletes(db));
}

/** Replaces any earlier copy of the demo data, so pressing it twice never duplicates. */
export async function loadDemoData(db: Db): Promise<void> {
  const inserts = seedInserts().map((sql) => db.prepare(sql));
  await db.batch([...demoDeletes(db), ...inserts]);
}

/** Everything the app stores about tools. Settings are kept: they are configuration, not data. */
export async function clearAllData(db: Db): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM notification_log'),
    db.prepare('DELETE FROM documents'),
    db.prepare('DELETE FROM payments'),
    db.prepare('DELETE FROM tools'),
    db.prepare('DELETE FROM audit_log'),
  ]);
}
