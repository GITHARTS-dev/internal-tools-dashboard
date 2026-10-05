/**
 * Price changes: recording one, and making everything else agree with it.
 *
 * Three things follow from a change, always together:
 *   - it is stored, with the price it replaced;
 *   - the tool's cost becomes the price in effect today, which is what the
 *     dashboard's run-rate reads (so a change starting next month leaves today's
 *     cost alone until the daily job reaches that date);
 *   - unpaid payments due on or after the start date are repriced to the price
 *     in effect on their own due date. Paid payments are never touched.
 */

import { addDays } from '../shared/dates';
import { formatDate } from '../shared/dates';
import { formatMoney } from '../shared/money';
import { priceOn } from '../shared/prices';
import type { IsoDate, Payment, PriceChange, Tool } from '../shared/types';
import type { Db } from './repo/db';
import { recordAudit } from './repo/audit';
import { listPayments, updatePayment } from './repo/payments';
import { listPriceChanges, savePriceChange } from './repo/priceChanges';
import { getTool, updateTool } from './repo/tools';

export interface PriceChangeRequest {
  amount: number;
  currency: string;
  effective_from: IsoDate;
  note: string | null;
}

export interface PriceChangeResult {
  change: PriceChange;
  tool: Tool;
  repriced: Payment[];
}

/**
 * `tool` is the tool as it was before this change -- the price it replaces is
 * read from it when there is no earlier recorded change.
 */
export async function recordPriceChange(
  db: Db,
  tool: Tool,
  request: PriceChangeRequest,
  actor: string,
  today: IsoDate,
  options: { auditTool?: boolean } = {},
): Promise<PriceChangeResult> {
  const before = await listPriceChanges(db, tool.id);
  const previous = priceOn(tool, before, addDays(request.effective_from, -1));

  const change = await savePriceChange(db, {
    tool_id: tool.id,
    effective_from: request.effective_from,
    amount: request.amount,
    currency: request.currency,
    previous_amount: previous?.amount ?? null,
    previous_currency: previous?.currency ?? null,
    note: request.note,
    changed_by: actor,
  });

  const changes = await listPriceChanges(db, tool.id);
  const updated = (await syncCurrentPrice(db, tool.id, changes, today, actor)) ?? tool;
  const repriced = await repriceUnpaid(db, updated, changes, request.effective_from, actor);

  if (options.auditTool !== false) {
    const was = previous ? ` (was ${formatMoney(previous.amount, previous.currency)})` : '';
    await recordAudit(db, {
      entity: 'tool',
      entity_id: tool.id,
      action: 'update',
      actor,
      summary:
        `Price changes to ${formatMoney(request.amount, request.currency)} from ${formatDate(request.effective_from)}${was}` +
        (repriced.length > 0 ? `; ${repriced.length} unpaid payment${repriced.length === 1 ? '' : 's'} repriced` : ''),
    });
  }
  return { change, tool: updated, repriced };
}

/**
 * Make the tool's cost the price in effect today. Returns the tool, updated or
 * not; null only if it no longer exists. The daily job calls this too, which is
 * how a change dated next month takes effect when that month arrives.
 */
export async function syncCurrentPrice(
  db: Db,
  toolId: string,
  changes: PriceChange[],
  today: IsoDate,
  actor: string,
): Promise<Tool | null> {
  const tool = await getTool(db, toolId);
  if (!tool || changes.length === 0) return tool;

  const current = priceOn(tool, changes, today);
  if (!current || (current.amount === tool.cost_amount && current.currency === tool.currency)) return tool;

  const updated = await updateTool(db, toolId, { cost_amount: current.amount, currency: current.currency });
  await recordAudit(db, {
    entity: 'tool',
    entity_id: toolId,
    action: 'update',
    actor,
    summary: `Price is now ${formatMoney(current.amount, current.currency)}`,
    changes: [
      { field: 'cost_amount', from: tool.cost_amount, to: current.amount },
      ...(tool.currency !== current.currency ? [{ field: 'currency', from: tool.currency, to: current.currency }] : []),
    ],
  });
  return updated;
}

/** Reprice every unpaid payment due on or after `from` to the price on its due date. */
async function repriceUnpaid(
  db: Db,
  tool: Tool,
  changes: PriceChange[],
  from: IsoDate,
  actor: string,
): Promise<Payment[]> {
  const unpaid = await listPayments(db, { toolId: tool.id, status: ['due'], dueFrom: from });
  const repriced: Payment[] = [];

  for (const payment of unpaid) {
    const price = priceOn(tool, changes, payment.due_date);
    if (!price || (price.amount === payment.amount && price.currency === payment.currency)) continue;

    const updated = await updatePayment(db, payment.id, { amount: price.amount, currency: price.currency });
    if (updated) repriced.push(updated);
    await recordAudit(db, {
      entity: 'payment',
      entity_id: payment.id,
      action: 'update',
      actor,
      summary: `Repriced with ${tool.name}'s new price`,
      changes: [
        { field: 'amount', from: payment.amount, to: price.amount },
        ...(payment.currency !== price.currency ? [{ field: 'currency', from: payment.currency, to: price.currency }] : []),
      ],
    });
  }
  return repriced;
}
