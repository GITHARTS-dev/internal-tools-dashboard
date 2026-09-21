/**
 * Currency conversion.
 *
 * The rule this file exists to enforce: a payment is converted at the rate of
 * the month it was made in, never at today's rate. Applying today's rate to
 * last year's invoice would make "what did we spend in 2025" change every time
 * the page loads, which makes the number worthless for a CEO.
 *
 * Rates are ECB reference rates, quoted against EUR: `rate[USD] = 1.0856` means
 * one euro buys 1.0856 dollars. EUR itself is always exactly 1.
 *
 * All arithmetic is BigInt. Money is integer minor units everywhere else in
 * this codebase precisely so rounding is a decision rather than an accident,
 * and a float multiply here would quietly undo that.
 */

import { decimalPlaces, type Minor } from './money';

/** Rates are held as integers scaled by 1e10; ECB publishes 4-6 decimals. */
export const RATE_SCALE = 10n ** 10n;

export type YearMonth = string; // 'YYYY-MM'

export interface FxRate {
  month: YearMonth;
  /** ISO code this rate is for. */
  currency: string;
  /** Units of `currency` per 1 EUR, as published. */
  rate: string;
  source: string;
  fetched_at: string;
}

/** A conversion that happened, with everything needed to explain it. */
export interface Converted {
  amount: Minor;
  currency: string;
  /** What it was before conversion. */
  from_amount: Minor;
  from_currency: string;
  /** Null when no conversion was needed (same currency). */
  rate_month: YearMonth | null;
  /** Units of target per 1 unit of source, for display. Null when unconverted. */
  rate: string | null;
}

const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isYearMonth(value: unknown): value is YearMonth {
  return typeof value === 'string' && YEAR_MONTH_RE.test(value);
}

/** 'YYYY-MM-DD' -> 'YYYY-MM'. */
export function monthOf(date: string): YearMonth {
  return date.slice(0, 7);
}

/** Step a 'YYYY-MM' back or forward by whole months. */
export function addMonthsToYearMonth(month: YearMonth, n: number): YearMonth {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const index = year * 12 + (m - 1) + n;
  const ty = Math.floor(index / 12);
  const tm = ((index % 12) + 12) % 12;
  return `${String(ty).padStart(4, '0')}-${String(tm + 1).padStart(2, '0')}`;
}

/**
 * Parse a published decimal rate ('1.0856') into a scaled integer.
 * Returns null for anything unparseable, so a malformed feed row is dropped
 * rather than poisoning a total.
 */
export function parseRate(raw: string | number | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const frac = dot === -1 ? '' : text.slice(dot + 1);

  // Pad or truncate the fraction to exactly the scale's digit count.
  const scaleDigits = RATE_SCALE.toString().length - 1;
  const padded = (frac + '0'.repeat(scaleDigits)).slice(0, scaleDigits);

  const value = BigInt(whole) * RATE_SCALE + BigInt(padded || '0');
  return value > 0n ? value : null;
}

/** Scaled integer back to a trimmed decimal string, for display. */
export function formatRate(scaled: bigint, maxDecimals = 6): string {
  const whole = scaled / RATE_SCALE;
  const frac = scaled % RATE_SCALE;
  const scaleDigits = RATE_SCALE.toString().length - 1;
  const fracText = frac.toString().padStart(scaleDigits, '0').slice(0, maxDecimals).replace(/0+$/, '');
  return fracText ? `${whole}.${fracText}` : String(whole);
}

/** Divide two BigInts, rounding half away from zero. Both must be positive. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('fx: division by zero');
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export type RateTable = Record<string, bigint>;

/**
 * Build a lookup of scaled EUR-based rates for one month.
 * EUR is injected at exactly 1 because the ECB feed omits its own base.
 */
export function rateTable(rates: FxRate[]): RateTable {
  const table: RateTable = { EUR: RATE_SCALE };
  for (const entry of rates) {
    const parsed = parseRate(entry.rate);
    if (parsed !== null) table[entry.currency.toUpperCase()] = parsed;
  }
  return table;
}

