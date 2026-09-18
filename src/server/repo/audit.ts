import { nowIso, uuid, type Db } from './db';
import type { AuditEntry } from '../../shared/types';

/**
 * The audit trail.
 *
 * Every mutation writes one row here, so "who changed Canva's renewal date,
 * and when" always has an answer. Together with the payments ledger this is
 * the historical record the dashboard exists to provide.
 */

export type AuditAction = 'create' | 'update' | 'archive' | 'delete' | 'restore';

/** Fields that are noise in a history view, or ours rather than the user's. */
const IGNORED_IN_DIFF = new Set(['updated_at', 'created_at', 'id']);

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/** What actually changed between two versions of a record. */
export function diffRecords(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldChange[] {
  if (!before || !after) return [];
  const changes: FieldChange[] = [];
  for (const key of Object.keys(after)) {
    if (IGNORED_IN_DIFF.has(key)) continue;
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (from !== to) changes.push({ field: key, from, to });
  }
  return changes;
}

export async function recordAudit(
  db: Db,
  entry: {
    entity: string;
    entity_id: string;
    action: AuditAction;
    actor?: string;
    summary?: string | null;
    changes?: FieldChange[] | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, entity, entity_id, action, actor, summary, diff_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuid(),
      entry.entity,
      entry.entity_id,
      entry.action,
      entry.actor ?? 'system',
      entry.summary ?? null,
      entry.changes && entry.changes.length > 0 ? JSON.stringify(entry.changes) : null,
      nowIso(),
    )
    .run();
}

export async function listAuditForEntity(
  db: Db,
  entity: string,
  entityId: string,
  limit = 100,
): Promise<AuditEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM audit_log WHERE entity = ? AND entity_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(entity, entityId, limit)
    .all<AuditEntry>();
  return results;
}

export async function listRecentAudit(db: Db, limit = 50): Promise<AuditEntry[]> {
  const { results } = await db
    .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<AuditEntry>();
  return results;
}
