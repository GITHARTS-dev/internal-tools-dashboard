import { nowIso, type Db } from './db';
import type { FxRate, RateTable, YearMonth } from '../../shared/fx';
import { rateTable } from '../../shared/fx';

/**
 * Stored FX rates.
 *
 * Writes are idempotent by (month, currency): re-running a refresh over a
 * period already covered overwrites with the same published values rather than
 * multiplying rows. That matters because the cron job re-fetches a trailing
 * window every day.
 */

interface RateRow {
  month: string;
  currency: string;
  rate: string;
  source: string;
  fetched_at: string;
}

export async function listRates(db: Db, from?: YearMonth, to?: YearMonth): Promise<FxRate[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (from) {
    where.push('month >= ?');
    binds.push(from);
  }
  if (to) {
    where.push('month <= ?');
    binds.push(to);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const { results } = await db
    .prepare(`SELECT month, currency, rate, source, fetched_at FROM fx_rates${clause} ORDER BY month, currency`)
    .bind(...binds)
    .all<RateRow>();

  return results.map((r) => ({
    month: r.month,
    currency: r.currency.toUpperCase(),
    rate: r.rate,
    source: r.source,
    fetched_at: r.fetched_at,
  }));
}

/** Every month we hold rates for, oldest first. */
export async function availableMonths(db: Db): Promise<YearMonth[]> {
  const { results } = await db
    .prepare('SELECT DISTINCT month FROM fx_rates ORDER BY month')
    .all<{ month: string }>();
  return results.map((r) => r.month);
}

/** Rate tables keyed by month, ready for `sumConverted`. */
export async function rateTablesByMonth(db: Db): Promise<Record<YearMonth, RateTable>> {
  const rates = await listRates(db);
  const byMonth = new Map<YearMonth, FxRate[]>();
  for (const rate of rates) {
    const bucket = byMonth.get(rate.month);
    if (bucket) bucket.push(rate);
    else byMonth.set(rate.month, [rate]);
  }

  const out: Record<YearMonth, RateTable> = {};
  for (const [month, entries] of byMonth) out[month] = rateTable(entries);
  return out;
}

export async function saveRates(db: Db, rates: FxRate[]): Promise<number> {
  if (rates.length === 0) return 0;
  const ts = nowIso();

  const statements = rates.map((rate) =>
    db
      .prepare(
        `INSERT INTO fx_rates (month, currency, rate, source, fetched_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (month, currency) DO UPDATE SET
           rate = excluded.rate,
           source = excluded.source,
           fetched_at = excluded.fetched_at`,
      )
      .bind(rate.month, rate.currency.toUpperCase(), rate.rate, rate.source, rate.fetched_at || ts),
  );

  // D1 caps how much one batch will carry; chunking keeps a multi-year
  // backfill from failing as a single oversized statement list.
  const CHUNK = 50;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await db.batch(statements.slice(i, i + CHUNK));
  }
  return rates.length;
}

export interface FxStatus {
  months: number;
  currencies: string[];
  earliest: YearMonth | null;
  latest: YearMonth | null;
  last_fetched_at: string | null;
}

export async function fxStatus(db: Db): Promise<FxStatus> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT month) AS months,
              MIN(month)            AS earliest,
              MAX(month)            AS latest,
              MAX(fetched_at)       AS last_fetched_at
         FROM fx_rates`,
    )
    .first<{ months: number; earliest: string | null; latest: string | null; last_fetched_at: string | null }>();

  const { results } = await db
    .prepare('SELECT DISTINCT currency FROM fx_rates ORDER BY currency')
    .all<{ currency: string }>();

  return {
    months: row?.months ?? 0,
    currencies: results.map((r) => r.currency.toUpperCase()),
    earliest: row?.earliest ?? null,
    latest: row?.latest ?? null,
    last_fetched_at: row?.last_fetched_at ?? null,
  };
}
