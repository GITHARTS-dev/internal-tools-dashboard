import { buildUpdate, fromDbBool, nowIso, toDbBool, uuid, type Db } from './db';
import type { Tool, ToolStatus } from '../../shared/types';
import type { ToolCreateInput, ToolUpdateInput } from '../../shared/schema';

/** Columns a caller may write. `id`, `created_at` and `updated_at` are ours. */
const WRITABLE = [
  'name', 'vendor', 'category', 'status', 'owner_name', 'owner_email', 'department',
  'billing_cycle', 'cost_amount', 'currency', 'seats_purchased', 'seats_used',
  'renewal_date', 'auto_renew', 'cancellation_notice_days', 'account_ref',
  'billing_email', 'payment_method', 'vendor_url', 'notes', 'started_on', 'cancelled_on',
  'internal_product_id',
] as const;

type ToolRow = Record<string, unknown>;

function mapTool(row: ToolRow): Tool {
  return { ...row, auto_renew: fromDbBool(row['auto_renew']) } as Tool;
}

export interface ToolFilters {
  status?: ToolStatus[];
  category?: string;
  owner?: string;
  search?: string;
  /** Default false: cancelled and expired tools live on the History screen. */
  includeArchived?: boolean;
  /** Tools attributed to one internal product; 'none' means unattributed. */
  internalProductId?: string;
  /** Default false: a trashed tool is excluded from every ordinary list. Only the Trash screen sets this. */
  includeDeleted?: boolean;
}

export async function listTools(db: Db, filters: ToolFilters = {}): Promise<Tool[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!filters.includeDeleted) {
    where.push('deleted_at IS NULL');
  }
  if (filters.status && filters.status.length > 0) {
    where.push(`status IN (${filters.status.map(() => '?').join(', ')})`);
    params.push(...filters.status);
  } else if (!filters.includeArchived) {
    where.push(`status IN ('active', 'trial')`);
  }
  if (filters.category) {
    where.push('category = ?');
    params.push(filters.category);
  }
  if (filters.owner) {
    where.push('(owner_email = ? OR owner_name = ?)');
    params.push(filters.owner, filters.owner);
  }
  if (filters.internalProductId === 'none') {
    where.push('internal_product_id IS NULL');
  } else if (filters.internalProductId) {
    where.push('internal_product_id = ?');
    params.push(filters.internalProductId);
  }
  if (filters.search) {
    const like = `%${filters.search.toLowerCase()}%`;
    where.push(
      '(lower(name) LIKE ? OR lower(coalesce(vendor, \'\')) LIKE ? OR lower(coalesce(owner_name, \'\')) LIKE ? OR lower(coalesce(notes, \'\')) LIKE ?)',
    );
    params.push(like, like, like, like);
  }

  const sql = `SELECT * FROM tools ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY LOWER(name)`;
  const { results } = await db.prepare(sql).bind(...params).all<ToolRow>();
  return results.map(mapTool);
}

/** Every tool regardless of status -- what the alert engine and exports need. */
export async function listAllTools(db: Db): Promise<Tool[]> {
  return listTools(db, { includeArchived: true });
}

export async function getTool(db: Db, id: string): Promise<Tool | null> {
  const row = await db.prepare('SELECT * FROM tools WHERE id = ?').bind(id).first<ToolRow>();
  return row ? mapTool(row) : null;
}

export async function createTool(db: Db, input: ToolCreateInput): Promise<Tool> {
  const id = uuid();
  const ts = nowIso();
  const values = WRITABLE.map((col) => {
    const value = (input as Record<string, unknown>)[col];
    return col === 'auto_renew' ? toDbBool(value as boolean) : (value ?? null);
  });

  await db
    .prepare(
      `INSERT INTO tools (id, ${WRITABLE.join(', ')}, created_at, updated_at)
       VALUES (?, ${WRITABLE.map(() => '?').join(', ')}, ?, ?)`,
    )
    .bind(id, ...values, ts, ts)
    .run();

  const created = await getTool(db, id);
  if (!created) throw new Error('Tool vanished immediately after insert');
  return created;
}

