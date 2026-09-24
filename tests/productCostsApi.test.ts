import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, testDb, testEnv } from './db-helper';
import { testPgDb, type PgTestDb } from './pg-helper';
import type { Db } from '../src/server/repo/db';

/**
 * Monthly product costs, through the HTTP API, on both engines.
 *
 * The behaviours worth pinning are the ones that protect the ledger: entering a
 * month twice replaces it instead of doubling it, a month that has not started
 * is refused, and a product with cost history cannot be deleted out from under
 * that history.
 */

let pg: PgTestDb;

beforeAll(async () => {
  pg = await testPgDb();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

const engines: Array<[string, () => Db]> = [
  ['SQLite', () => testDb().db],
  ['Postgres', () => pg.db],
];

/**
 * A month relative to the real clock. Tests avoid the CURRENT month on purpose:
 * the server decides "today" in the business timezone, which can be a different
 * calendar day from UTC, so the boundary month is the one place a test could
 * disagree with the code for no interesting reason.
 */
function monthOffset(delta: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe.each(engines)('monthly product costs on %s', (_name, makeDb) => {
  const fresh = () => testEnv(makeDb());
  type Env = ReturnType<typeof fresh>;

  async function makeProduct(env: Env, name = 'TRA') {
    const res = await api(env, 'POST', '/api/internal-products', { name });
    return res.json.product.id as string;
  }

  const record = (env: Env, id: string, body: Record<string, unknown>) =>
    api(env, 'POST', `/api/internal-products/${id}/costs`, body);

  it('records a cost and lists it', async () => {
    const env = fresh();
    const id = await makeProduct(env);

    const res = await record(env, id, {
      month: monthOffset(-1),
      provider: 'AWS',
      amount: 31250,
      currency: 'usd',
      note: 'incl. data transfer',
    });
    expect(res.status).toBe(201);
    expect(res.json.cost).toMatchObject({
      provider: 'AWS',
      amount: 31250,
      currency: 'USD',
      source: 'manual',
      note: 'incl. data transfer',
    });

    const list = await api(env, 'GET', `/api/internal-products/${id}/costs`);
    expect(list.status).toBe(200);
    expect(list.json.costs).toHaveLength(1);
    // Minor units must come back as a number, or a sum turns into concatenation.
    expect(list.json.costs[0].amount).toBe(31250);
    expect(typeof list.json.costs[0].amount).toBe('number');
  });

  it('defaults the currency to USD, since cloud bills usually are', async () => {
    const env = fresh();
    const id = await makeProduct(env);
    const res = await record(env, id, { month: monthOffset(-1), provider: 'AWS', amount: 100 });
    expect(res.json.cost.currency).toBe('USD');
  });

  it('replaces a month and provider that already exist, ignoring case', async () => {
    const env = fresh();
    const id = await makeProduct(env);
    const month = monthOffset(-1);

    const first = await record(env, id, { month, provider: 'AWS', amount: 10000 });
    expect(first.status).toBe(201);

    const second = await record(env, id, { month, provider: 'aws', amount: 15000, note: 'corrected' });
    // 200, not 201: nothing was created.
    expect(second.status).toBe(200);
    expect(second.json.cost.id).toBe(first.json.cost.id);

    const list = await api(env, 'GET', `/api/internal-products/${id}/costs`);
    // One line, not two: a second click must not double the month.
    expect(list.json.costs).toHaveLength(1);
    expect(list.json.costs[0]).toMatchObject({ amount: 15000, note: 'corrected', provider: 'aws' });
  });

  it('keeps different providers in the same month separate', async () => {
    const env = fresh();
    const id = await makeProduct(env);
    const month = monthOffset(-1);

    await record(env, id, { month, provider: 'AWS', amount: 30000 });
    await record(env, id, { month, provider: 'Supabase', amount: 2500 });

    const list = await api(env, 'GET', `/api/internal-products/${id}/costs`);
    expect(list.json.costs).toHaveLength(2);
  });

  it('lists newest month first', async () => {
    const env = fresh();
    const id = await makeProduct(env);
    for (const back of [3, 1, 2]) {
      await record(env, id, { month: monthOffset(-back), provider: 'AWS', amount: back * 100 });
    }
    const list = await api(env, 'GET', `/api/internal-products/${id}/costs`);
    expect(list.json.costs.map((c: { month: string }) => c.month)).toEqual([
      monthOffset(-1),
      monthOffset(-2),
      monthOffset(-3),
    ]);
  });

  it.each([
    ['a negative amount', { amount: -5 }, 'amount'],
    ['a fractional minor unit', { amount: 12.5 }, 'amount'],
    ['no provider', { provider: '  ' }, 'provider'],
    ['a month that is not a month', { month: 'August' }, 'month'],
    ['a month that does not exist', { month: '2026-13' }, 'month'],
    ['a currency that is not three letters', { currency: 'dollars' }, 'currency'],
    ['a month that has not started', { month: monthOffset(2) }, 'month'],
  ])('rejects %s, naming the field', async (_label, override, field) => {
    const env = fresh();
    const id = await makeProduct(env);
    const res = await record(env, id, {
      month: monthOffset(-1),
      provider: 'AWS',
      amount: 100,
      ...override,
    });
    expect(res.status).toBe(400);
    expect(res.json.fields[field]).toBeTruthy();
  });

  it('answers 404 for a product that does not exist', async () => {
    const env = fresh();
    const res = await record(env, 'nope', { month: monthOffset(-1), provider: 'AWS', amount: 1 });
    expect(res.status).toBe(404);
    expect((await api(env, 'GET', '/api/internal-products/nope/costs')).status).toBe(404);
  });

  it('removes a cost', async () => {
    const env = fresh();
    const id = await makeProduct(env);
    const made = await record(env, id, { month: monthOffset(-1), provider: 'AWS', amount: 100 });

    const res = await api(env, 'DELETE', `/api/internal-products/${id}/costs/${made.json.cost.id}`);
    expect(res.status).toBe(200);

    const list = await api(env, 'GET', `/api/internal-products/${id}/costs`);
    expect(list.json.costs).toHaveLength(0);
  });

  it("will not delete one product's cost through another product's URL", async () => {
    const env = fresh();
    const a = await makeProduct(env, 'A');
    const b = await makeProduct(env, 'B');
    const made = await record(env, a, { month: monthOffset(-1), provider: 'AWS', amount: 100 });

    const res = await api(env, 'DELETE', `/api/internal-products/${b}/costs/${made.json.cost.id}`);
    expect(res.status).toBe(404);

    const list = await api(env, 'GET', `/api/internal-products/${a}/costs`);
    expect(list.json.costs).toHaveLength(1);
  });

  it('refuses to remove a product that has cost history, and says what to do', async () => {
    const env = fresh();
    const id = await makeProduct(env);
    const made = await record(env, id, { month: monthOffset(-1), provider: 'AWS', amount: 100 });

    const blocked = await api(env, 'DELETE', `/api/internal-products/${id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe('has_costs');
    expect(blocked.json.message).toMatch(/Retired/);

    // The product and its history are both still there.
    expect((await api(env, 'GET', `/api/internal-products/${id}`)).status).toBe(200);

    // Once the costs are gone, removing it is allowed again.
    await api(env, 'DELETE', `/api/internal-products/${id}/costs/${made.json.cost.id}`);
    expect((await api(env, 'DELETE', `/api/internal-products/${id}`)).status).toBe(200);
  });

  it('writes what it did to the audit log', async () => {
    const env = fresh();
    const id = await makeProduct(env);
    const month = monthOffset(-1);
    const made = await record(env, id, { month, provider: 'AWS', amount: 12345 });
    await record(env, id, { month, provider: 'AWS', amount: 20000 });
    await api(env, 'DELETE', `/api/internal-products/${id}/costs/${made.json.cost.id}`);

    const audit = await api(env, 'GET', '/api/audit');
    const summaries = (audit.json.audit as Array<{ summary: string }>).map((a) => a.summary);
    expect(summaries.some((s) => s.startsWith('Recorded AWS for TRA'))).toBe(true);
    expect(summaries.some((s) => s.startsWith('Replaced AWS for TRA'))).toBe(true);
    expect(summaries.some((s) => s.startsWith('Removed AWS for TRA'))).toBe(true);
  });

  it('returns the usage estimate alongside the list', async () => {
    const env = fresh();
    // Report in USD so no exchange rate is needed to add these up.
    await api(env, 'PATCH', '/api/settings', { reporting_currency: 'USD' });
    const id = await makeProduct(env);

    await record(env, id, { month: monthOffset(-1), provider: 'AWS', amount: 30000 });
    await record(env, id, { month: monthOffset(-2), provider: 'AWS', amount: 10000 });

    const res = await api(env, 'GET', `/api/internal-products/${id}/costs`);
    expect(res.json.reporting_currency).toBe('USD');
    expect(res.json.usage.months_counted).toBe(2);
    expect(res.json.usage.average_reported).toBe(20000);
    expect(res.json.usage.latest_month_missing).toBe(false);

    await api(env, 'PATCH', '/api/settings', { reporting_currency: 'INR' });
  });

  it('shows up in the dashboard figures', async () => {
    const env = fresh();
    await api(env, 'PATCH', '/api/settings', { reporting_currency: 'USD' });
    const id = await makeProduct(env);
    await record(env, id, { month: monthOffset(-1), provider: 'AWS', amount: 50000 });

    const res = await api(env, 'GET', '/api/ceo-summary');
    const product = res.json.products.find((p: { product: { id: string } }) => p.product.id === id);
    expect(product.usage_monthly_reported).toBe(50000);
    expect(product.monthly_reported).toBe(50000);
    expect(res.json.internal.usage_annual_reported).toBeGreaterThanOrEqual(50000 * 12);

    await api(env, 'PATCH', '/api/settings', { reporting_currency: 'INR' });
  });

  it('asks for exchange rates in a currency that only appears on a recorded cost', async () => {
    const env = fresh();
    const id = await makeProduct(env);
    await record(env, id, { month: monthOffset(-1), provider: 'AWS', amount: 100, currency: 'SGD' });

    const res = await api(env, 'GET', '/api/fx/status');
    // Without this the cost would sit in the ledger with no rate to convert it
    // and be quietly left out of every total.
    expect(res.json.currencies_in_use).toContain('SGD');
  });
});