/**
 * Convert one amount using a month's rate table.
 *
 * Returns null when either currency is missing from the table: a total that
 * silently drops the rows it could not convert is worse than one that says it
 * could not be produced.
 */
export function convert(
  amount: Minor,
  from: string,
  to: string,
  table: RateTable,
  month: YearMonth | null = null,
): Converted | null {
  const fromCur = from.toUpperCase();
  const toCur = to.toUpperCase();

  if (fromCur === toCur) {
    return {
      amount,
      currency: toCur,
      from_amount: amount,
      from_currency: fromCur,
      rate_month: null,
      rate: null,
    };
  }

  const fromRate = table[fromCur];
  const toRate = table[toCur];
  if (fromRate === undefined || toRate === undefined) return null;

  const fromScale = 10n ** BigInt(decimalPlaces(fromCur));
  const toScale = 10n ** BigInt(decimalPlaces(toCur));

  const negative = amount < 0;
  const magnitude = BigInt(negative ? -amount : amount);

  // minor_to = amount * 10^dp(to) * rate[to] / (10^dp(from) * rate[from])
  const numerator = magnitude * toScale * toRate;
  const denominator = fromScale * fromRate;
  const converted = divRound(numerator, denominator);

  // The pairwise rate, for the "converted at X" label.
  const pairRate = divRound(toRate * RATE_SCALE, fromRate);

  return {
    amount: Number(negative ? -converted : converted),
    currency: toCur,
    from_amount: amount,
    from_currency: fromCur,
    rate_month: month,
    rate: formatRate(pairRate),
  };
}

/** What a total could not account for, so the UI can say so out loud. */
export interface ConversionGap {
  currency: string;
  month: YearMonth | null;
  /** How many rows were skipped for this reason. */
  count: number;
}

export interface ConvertedTotal {
  currency: string;
  amount: Minor;
  /** Rows that had no usable rate and are therefore NOT in `amount`. */
  gaps: ConversionGap[];
  /** Months whose rates were used, for a "rates as at" line. */
  months: YearMonth[];
}

/**
 * Sum amounts from many currencies into one, each at its own month's rate.
 *
 * `tables` maps 'YYYY-MM' to that month's rates. An entry whose month has no
 * table falls back to the most recent earlier month available, because the ECB
 * publishes a month only once it is over -- without the fallback, every total
 * containing this month's spend would refuse to compute.
 */
export function sumConverted(
  entries: Array<{ amount: Minor | null; currency: string; month: YearMonth | null }>,
  target: string,
  tables: Record<YearMonth, RateTable>,
): ConvertedTotal {
  const targetCur = target.toUpperCase();
  const available = Object.keys(tables).sort();
  const gapsByKey = new Map<string, ConversionGap>();
  const monthsUsed = new Set<YearMonth>();

  let total = 0;

  for (const entry of entries) {
    if (entry.amount === null || entry.amount === undefined) continue;
    const currency = entry.currency.toUpperCase();

    if (currency === targetCur) {
      total += entry.amount;
      continue;
    }

    const month = entry.month ?? available[available.length - 1] ?? null;
    const resolved = month === null ? null : resolveMonth(month, available);
    const table = resolved === null ? undefined : tables[resolved];

    const converted = table ? convert(entry.amount, currency, targetCur, table, resolved) : null;
    if (converted === null) {
      const key = `${currency}::${month ?? ''}`;
      const gap = gapsByKey.get(key) ?? { currency, month, count: 0 };
      gap.count += 1;
      gapsByKey.set(key, gap);
      continue;
    }

    total += converted.amount;
    if (resolved) monthsUsed.add(resolved);
  }

  return {
    currency: targetCur,
    amount: total,
    gaps: [...gapsByKey.values()].sort((a, b) => b.count - a.count),
    months: [...monthsUsed].sort(),
  };
}

/** The requested month, or the latest earlier month we hold rates for. */
export function resolveMonth(month: YearMonth, available: string[]): YearMonth | null {
  if (available.includes(month)) return month;
  let best: string | null = null;
  for (const candidate of available) {
    if (candidate <= month && (best === null || candidate > best)) best = candidate;
  }
  return best;
}
