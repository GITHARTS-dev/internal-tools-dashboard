/**
 * What this calendar year is committed to: what has been paid, plus the
 * subscription bills still to come before 31 December.
 *
 * Three parts, every one a known amount on a known date:
 *
 *   paid       payments marked paid and cloud bills entered this year.
 *   overdue    payments in the ledger whose due date has passed, not yet paid.
 *   to come    bills due between today and 31 December: the ones already in
 *              the ledger, and each live subscription's further bills on its
 *              real billing dates at the price in effect on each date -- the
 *              same rule the scheduler uses to add them. A tool renewing yearly
 *              in November counts once, in full; one that renewed in February
 *              counts nothing more.
 *
 * Cloud usage still to be billed is deliberately NOT here. It moves with use,
 * month to month, and an average times the months left was a guess presented
 * beside facts. It joins the total as each month's bill is entered.
 *
 * Nothing is guessed for subscriptions either: a live tool with no renewal date
 * cannot be placed in the year, so it is listed as undated instead.
 */

import { sumConverted, type RateTable, type YearMonth } from './fx';
import { addMonths, cycleMonths, type IsoDate } from './dates';
import { effectiveRenewalDate } from './alerts';
import { priceOn } from './prices';
import type { InternalProduct, Payment, PriceChange, SpendItem, Tool, YearForecast, YearForecastLine } from './types';

/** Tools in these states are still being paid for -- the scheduler's own rule. */
const BILLED_STATUSES = new Set(['active', 'trial']);

export interface YearForecastInput {
  /** Tools that exist: a tool in the Trash, and its bills, count for nothing. */
  tools: Tool[];
  payments: Payment[];
  priceChanges: PriceChange[];
  products: InternalProduct[];
  paidItems: SpendItem[];
  tables: Record<YearMonth, RateTable>;
  target: string;
  today: IsoDate;
}

export function computeYearForecast(input: YearForecastInput): YearForecast {
  const { tools, payments, priceChanges, products, paidItems, tables, target, today } = input;
  const year = today.slice(0, 4);
  const yearEnd = `${year}-12-31`;
  const firstMonth = `${year}-01`;
  const lastMonth = `${year}-12`;
  const toolsById = new Map(tools.map((t) => [t.id, t]));
  // A tool pointing at a product that no longer exists is a bought
  // subscription, as everywhere else in the summary.
  const productIds = new Set(products.map((p) => p.id));
  const productOf = (tool: Tool): string | null =>
    tool.internal_product_id && productIds.has(tool.internal_product_id) ? tool.internal_product_id : null;

  let unconverted = 0;
  const convert = (amount: number, currency: string, month: YearMonth): number | null => {
    const result = sumConverted([{ amount, currency, month }], target, tables);
    if (result.gaps.length > 0) {
      unconverted += 1;
      return null;
    }
    return result.amount;
  };

  // ------------------------------------------------------------------ paid
  let paid = 0;
  for (const item of paidItems) {
    if (item.month < firstMonth || item.month > lastMonth) continue;
    if (item.amount_reported === null) unconverted += 1;
    else paid += item.amount_reported;
  }

  const lines: YearForecastLine[] = [];

  // --------------------------------------------- in the ledger, not paid
  for (const payment of payments) {
    if (payment.status !== 'due') continue;
    if (payment.due_date.slice(0, 4) !== year) continue;
    const tool = toolsById.get(payment.tool_id);
    if (!tool) continue; // in the Trash: it will not be paid
    const month = payment.due_date.slice(0, 7);
    lines.push({
      id: payment.id,
      kind: payment.due_date < today ? 'overdue' : 'scheduled',
      date: payment.due_date,
      month,
      label: tool.name,
      detail: tool.vendor,
      tool_id: tool.id,
      product_id: productOf(tool),
      amount: payment.amount,
      currency: payment.currency.toUpperCase(),
      amount_reported: convert(payment.amount, payment.currency, month),
    });
  }

  // ------------------------------------------- not in the ledger yet
  // A month the ledger already has a bill for -- paid, due or waived -- is
  // that bill, so it is never counted twice.
  const ledgerMonths = new Set(payments.map((p) => `${p.tool_id}::${p.due_date.slice(0, 7)}`));
  const undated: Array<{ tool_id: string; label: string }> = [];

  for (const tool of tools) {
    if (tool.deleted_at || !BILLED_STATUSES.has(tool.status)) continue;
    if (tool.cost_amount === null) continue;

    const first = effectiveRenewalDate(tool, today);
    if (!first) {
      // No date to bill on. A lapsed, non-renewing tool simply has no more
      // bills; one that never had a renewal date cannot be placed in the year.
      if (!tool.renewal_date) undated.push({ tool_id: tool.id, label: tool.name });
      continue;
    }

    const step = cycleMonths(tool.billing_cycle);
    // After the next bill, only an auto-renewing tool keeps billing -- the
    // scheduler's rule too. Counted from the first date each time, so a bill
    // on the 31st does not drift to the 28th and stay there.
    for (let k = 0; k <= 60; k++) {
      if (k > 0 && (step === null || !tool.auto_renew)) break;
      const due = k === 0 ? first : addMonths(first, k * step!);
      if (due > yearEnd) break;

      if (tool.payments_scheduled_through && due <= tool.payments_scheduled_through) continue;
      const month = due.slice(0, 7);
      if (ledgerMonths.has(`${tool.id}::${month}`)) continue;

      const price = priceOn(tool, priceChanges, due);
      if (!price) continue;
      lines.push({
        id: `${tool.id}::${due}`,
        kind: 'renewal',
        date: due,
        month,
        label: tool.name,
        detail: tool.vendor,
        tool_id: tool.id,
        product_id: productOf(tool),
        amount: price.amount,
        currency: price.currency.toUpperCase(),
        amount_reported: convert(price.amount, price.currency, month),
      });
    }
  }

  lines.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.label.localeCompare(b.label));

  const sum = (kinds: YearForecastLine['kind'][]) =>
    lines.filter((l) => kinds.includes(l.kind)).reduce((s, l) => s + (l.amount_reported ?? 0), 0);
  const overdue = sum(['overdue']);
  const toCome = sum(['scheduled', 'renewal']);

  return {
    year,
    paid,
    overdue,
    to_come: toCome,
    total: paid + overdue + toCome,
    lines,
    undated_tools: undated,
    unconverted,
  };
}
