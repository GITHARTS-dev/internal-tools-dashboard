/**
 * Turning recorded monthly costs into a usage estimate.
 *
 * A subscription's cost is a price and a billing cycle, so its run rate is
 * arithmetic. A product's cloud spend is a different thing: it is whatever the
 * bill said that month, and next month's is unknown. The honest way to put one
 * number on it is a recent average, clearly labelled as an estimate -- not a
 * commitment, which is what the fixed subscriptions are.
 *
 * Three rules shape this file:
 *
 *   1. Only COMPLETE months count. The current month is still being billed, and
 *      averaging a half-finished bill in would read as spending falling.
 *   2. A month with no entry is unknown, not zero. Averaging over the months
 *      that were actually entered, and saying how many that was, is honest;
 *      averaging in zeros for months nobody got round to typing would quietly
 *      understate the cost of the product.
 *   3. Nothing is guessed. A month whose entries could not be converted (no
 *      rate for that currency) is left out and reported as a gap, the same as
 *      everywhere else money is combined.
 */

import {
  addMonthsToYearMonth,
  monthOf,
  sumConverted,
  type ConversionGap,
  type RateTable,
  type YearMonth,
} from './fx';
import type { InternalProduct, IsoDate, ProductCost } from './types';

/** How many of the most recent complete months the average is taken over. */
export const USAGE_WINDOW_MONTHS = 3;

export interface UsageMonth {
  month: YearMonth;
  /** Whether any cost was entered for this month at all. */
  entered: boolean;
  /** Converted total; null when nothing was entered or nothing could be converted. */
  amount: number | null;
}

export interface ProductUsage {
  /** Mean of the counted months, converted; null when no month could be counted. */
  average_reported: number | null;
  /** How many of the window's months the average is over. */
  months_counted: number;
  /** The window, oldest first, so the screen can show exactly what was averaged. */
  window: UsageMonth[];
  /** The most recent month with any entry, complete or not. */
  last_cost_month: YearMonth | null;
  /** The last complete month -- the one that should have been entered by now. */
  latest_complete_month: YearMonth;
  /** True when that month has no entry yet. */
  latest_month_missing: boolean;
  gaps: ConversionGap[];
  /** Which months' exchange rates were used. */
  rate_months: YearMonth[];
}

/** The most recent month that has fully ended. */
export function lastCompleteMonth(today: IsoDate): YearMonth {
  return addMonthsToYearMonth(monthOf(today), -1);
}

export function computeProductUsage(
  costs: ProductCost[],
  tables: Record<YearMonth, RateTable>,
  target: string,
  today: IsoDate,
): ProductUsage {
  const latest = lastCompleteMonth(today);

  const byMonth = new Map<YearMonth, ProductCost[]>();
  let lastCostMonth: YearMonth | null = null;
  for (const cost of costs) {
    const bucket = byMonth.get(cost.month);
    if (bucket) bucket.push(cost);
    else byMonth.set(cost.month, [cost]);
    if (lastCostMonth === null || cost.month > lastCostMonth) lastCostMonth = cost.month;
  }

  const gaps = new Map<string, ConversionGap>();
  const rateMonths = new Set<YearMonth>();
  const window: UsageMonth[] = [];

  for (let back = USAGE_WINDOW_MONTHS - 1; back >= 0; back--) {
    const month = addMonthsToYearMonth(latest, -back);
    const entries = byMonth.get(month) ?? [];

    if (entries.length === 0) {
      window.push({ month, entered: false, amount: null });
      continue;
    }

    const result = sumConverted(
      entries.map((c) => ({ amount: c.amount, currency: c.currency, month: c.month })),
      target,
      tables,
    );

    for (const gap of result.gaps) {
      const key = `${gap.currency}::${gap.month ?? ''}`;
      const existing = gaps.get(key);
      if (existing) existing.count += gap.count;
      else gaps.set(key, { ...gap });
    }
    for (const rateMonth of result.months) rateMonths.add(rateMonth);

    // Every entry unconvertible: the month is known to have spend but its size
    // is not, so it cannot go into an average. Distinct from "not entered".
    const unusable = result.gaps.length > 0 && result.amount === 0;
    window.push({ month, entered: true, amount: unusable ? null : result.amount });
  }

  const counted = window.filter((m) => m.amount !== null);
  const total = counted.reduce((sum, m) => sum + (m.amount ?? 0), 0);

  return {
    average_reported: counted.length > 0 ? Math.round(total / counted.length) : null,
    months_counted: counted.length,
    window,
    last_cost_month: lastCostMonth,
    latest_complete_month: latest,
    latest_month_missing: !byMonth.has(latest),
    gaps: [...gaps.values()],
    rate_months: [...rateMonths].sort(),
  };
}

// ---------------------------------------------------------------------------
// When is a month's cost due to be entered?
// ---------------------------------------------------------------------------

/**
 * Cloud bills are usually final a few days into the following month, so nothing
 * is flagged before this day. Asking for August's figure on 1 September would
 * be asking for a number that does not exist yet.
 */
export const COSTS_FINAL_FROM_DAY = 5;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-08' -> 'Aug 2026'. */
export function formatMonth(month: YearMonth): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

/**
 * Whether the last complete month's cost is overdue to be entered for a product.
 *
 * This is the ONE definition of that. The reminder, the flag on the dashboard
 * and the banner on the product page all ask this function, for the same reason
 * the alert engine is a single function: the screen must never show a product as
 * up to date while the reminder considers it overdue.
 *
 * It is due when the product is not retired, its last complete month has no
 * entry, that month's bills should be final by now, and the product actually
 * existed then. A product added this month has nothing to enter for last month.
 * "Existed" uses the earliest date known -- its launch date if one was given,
 * otherwise when it was added -- so setting a launch date is how a product that
 * has been running for years starts being asked about its history.
 */
export function costEntryDue(
  product: InternalProduct,
  costs: ProductCost[],
  today: IsoDate,
): boolean {
  if (product.status === 'retired') return false;
  if (Number(today.slice(8, 10)) < COSTS_FINAL_FROM_DAY) return false;

  const month = lastCompleteMonth(today);

  const known = [product.launched_on, product.created_at]
    .filter((d): d is string => Boolean(d))
    .map((d) => d.slice(0, 7))
    .sort();
  if (known.length > 0 && known[0]! > month) return false;

  return !costs.some((c) => c.product_id === product.id && c.month === month);
}
