/**
 * Money handling. Amounts are ALWAYS integers in minor units (paise, cents)
 * paired with an ISO currency code.
 *
 * Floats are banned here on purpose: 0.1 + 0.2 !== 0.3 is not an acceptable
 * property for something that decides whether a bill was paid in full.
 */

import { cycleMonths, type BillingCycle } from './dates';

export type Minor = number; // integer, minor units

export interface Money {
  amount: Minor;
  currency: string;
}

/** Currencies whose minor unit is the whole unit (no decimal places). */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

export function decimalPlaces(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Parse human input into minor units. Accepts '1,499', '1499.50', '₹1,499',
 * '$ 1499' and blank. Returns null when there is no parseable number, so
 * callers can distinguish "not entered" from "entered as zero".
 */
export function parseMoneyInput(input: string, currency = 'INR'): Minor | null {
  const cleaned = input.replace(/[^\d.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimalPlaces(currency);
  return Math.round(value * factor);
}

/** Minor units back to a decimal string for populating form fields. */
export function toDecimalString(amount: Minor | null | undefined, currency = 'INR'): string {
  if (amount === null || amount === undefined) return '';
  const places = decimalPlaces(currency);
  return (amount / 10 ** places).toFixed(places);
}

const SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
  AED: 'AED ',
  JPY: '¥',
};

export function currencySymbol(currency: string): string {
  return SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
}

/** '₹1,499.00'. Grouping follows the locale, defaulting to en-IN for INR. */
export function formatMoney(
  amount: Minor | null | undefined,
  currency = 'INR',
  opts: { compact?: boolean } = {},
): string {
  if (amount === null || amount === undefined) return '--';
  const places = decimalPlaces(currency);
  const value = amount / 10 ** places;
  const locale = currency.toUpperCase() === 'INR' ? 'en-IN' : 'en-US';

  if (opts.compact && Math.abs(value) >= 100_000) {
    return `${currencySymbol(currency)}${new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)}`;
  }
  return `${currencySymbol(currency)}${new Intl.NumberFormat(locale, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(value)}`;
}

/**
 * The annual cost of a recurring subscription, in minor units.
 * Returns null for one_time and custom cycles: they have no annual run-rate,
 * and quietly treating a one-off purchase as recurring spend would overstate
 * the budget every single month.
 */
export function annualisedCost(amount: Minor | null, cycle: BillingCycle): Minor | null {
  if (amount === null) return null;
  const months = cycleMonths(cycle);
  if (months === null) return null;
  return Math.round((amount * 12) / months);
}

/** The monthly run-rate of a recurring subscription, in minor units. */
export function monthlyCost(amount: Minor | null, cycle: BillingCycle): Minor | null {
  if (amount === null) return null;
  const months = cycleMonths(cycle);
  if (months === null) return null;
  return Math.round(amount / months);
}

/** Per-seat cost, or null when seat data is missing or zero. */
export function costPerSeat(amount: Minor | null, seats: number | null): Minor | null {
  if (amount === null || !seats || seats <= 0) return null;
  return Math.round(amount / seats);
}

/**
 * Value of seats bought but not used, per billing period.
 * This is the number that makes people cancel things.
 */
export function wastedSeatCost(
  amount: Minor | null,
  purchased: number | null,
  used: number | null,
): Minor | null {
  if (amount === null || !purchased || purchased <= 0) return null;
  if (used === null || used === undefined) return null;
  const idle = Math.max(0, purchased - used);
  if (idle === 0) return 0;
  return Math.round((amount / purchased) * idle);
}

/**
 * Sum amounts that may span currencies.
 *
 * There is no FX conversion in v1 (rates would need a paid feed and would make
 * historical totals unstable), so this returns a per-currency breakdown and the
 * caller decides how to present it. `dominant` is the currency with the largest
 * total, which is what the headline KPI shows.
 */
export function sumByCurrency(
  entries: Array<{ amount: Minor | null; currency: string }>,
): { totals: Record<string, Minor>; dominant: string | null } {
  const totals: Record<string, Minor> = {};
  for (const e of entries) {
    if (e.amount === null || e.amount === undefined) continue;
    const key = e.currency.toUpperCase();
    totals[key] = (totals[key] ?? 0) + e.amount;
  }
  let dominant: string | null = null;
  let best = -Infinity;
  for (const [cur, total] of Object.entries(totals)) {
    if (total > best) {
      best = total;
      dominant = cur;
    }
  }
  return { totals, dominant };
}
