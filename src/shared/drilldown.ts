/**
 * Opening a paid total up into what it is made of.
 *
 * Every paid figure on the dashboard -- this year so far, one month, the last
 * twelve -- is a sum of `SpendItem`s, each already converted at its own month's
 * rate by the summary. This file only selects and groups them, so a
 * drill-down cannot disagree with the figure it was opened from: the total here
 * is the same lines added up the same way.
 */

import type { YearMonth } from './fx';
import type { SpendItem, YearForecast } from './types';

export interface CurrencyLine {
  currency: string;
  /** As recorded, in minor units of `currency`. */
  amount: number;
  /** Converted; only the lines a rate covered. */
  reported: number;
  /** Lines in this currency that no rate covered, and which are not in `reported`. */
  unconverted: number;
  count: number;
}

export interface PeriodBreakdown {
  /** Converted total of every line a rate covered. */
  total: number;
  subscriptions: number;
  usage: number;
  /** Lines left out of `total` for want of a rate. */
  unconverted: number;
  payment_count: number;
  bill_count: number;
  /** Largest converted amount first; the reporting currency leads a tie. */
  by_currency: CurrencyLine[];
  /** Newest first, as the summary ordered them. */
  items: SpendItem[];
}

/** The lines whose month falls in [from, to], both inclusive. */
export function itemsBetween(items: SpendItem[], from: YearMonth, to: YearMonth): SpendItem[] {
  return items.filter((item) => item.month >= from && item.month <= to);
}

export function breakdown(items: SpendItem[], reportingCurrency: string): PeriodBreakdown {
  const target = reportingCurrency.toUpperCase();
  const currencies = new Map<string, CurrencyLine>();
  let total = 0;
  let subscriptions = 0;
  let usage = 0;
  let unconverted = 0;
  let paymentCount = 0;
  let billCount = 0;

  for (const item of items) {
    if (item.kind === 'usage') billCount += 1;
    else paymentCount += 1;

    const line = currencies.get(item.currency) ?? {
      currency: item.currency,
      amount: 0,
      reported: 0,
      unconverted: 0,
      count: 0,
    };
    line.amount += item.amount;
    line.count += 1;

    if (item.amount_reported === null) {
      line.unconverted += 1;
      unconverted += 1;
    } else {
      line.reported += item.amount_reported;
      total += item.amount_reported;
      if (item.kind === 'usage') usage += item.amount_reported;
      else subscriptions += item.amount_reported;
    }
    currencies.set(item.currency, line);
  }

  const byCurrency = [...currencies.values()].sort(
    (a, b) => b.reported - a.reported || Number(b.currency === target) - Number(a.currency === target),
  );

  return {
    total,
    subscriptions,
    usage,
    unconverted,
    payment_count: paymentCount,
    bill_count: billCount,
    by_currency: byCurrency,
    items,
  };
}

// ---------------------------------------------------------------------------
// The year, split the way the dashboard splits it
// ---------------------------------------------------------------------------

export interface YearPart {
  paid: number;
  to_come: number;
  total: number;
}

export interface YearSplit {
  /** Subscriptions not attributed to one of our products. */
  bought: YearPart;
  /** What running our own products costs: their subscriptions and their cloud usage. */
  own: YearPart;
  /** The same, product by product. */
  by_product: Map<string, YearPart>;
}

const emptyPart = (): YearPart => ({ paid: 0, to_come: 0, total: 0 });

/**
 * This year's paid lines and still-to-come lines, by who the money is for. A
 * line belongs to our own products when it carries a product id: a cloud bill,
 * or a payment for a tool attributed to a product.
 */
export function splitYear(
  paidItems: SpendItem[],
  forecast: YearForecast,
): YearSplit {
  const first = `${forecast.year}-01`;
  const last = `${forecast.year}-12`;
  const split: YearSplit = { bought: emptyPart(), own: emptyPart(), by_product: new Map() };

  const add = (productId: string | null, amount: number | null, key: 'paid' | 'to_come') => {
    if (amount === null) return;
    const part = productId ? split.own : split.bought;
    part[key] += amount;
    part.total += amount;
    if (productId) {
      const product = split.by_product.get(productId) ?? emptyPart();
      product[key] += amount;
      product.total += amount;
      split.by_product.set(productId, product);
    }
  };

  for (const item of paidItems) {
    if (item.month < first || item.month > last) continue;
    add(item.product_id, item.amount_reported, 'paid');
  }
  for (const line of forecast.lines) add(line.product_id, line.amount_reported, 'to_come');
  return split;
}
