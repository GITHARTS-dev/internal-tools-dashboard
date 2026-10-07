/**
 * Where this calendar year will land: what has been paid, plus what is still
 * to come before 31 December.
 *
 * Four parts, kept apart because they are known to different degrees:
 *
 *   paid       payments marked paid and cloud bills entered this year. Fact.
 *   owed       payments in the ledger, due this year and not yet paid --
 *              overdue or coming up. Known amounts on known dates.
 *   renewals   each live subscription's remaining bills this year that the
 *              ledger does not hold yet, on its real billing dates at the
 *              price in effect on each date -- the same rule the scheduler
 *              uses to add them. A tool renewing yearly in November counts
 *              once, in full; one that renewed in February counts nothing more.
 *   usage      each product's cloud cost for the months not yet entered, at its
 *              recent average. The only estimate, and labelled as one.
 *
 * Nothing is guessed: a live tool with no renewal date cannot be placed in the
 * year, so it is listed as undated rather than spread across the months.
 */

import { addMonthsToYearMonth, sumConverted, type RateTable, type YearMonth } from './fx';
import { addMonths, cycleMonths, type IsoDate } from './dates';
import { effectiveRenewalDate } from './alerts';
import { priceOn } from './prices';
import type {
  InternalProductCost,
  Payment,
  PriceChange,
  SpendItem,
  Tool,
  YearForecast,
  YearForecastLine,
} from './types';

/** Tools in these states are still being paid for -- the scheduler's own rule. */
const BILLED_STATUSES = new Set(['active', 'trial']);

export interface YearForecastInput {
  tools: Tool[];
  payments: Payment[];
  priceChanges: PriceChange[];
  products: InternalProductCost[];
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
  const productIds = new Set(products.map((p) => p.product.id));
  const productOf = (tool: Tool | undefined): string | null =>
    tool?.internal_product_id && productIds.has(tool.internal_product_id) ? tool.internal_product_id : null;

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

  // ------------------------------------------------------------------ owed
  for (const payment of payments) {
    if (payment.status !== 'due') continue;
    if (payment.due_date.slice(0, 4) !== year) continue;
    const tool = toolsById.get(payment.tool_id);
    const month = payment.due_date.slice(0, 7);
    lines.push({
      id: payment.id,
      kind: payment.due_date < today ? 'overdue' : 'due',
      date: payment.due_date,
      month,
      label: tool?.name ?? 'A removed tool',
      detail: tool?.vendor ?? null,
      tool_id: tool ? tool.id : null,
      product_id: productOf(tool),
      amount: payment.amount,
      currency: payment.currency.toUpperCase(),
      amount_reported: convert(payment.amount, payment.currency, month),
    });
  }

  // -------------------------------------------------------------- renewals
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
    for (let k = 0; ; k++) {
      if (k > 0 && (step === null || !tool.auto_renew)) break;
      const due = k === 0 ? first : addMonths(first, k * step!);
      if (due > yearEnd) break;
      if (k > 60) break; // a guard, never reached by a real cycle within one year

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

  // ----------------------------------------------------------------- usage
  // Every month from the one after the last bill entered to December, at the
  // product's recent average. Not before the product existed, and not before
  // this year began.
  for (const entry of products) {
    if (entry.product.status === 'retired') continue;
    const average = entry.usage_monthly_reported;
    if (average === null || !entry.last_cost_month) continue;

    const started = [entry.product.launched_on, entry.product.created_at]
      .filter((d): d is string => Boolean(d))
      .map((d) => d.slice(0, 7))
      .sort()[0];
    let month = addMonthsToYearMonth(entry.last_cost_month, 1);
    if (started && month < started) month = started;
    if (month < firstMonth) month = firstMonth;

    const counted = entry.usage_window.filter((m) => m.amount !== null).map((m) => m.month);
    for (; month <= lastMonth; month = addMonthsToYearMonth(month, 1)) {
      lines.push({
        id: `${entry.product.id}::${month}`,
        kind: 'usage',
        date: null,
        month,
        label: entry.product.name,
        detail: counted.length > 0 ? `average of ${counted.length} ${counted.length === 1 ? 'month' : 'months'}` : null,
        tool_id: null,
        product_id: entry.product.id,
        amount: average,
        currency: target,
        amount_reported: average,
      });
    }
  }

  lines.sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
      a.label.localeCompare(b.label),
  );

  const sum = (kinds: YearForecastLine['kind'][]) =>
    lines.filter((l) => kinds.includes(l.kind)).reduce((s, l) => s + (l.amount_reported ?? 0), 0);
  const owed = sum(['overdue', 'due']);
  const renewals = sum(['renewal']);
  const usage = sum(['usage']);

  return {
    year,
    paid,
    owed,
    renewals,
    usage,
    total: paid + owed + renewals + usage,
    lines,
    undated_tools: undated,
    unconverted,
  };
}
