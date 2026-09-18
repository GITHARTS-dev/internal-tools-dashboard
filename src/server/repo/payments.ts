import { buildUpdate, nowIso, uuid, type Db } from './db';
import type { Payment, PaymentStatus } from '../../shared/types';
import type { PaymentCreateInput, PaymentUpdateInput } from '../../shared/schema';

const WRITABLE = [
  'period_start', 'period_end', 'due_date', 'amount', 'currency', 'status',
  'paid_on', 'paid_by', 'invoice_ref', 'invoice_url', 'notes',
] as const;

export interface PaymentFilters {
  toolId?: string;
  status?: PaymentStatus[];
  dueFrom?: string;
  dueTo?: string;
}

export async function listPayments(db: Db, filters: PaymentFilters = {}): Promise<Payment[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.toolId) {
    where.push('tool_id = ?');
    params.push(filters.toolId);
  }
  if (filters.status && filters.status.length > 0) {
    where.push(`status IN (${filters.status.map(() => '?').join(', ')})`);
    params.push(...filters.status);
  }
  if (filters.dueFrom) {
    where.push('due_date >= ?');
    params.push(filters.dueFrom);
  }
  if (filters.dueTo) {
    where.push('due_date <= ?');
    params.push(filters.dueTo);
  }

  const sql = `SELECT * FROM payments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY due_date DESC`;
  const { results } = await db.prepare(sql).bind(...params).all<Payment>();
  return results;
}

export async function getPayment(db: Db, id: string): Promise<Payment | null> {
  return db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<Payment>();
}

export async function createPayment(db: Db, input: PaymentCreateInput): Promise<Payment> {
  const id = uuid();
  const ts = nowIso();
  const values = WRITABLE.map((col) => (input as Record<string, unknown>)[col] ?? null);

  await db
    .prepare(
      `INSERT INTO payments (id, tool_id, ${WRITABLE.join(', ')}, created_at, updated_at)
       VALUES (?, ?, ${WRITABLE.map(() => '?').join(', ')}, ?, ?)`,
    )
    .bind(id, input.tool_id, ...values, ts, ts)
    .run();

  const created = await getPayment(db, id);
  if (!created) throw new Error('Payment vanished immediately after insert');
  return created;
}

export async function updatePayment(db: Db, id: string, patch: PaymentUpdateInput): Promise<Payment | null> {
  const update = buildUpdate(patch as Record<string, unknown>, WRITABLE);
  if (update) {
    await db
      .prepare(`UPDATE payments SET ${update.clause}, updated_at = ? WHERE id = ?`)
      .bind(...update.values, nowIso(), id)
      .run();
  }
  return getPayment(db, id);
}

export async function markPaid(
  db: Db,
  id: string,
  opts: { paid_on: string; paid_by?: string | null; invoice_ref?: string | null },
): Promise<Payment | null> {
  await db
    .prepare(
      `UPDATE payments
       SET status = 'paid', paid_on = ?, paid_by = COALESCE(?, paid_by),
           invoice_ref = COALESCE(?, invoice_ref), updated_at = ?
       WHERE id = ?`,
    )
    .bind(opts.paid_on, opts.paid_by ?? null, opts.invoice_ref ?? null, nowIso(), id)
    .run();
  return getPayment(db, id);
}

export async function deletePayment(db: Db, id: string): Promise<void> {
  await db.prepare('DELETE FROM payments WHERE id = ?').bind(id).run();
}

/** Total actually paid per tool, for the lifetime-spend column on History. */
export async function paidTotalsByTool(db: Db): Promise<Map<string, { amount: number; currency: string }>> {
  const { results } = await db
    .prepare(
      `SELECT tool_id, currency, SUM(amount) AS amount FROM payments
       WHERE status = 'paid' GROUP BY tool_id, currency`,
    )
    .all<{ tool_id: string; currency: string; amount: number }>();

  const out = new Map<string, { amount: number; currency: string }>();
  for (const row of results) {
    // Tools rarely change currency; if one did, the larger total wins the row.
    const existing = out.get(row.tool_id);
    if (!existing || row.amount > existing.amount) {
      out.set(row.tool_id, { amount: row.amount, currency: row.currency });
    }
  }
  return out;
}
