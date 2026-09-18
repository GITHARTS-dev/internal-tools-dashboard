import { nowIso, uuid, type Db } from './db';
import type { NotificationEntry } from '../../shared/types';

/**
 * The record of what has actually been sent.
 *
 * `dedupe_key` is UNIQUE in the schema, and that constraint is the only thing
 * standing between a well-meaning daily cron and sixty identical emails about
 * the same renewal. Reads here are cheap; correctness here is not optional.
 */

export async function alreadySentKeys(db: Db, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();

  // Chunked so a large portfolio cannot blow past SQLite's variable limit.
  const found = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const { results } = await db
      .prepare(
        `SELECT dedupe_key FROM notification_log WHERE dedupe_key IN (${chunk.map(() => '?').join(', ')})`,
      )
      .bind(...chunk)
      .all<{ dedupe_key: string }>();
    for (const row of results) found.add(row.dedupe_key);
  }
  return found;
}

export async function recordNotification(
  db: Db,
  entry: {
    dedupe_key: string;
    tool_id?: string | null;
    payment_id?: string | null;
    rule: string;
    channel: string;
    target?: string | null;
    severity?: string | null;
    status?: 'sent' | 'failed' | 'skipped';
    detail?: string | null;
  },
): Promise<void> {
  // A duplicate key means another run already sent this; that is success, not
  // an error, so the insert is allowed to no-op.
  await db
    .prepare(
      `INSERT INTO notification_log
         (id, dedupe_key, tool_id, payment_id, rule, channel, target, severity, status, detail, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .bind(
      uuid(),
      entry.dedupe_key,
      entry.tool_id ?? null,
      entry.payment_id ?? null,
      entry.rule,
      entry.channel,
      entry.target ?? null,
      entry.severity ?? null,
      entry.status ?? 'sent',
      entry.detail ?? null,
      nowIso(),
    )
    .run();
}

export async function listNotifications(db: Db, limit = 100): Promise<NotificationEntry[]> {
  const { results } = await db
    .prepare('SELECT * FROM notification_log ORDER BY sent_at DESC LIMIT ?')
    .bind(limit)
    .all<NotificationEntry>();
  return results;
}
