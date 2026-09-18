/**
 * All calendar arithmetic for the app lives here.
 *
 * Reminders that fire on the wrong day are the most damaging bug this product
 * can have, so there is exactly one implementation of every date operation and
 * it is tested directly.
 *
 * Model: a "day" is a plain `YYYY-MM-DD` string with no time and no offset.
 * Internally we anchor to UTC midnight, which makes day arithmetic exact and
 * immune to daylight-saving shifts. Timezone only matters in one place --
 * deciding which calendar day "now" falls on -- and that is `todayInTimezone`.
 */

export type IsoDate = string; // 'YYYY-MM-DD'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** True only for a well-formed date string that names a real calendar day. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  // Rejects 2026-02-30 and friends by round-tripping through a real date.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function parts(date: IsoDate): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Not an ISO date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fmt(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** UTC-midnight epoch ms for a date string. Exact, so day deltas are exact. */
export function toEpochDay(date: IsoDate): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d);
}

export function fromEpochDay(ms: number): IsoDate {
  const dt = new Date(ms);
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Which calendar day it is right now in a given business timezone.
 * 'en-CA' formats as YYYY-MM-DD, which is exactly the shape we store.
 */
export function todayInTimezone(timeZone: string, now: Date = new Date()): IsoDate {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // An unknown timezone in settings must not take the reminder job down.
    return fromEpochDay(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}

/** Whole days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toEpochDay(to) - toEpochDay(from)) / MS_PER_DAY);
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return fromEpochDay(toEpochDay(date) + n * MS_PER_DAY);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Add months, clamping to the end of the target month.
 * 2026-01-31 + 1 month => 2026-02-28, not 2026-03-03.
 *
 * This is what a vendor actually does to a monthly renewal date, and getting
 * it wrong silently walks a renewal forward by a few days every month.
 */
export function addMonths(date: IsoDate, n: number): IsoDate {
  const [y, m, d] = parts(date);
  const targetIndex = m - 1 + n;
  const ty = y + Math.floor(targetIndex / 12);
  const tm = ((targetIndex % 12) + 12) % 12; // 0-based, normalised for negatives
  return fmt(ty, tm + 1, Math.min(d, daysInMonth(ty, tm + 1)));
}

export type BillingCycle = 'monthly' | 'quarterly' | 'annual' | 'one_time' | 'custom';

/** Months per billing period, or null for cycles with no fixed period. */
export function cycleMonths(cycle: BillingCycle): number | null {
  switch (cycle) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'annual':
      return 12;
    case 'one_time':
    case 'custom':
      return null;
  }
}

/** The next renewal date one billing period after `date`. */
export function advanceByCycle(date: IsoDate, cycle: BillingCycle): IsoDate | null {
  const months = cycleMonths(cycle);
  return months === null ? null : addMonths(date, months);
}

/**
 * Roll a renewal date forward until it is no longer in the past.
 * Used when a tool has not been touched in a while: a monthly renewal from
 * eight months ago should present as "due next week", not "212 days overdue".
 */
export function nextOccurrenceOnOrAfter(
  date: IsoDate,
  cycle: BillingCycle,
  onOrAfter: IsoDate,
): IsoDate | null {
  const months = cycleMonths(cycle);
  if (months === null) return daysBetween(onOrAfter, date) >= 0 ? date : null;
  let cursor = date;
  // Bounded so a bad cycle/date pair can never spin forever.
  for (let i = 0; i < 600 && daysBetween(onOrAfter, cursor) < 0; i++) {
    cursor = addMonths(cursor, months);
  }
  return cursor;
}

/** ISO weekday: 1 = Monday .. 7 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const day = new Date(toEpochDay(date)).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** '12 Feb 2026' -- unambiguous for both Indian and US readers. */
export function formatDate(date: IsoDate | null | undefined): string {
  if (!date || !isIsoDate(date)) return '--';
  const [y, m, d] = parts(date);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/** 'in 12 days' / 'today' / '3 days ago' */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}
