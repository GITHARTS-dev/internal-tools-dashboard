/**
 * The scheduled side of FX: keep the stored rates current without re-fetching
 * two years of history every morning.
 *
 * The ECB publishes a month's average only after that month ends, so the
 * useful window is small: the last few months, in case a figure was revised or
 * the job missed a day. Everything older is already final and is left alone.
 */

import type { Db } from '../repo/db';
import { addMonthsToYearMonth, monthOf, type YearMonth } from '../../shared/fx';
import { todayInTimezone } from '../../shared/dates';
import { fetchEcbRates } from './ecb';
import { availableMonths, saveRates } from '../repo/fxRates';
import { getSettings } from '../repo/settings';
import { listAllTools } from '../repo/tools';
import { listPayments } from '../repo/payments';
import { distinctCostCurrencies } from '../repo/productCosts';

/** How far back a routine refresh reaches. Older months are settled. */
const TRAILING_MONTHS = 3;

/** The window a first-ever refresh backfills: this year and last. */
const BACKFILL_MONTHS = 24;

export interface RefreshResult {
  refreshed: boolean;
  saved: number;
  from: YearMonth | null;
  to: YearMonth | null;
  missing: string[];
  reason?: string;
}

export async function currenciesInUse(db: Db, reporting: string): Promise<string[]> {
  const [tools, payments, costCurrencies] = await Promise.all([
    listAllTools(db),
    listPayments(db),
    distinctCostCurrencies(db),
  ]);
  const set = new Set<string>([reporting.toUpperCase()]);
  for (const tool of tools) set.add(tool.currency.toUpperCase());
  for (const payment of payments) set.add(payment.currency.toUpperCase());
  // A currency that only appears on a recorded product cost still needs a rate,
  // or that cost would sit in the ledger unconvertible and be left out of totals.
  for (const currency of costCurrencies) set.add(currency);
  return [...set].sort();
}

/**
 * Refresh if the settings allow it.
 *
 * Returns rather than throws on "nothing to do", so the caller can log one
 * line. Genuine fetch failures still throw, because the cron handler wants to
 * record that the ECB was unreachable.
 */
export async function refreshRatesIfDue(db: Db, now?: Date): Promise<RefreshResult> {
  const settings = await getSettings(db);

  if (!settings.fx_auto_refresh) {
    return { refreshed: false, saved: 0, from: null, to: null, missing: [], reason: 'auto refresh is off' };
  }

  const today = todayInTimezone(settings.timezone, now);
  const thisMonth = monthOf(today);
  const held = await availableMonths(db);

  // Nothing stored yet: backfill so last year's total works from day one.
  const span = held.length === 0 ? BACKFILL_MONTHS : TRAILING_MONTHS;
  const from = addMonthsToYearMonth(thisMonth, -span);

  const currencies = await currenciesInUse(db, settings.reporting_currency);
  if (currencies.length <= 1 && currencies[0] === 'EUR') {
    return { refreshed: false, saved: 0, from: null, to: null, missing: [], reason: 'only EUR in use' };
  }

  const result = await fetchEcbRates({ currencies, from, to: thisMonth });
  const saved = await saveRates(db, result.rates);

  return { refreshed: true, saved, from, to: thisMonth, missing: result.missing };
}
