import { Hono } from 'hono';
import type { Env } from '../context';
import { actor, db, zodErrorResponse } from '../context';
import { isYearMonth, monthOf, addMonthsToYearMonth, parseRate } from '../../shared/fx';
import { fetchEcbRates, FxFetchError } from '../fx/ecb';
import { availableMonths, fxStatus, listRates, saveRates } from '../repo/fxRates';
import { getSettings } from '../repo/settings';
import { listAllTools } from '../repo/tools';
import { listPayments } from '../repo/payments';
import { recordAudit } from '../repo/audit';
import { todayInTimezone } from '../../shared/dates';

export const fxRoutes = new Hono<{ Bindings: Env }>();

/**
 * Which currencies this company actually uses.
 *
 * Derived from the data rather than configured, so adding a tool priced in a
 * new currency makes the next refresh fetch that currency without anyone
 * remembering to update a list.
 */
async function currenciesInUse(dbi: ReturnType<typeof db>, reporting: string): Promise<string[]> {
  const tools = await listAllTools(dbi);
  const payments = await listPayments(dbi);
  const set = new Set<string>([reporting.toUpperCase()]);
  for (const tool of tools) set.add(tool.currency.toUpperCase());
  for (const payment of payments) set.add(payment.currency.toUpperCase());
  return [...set].sort();
}

fxRoutes.get('/fx/status', async (c) => {
  const settings = await getSettings(db(c));
  const status = await fxStatus(db(c));
  return c.json({
    status,
    reporting_currency: settings.reporting_currency,
    auto_refresh: settings.fx_auto_refresh,
    currencies_in_use: await currenciesInUse(db(c), settings.reporting_currency),
  });
});

fxRoutes.get('/fx/rates', async (c) => {
  const url = new URL(c.req.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;

  if ((from && !isYearMonth(from)) || (to && !isYearMonth(to))) {
    return c.json({ error: 'bad_month', message: 'Use a month in YYYY-MM form.' }, 400);
  }
  return c.json({ rates: await listRates(db(c), from, to) });
});

/**
 * Pull rates from the ECB and store them.
 *
 * Defaults to a 25-month window ending this month, which covers the current
 * and previous calendar year -- enough for "what did we spend last year" to be
 * answerable the moment the feature is switched on.
 */
fxRoutes.post('/fx/refresh', async (c) => {
  const settings = await getSettings(db(c));
  const url = new URL(c.req.url);
  const today = todayInTimezone(settings.timezone);
  const thisMonth = monthOf(today);

  const from = url.searchParams.get('from') ?? addMonthsToYearMonth(thisMonth, -24);
  const to = url.searchParams.get('to') ?? thisMonth;

  if (!isYearMonth(from) || !isYearMonth(to)) {
    return c.json({ error: 'bad_month', message: 'Use months in YYYY-MM form.' }, 400);
  }
  if (from > to) {
    return c.json({ error: 'bad_range', message: 'The start month is after the end month.' }, 400);
  }

  const currencies = await currenciesInUse(db(c), settings.reporting_currency);

  try {
    const result = await fetchEcbRates({ currencies, from, to });
    const saved = await saveRates(db(c), result.rates);

    await recordAudit(db(c), {
      entity: 'fx_rates',
      entity_id: `${from}..${to}`,
      action: 'update',
      actor: actor(c),
      summary: `Fetched ${saved} ECB rate(s) for ${currencies.join(', ')}`,
    });

    return c.json({
      saved,
      from,
      to,
      currencies,
      /** Currencies the ECB does not publish: they stay unconvertible, loudly. */
      missing: result.missing,
      status: await fxStatus(db(c)),
    });
  } catch (error) {
    if (error instanceof FxFetchError) {
      return c.json({ error: 'fx_fetch_failed', message: error.message }, 502);
    }
    throw error;
  }
});

/**
 * Set one rate by hand.
 *
 * Needed for currencies the ECB does not publish, and as the escape hatch when
 * the company's own bank rate differs from the reference rate. Stored with
 * source 'manual' so the UI can show which numbers a person chose.
 */
fxRoutes.put('/fx/rates/:month/:currency', async (c) => {
  const month = c.req.param('month');
  const currency = c.req.param('currency').toUpperCase();
  const body = (await c.req.json().catch(() => ({}))) as { rate?: unknown };

  if (!isYearMonth(month)) {
    return c.json({ error: 'bad_month', message: 'Use a month in YYYY-MM form.' }, 400);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    return c.json({ error: 'bad_currency', message: 'Use a 3-letter currency code.' }, 400);
  }
  if (currency === 'EUR') {
    return c.json(
      { error: 'bad_currency', message: 'EUR is the base rate and is always 1.' },
      400,
    );
  }

  const rate = String(body.rate ?? '');
  if (parseRate(rate) === null) {
    return c.json(
      {
        error: 'validation_failed',
        message: 'Some fields need fixing.',
        fields: { rate: 'Enter a positive number, such as 90.42' },
      },
      400,
    );
  }

  await saveRates(db(c), [
    { month, currency, rate, source: 'manual', fetched_at: new Date().toISOString() },
  ]);
  await recordAudit(db(c), {
    entity: 'fx_rates',
    entity_id: `${month}/${currency}`,
    action: 'update',
    actor: actor(c),
    summary: `Set ${currency} rate for ${month} by hand to ${rate}`,
  });

  return c.json({ month, currency, rate, source: 'manual' });
});

/** Months we hold any rate for, for the gap display. */
fxRoutes.get('/fx/months', async (c) => c.json({ months: await availableMonths(db(c)) }));

export { zodErrorResponse };