export async function updateTool(db: Db, id: string, patch: ToolUpdateInput): Promise<Tool | null> {
  const normalised: Record<string, unknown> = { ...patch };
  if ('auto_renew' in normalised) normalised['auto_renew'] = toDbBool(normalised['auto_renew'] as boolean);

  const update = buildUpdate(normalised, WRITABLE);
  if (update) {
    await db
      .prepare(`UPDATE tools SET ${update.clause}, updated_at = ? WHERE id = ?`)
      .bind(...update.values, nowIso(), id)
      .run();
  }
  return getTool(db, id);
}

/**
 * Archiving, not deleting.
 *
 * The whole point of this system is that past tools stay answerable, so a tool
 * leaving the company's stack becomes `cancelled` with a date. Its payment
 * history and audit trail are untouched.
 */
export async function archiveTool(db: Db, id: string, cancelledOn: string): Promise<Tool | null> {
  await db
    .prepare(`UPDATE tools SET status = 'cancelled', cancelled_on = ?, updated_at = ? WHERE id = ?`)
    .bind(cancelledOn, nowIso(), id)
    .run();
  return getTool(db, id);
}

export async function restoreTool(db: Db, id: string): Promise<Tool | null> {
  await db
    .prepare(`UPDATE tools SET status = 'active', cancelled_on = NULL, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), id)
    .run();
  return getTool(db, id);
}

/**
 * Trash a tool: it drops out of every ordinary list immediately, but the row
 * and its payments are untouched, so it is one call away from coming back.
 */
export async function trashTool(db: Db, id: string, deletedBy: string): Promise<Tool | null> {
  await db
    .prepare('UPDATE tools SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?')
    .bind(nowIso(), deletedBy, nowIso(), id)
    .run();
  return getTool(db, id);
}

export async function untrashTool(db: Db, id: string): Promise<Tool | null> {
  await db
    .prepare('UPDATE tools SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?')
    .bind(nowIso(), id)
    .run();
  return getTool(db, id);
}

export async function listTrash(db: Db): Promise<Tool[]> {
  const { results } = await db
    .prepare('SELECT * FROM tools WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all<ToolRow>();
  return results.map(mapTool);
}

/**
 * Hard delete, for a trashed row whose retention window has passed, or for
 * someone who wants a specific row gone right now rather than waiting for it.
 * Not reachable from the ordinary tool routes -- only from the trash it sat in.
 */
export async function purgeTool(db: Db, id: string): Promise<void> {
  await db.prepare('DELETE FROM tools WHERE id = ? AND deleted_at IS NOT NULL').bind(id).run();
}

/** How long a deleted tool sits in the trash before it is purged for real. */
export const TRASH_RETENTION_DAYS = 30;

/** Empties out anything that has sat in the trash longer than the retention window. */
export async function purgeOldTrash(db: Db, olderThanDays: number = TRASH_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  // `run()`'s return shape is not standard across engines, so the count comes
  // from counting the rows first rather than trusting what the DELETE reports.
  const { results } = await db
    .prepare('SELECT id FROM tools WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .bind(cutoff)
    .all<{ id: string }>();
  if (results.length === 0) return 0;
  await db
    .prepare('DELETE FROM tools WHERE deleted_at IS NOT NULL AND deleted_at < ?')
    .bind(cutoff)
    .run();
  return results.length;
}

/*
 * Both of these sort case-insensitively over a DISTINCT set, which Postgres
 * will not do directly: under SELECT DISTINCT it requires every ORDER BY
 * expression to appear in the select list, so `ORDER BY LOWER(category)` is an
 * error there while being perfectly happy in SQLite. Doing the DISTINCT in a
 * subquery and sorting outside it is valid in both.
 */

export async function distinctCategories(db: Db): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT category FROM (SELECT DISTINCT category FROM tools) t
       ORDER BY LOWER(category)`,
    )
    .all<{ category: string }>();
  return results.map((r) => r.category).filter(Boolean);
}

export async function distinctOwners(db: Db): Promise<Array<{ name: string | null; email: string | null }>> {
  const { results } = await db
    .prepare(
      `SELECT name, email FROM (
         SELECT DISTINCT owner_name AS name, owner_email AS email FROM tools
         WHERE owner_name IS NOT NULL OR owner_email IS NOT NULL
       ) t
       ORDER BY LOWER(name)`,
    )
    .all<{ name: string | null; email: string | null }>();
  return results;
}
