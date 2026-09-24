/**
 * Monthly reference rates from the European Central Bank.
 *
 * Why the ECB: the rates are official, free, need no API key or account, and
 * are published on a fixed schedule. A paid feed would be more precise for
 * treasury work, but this dashboard is answering "roughly what did this cost
 * the company", and an official public rate is both good enough and defensible
 * in a board meeting.
 *
 * The endpoint is SDMX, requested as CSV because parsing CSV needs no
 * dependency and no XML parser in a Worker.
 *
 *   GET https://data-api.ecb.europa.eu/service/data/EXR/M.USD+INR.EUR.SP00.A
 *         ?startPeriod=2026-01&endPeriod=2026-09&format=csvdata
 *
 * Key structure: M (monthly) . CURRENCY . EUR (denominator) . SP00 (reference
 * rate) . A (average over the period).
 *
 * Two things about the data that shape the code below:
 *   1. EUR never appears -- it is the denominator, and is 1 by definition.
 *   2. A month is only published once it has ended, so the current month is
 *      always absent. Callers fall back to the latest earlier month rather
 *      than refusing to produce a total (see sumConverted in shared/fx.ts).
 */

import type { FxRate, YearMonth } from '../../shared/fx';
import { isYearMonth, parseRate } from '../../shared/fx';

const ECB_BASE = 'https://data-api.ecb.europa.eu/service/data/EXR';

export interface FetchRatesOptions {
  currencies: string[];
  from: YearMonth;
  to: YearMonth;
  /** Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Give up rather than hanging the cron job on a slow upstream. */
  timeoutMs?: number;
}

export interface FetchRatesResult {
  rates: FxRate[];
  /** Currencies asked for that the feed returned nothing for. */
  missing: string[];
  source: 'ecb';
  url: string;
}

export class FxFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FxFetchError';
  }
}

/**
 * Split one CSV line, honouring double-quoted fields.
 * The ECB feed rarely quotes, but a title string containing a comma would
 * silently shift every column after it, so this is not optional.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Pull (currency, month, rate) triples out of the ECB's CSV.
 *
 * Columns are located by header name, never by index: the feed carries a
 * couple of dozen metadata columns and their order is not a stable contract.
 */
export function parseEcbCsv(csv: string, fetchedAt: string): FxRate[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]!).map((h) => h.toUpperCase());
  const currencyAt = header.indexOf('CURRENCY');
  const periodAt = header.indexOf('TIME_PERIOD');
  const valueAt = header.indexOf('OBS_VALUE');
  if (currencyAt === -1 || periodAt === -1 || valueAt === -1) return [];

  const out: FxRate[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const currency = (cells[currencyAt] ?? '').toUpperCase();
    const month = cells[periodAt] ?? '';
    const rate = cells[valueAt] ?? '';

    // A suppressed or not-yet-published observation comes through blank.
    if (!currency || !isYearMonth(month)) continue;
    if (parseRate(rate) === null) continue;

    out.push({ month, currency, rate, source: 'ecb', fetched_at: fetchedAt });
  }
  return out;
}

/** Fetch monthly rates for the given currencies over a month range. */
export async function fetchEcbRates(options: FetchRatesOptions): Promise<FetchRatesResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  // EUR is the denominator and is never quoted against itself.
  const wanted = [...new Set(options.currencies.map((c) => c.toUpperCase()))]
    .filter((c) => c !== 'EUR')
    .sort();

  if (wanted.length === 0) {
    return { rates: [], missing: [], source: 'ecb', url: '' };
  }

  const key = `M.${wanted.join('+')}.EUR.SP00.A`;
  const url = `${ECB_BASE}/${key}?startPeriod=${options.from}&endPeriod=${options.to}&format=csvdata`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { accept: 'text/csv' },
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FxFetchError(
      controller.signal.aborted
        ? `The ECB did not respond within ${Math.round(timeoutMs / 1000)}s.`
        : `Could not reach the ECB rate feed: ${reason}`,
    );
  } finally {
    clearTimeout(timer);
  }

  // 404 here means the key matched nothing -- usually a currency the ECB does
  // not publish -- which is a bad request, not an outage.
  if (response.status === 404) {
    throw new FxFetchError(
      `The ECB publishes no monthly rate for one of: ${wanted.join(', ')}.`,
      404,
    );
  }
  if (!response.ok) {
    throw new FxFetchError(`The ECB rate feed returned ${response.status}.`, response.status);
  }

  const rates = parseEcbCsv(await response.text(), new Date().toISOString());
  const seen = new Set(rates.map((r) => r.currency));

  return {
    rates,
    missing: wanted.filter((c) => !seen.has(c)),
    source: 'ecb',
    url,
  };
}
