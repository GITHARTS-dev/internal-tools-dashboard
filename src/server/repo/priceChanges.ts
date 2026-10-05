import { nowIso, uuid, type Db } from './db';
import type { PriceChange } from '../../shared/types';

/** Every recorded change, or one tool's, oldest first. */
export async function listPriceChanges(db: Db, toolId?: string): Promise<PriceChange[]> {
  const sql = toolId
    ? 'SELECT * FROM tool_price_changes WHERE tool_id = ? ORDER BY effective_from'
    : 'SELECT * FROM tool_price_changes ORDER BY tool_id, effective_from';
  const stmt = db.prepare(sql);
  const { results } = await (toolId ? stmt.bind(toolId) : stmt).all<PriceChange>();
  return results;
}

/**
 * Record a change. The same tool and start date again replaces the earlier
 * entry -- a correction, not a second change on the same day.
 */
export async function savePriceChange(
  db: Db,
  input: Omit<PriceChange, 'id' | 'created_at'>,
): Promise<PriceChange> {
  await db
    .prepare(
      `INSERT INTO tool_price_changes
         (id, tool_id, effective_from, amount, currency, previous_amount, previous_currency, note, changed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tool_id, effective_from) DO UPDATE SET
         amount = excluded.amount, currency = excluded.currency, note = excluded.note,
         changed_by = excluded.changed_by, created_at = excluded.created_at`,
    )
    .bind(
      uuid(),
      input.tool_id,
      input.effective_from,
      input.amount,
      input.currency,
      input.previous_amount,
      input.previous_currency,
      input.note,
      input.changed_by,
      nowIso(),
    )
    .run();

  const saved = await db
    .prepare('SELECT * FROM tool_price_changes WHERE tool_id = ? AND effective_from = ?')
    .bind(input.tool_id, input.effective_from)
    .first<PriceChange>();
  if (!saved) throw new Error('Price change vanished immediately after insert');
  return saved;
}
