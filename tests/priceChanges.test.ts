import { beforeEach, describe, expect, it } from 'vitest';
import { priceOn } from '../src/shared/prices';
import { paymentsToSchedule } from '../src/shared/schedule';
import { runReminders } from '../src/server/reminders';
import { createPayment, listPayments } from '../src/server/repo/payments';
import { getTool } from '../src/server/repo/tools';
import type { Db } from '../src/server/repo/db';
import type { PriceChange } from '../src/shared/types';
import { makeTool, settings } from './helpers';
import { api, testDb, testEnv } from './db-helper';

function change(overrides: Partial<PriceChange>): PriceChange {
  return {
    id: 'c1',
    tool_id: 't1',
    effective_from: '2026-11-01',
    amount: 2200,
    currency: 'USD',
    previous_amount: 2000,
    previous_currency: 'USD',
    note: null,
    changed_by: 'priya@example.com',
    created_at: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('priceOn', () => {
  const tool = makeTool({ cost_amount: 2000, currency: 'USD' });

  it('uses the tool’s cost when no change was ever recorded', () => {
    expect(priceOn(tool, [], '2026-12-01')).toEqual({ amount: 2000, currency: 'USD' });
  });

  it('uses the price a change replaced for dates before it, and the new one from its start', () => {
    const changes = [change({})];
    expect(priceOn(tool, changes, '2026-10-31')).toEqual({ amount: 2000, currency: 'USD' });
    expect(priceOn(tool, changes, '2026-11-01')).toEqual({ amount: 2200, currency: 'USD' });
  });

  it('keeps each price until the next change', () => {
    const changes = [
      change({ id: 'b', effective_from: '2027-05-01', amount: 2500, previous_amount: 2200 }),
      change({ id: 'a' }),
    ];
    expect(priceOn(tool, changes, '2027-04-30')?.amount).toBe(2200);
    expect(priceOn(tool, changes, '2027-05-01')?.amount).toBe(2500);
  });

  it('prices the scheduled bill at the price on its due date', () => {
    const t = makeTool({ billing_cycle: 'monthly', cost_amount: 2000, currency: 'USD', renewal_date: '2026-11-03' });
    const [plan] = paymentsToSchedule([t], [], settings(), '2026-10-28', [change({})]);
    expect(plan?.amount).toBe(2200);
  });
});

describe('changing a price', () => {
  let db: Db;
  let env: ReturnType<typeof testEnv>;
  let toolId: string;

  beforeEach(async () => {
    ({ db } = testDb());
    env = testEnv(db);
    const created = await api(env, 'POST', '/api/tools', {
      name: 'Claude',
      category: 'AI',
      status: 'active',
      billing_cycle: 'monthly',
      cost_amount: 2000,
      currency: 'USD',
      renewal_date: '2099-01-20',
      auto_renew: true,
      cancellation_notice_days: 0,
    });
    toolId = created.json.tool.id;
  });

  const add = (due_date: string, amount = 2000, status = 'due') =>
    createPayment(db, { tool_id: toolId, due_date, amount, currency: 'USD', status } as never);
  const amounts = async () =>
    Object.fromEntries((await listPayments(db, { toolId })).map((p) => [p.due_date, p.amount]));

  it('reprices unpaid bills from the start date on, and nothing before it or already paid', async () => {
    await add('2098-12-20', 2000, 'paid');
    await add('2099-01-20');
    await add('2099-02-20');
    await add('2099-03-20', 2000, 'paid');

    const res = await api(env, 'POST', `/api/tools/${toolId}/price-changes`, {
      amount: 2200,
      effective_from: '2099-02-01',
      note: 'Vendor email',
    });
    expect(res.status).toBe(201);
    expect(res.json.repriced).toBe(1);
    expect(res.json.price_change).toMatchObject({
      amount: 2200,
      currency: 'USD',
      previous_amount: 2000,
      note: 'Vendor email',
    });

    expect(await amounts()).toEqual({
      '2098-12-20': 2000,
      '2099-01-20': 2000,
      '2099-02-20': 2200,
      '2099-03-20': 2000,
    });
  });

  it('leaves today’s cost alone for a change that starts in the future', async () => {
    await api(env, 'POST', `/api/tools/${toolId}/price-changes`, { amount: 2200, effective_from: '2099-02-01' });
    expect((await getTool(db, toolId))?.cost_amount).toBe(2000);
  });

  it('moves today’s cost for a change that has already started', async () => {
    await api(env, 'POST', `/api/tools/${toolId}/price-changes`, { amount: 2200, effective_from: '2020-01-01' });
    expect((await getTool(db, toolId))?.cost_amount).toBe(2200);
  });

  it('keeps an earlier bill at its price when a later change is added', async () => {
    await add('2099-02-20');
    await add('2099-06-20');
    await api(env, 'POST', `/api/tools/${toolId}/price-changes`, { amount: 2200, effective_from: '2099-02-01' });
    await api(env, 'POST', `/api/tools/${toolId}/price-changes`, { amount: 2500, effective_from: '2099-06-01' });

    expect(await amounts()).toEqual({ '2099-02-20': 2200, '2099-06-20': 2500 });
    const detail = await api(env, 'GET', `/api/tools/${toolId}`);
    expect(detail.json.price_changes.map((c: PriceChange) => c.previous_amount)).toEqual([2000, 2200]);
  });

  it('corrects rather than duplicates a change entered again for the same date', async () => {
    await add('2099-02-20');
    await api(env, 'POST', `/api/tools/${toolId}/price-changes`, { amount: 2300, effective_from: '2099-02-01' });
    await api(env, 'POST', `/api/tools/${toolId}/price-changes`, { amount: 2200, effective_from: '2099-02-01' });

    const detail = await api(env, 'GET', `/api/tools/${toolId}`);
    expect(detail.json.price_changes).toHaveLength(1);
    expect(detail.json.price_changes[0]).toMatchObject({ amount: 2200, previous_amount: 2000 });
    expect(await amounts()).toEqual({ '2099-02-20': 2200 });
  });

  it('refuses a price with no start date or a negative amount', async () => {
    const noDate = await api(env, 'POST', `/api/tools/${toolId}/price-changes`, { amount: 2200 });
    expect(noDate.status).toBe(400);
    const negative = await api(env, 'POST', `/api/tools/${toolId}/price-changes`, {
      amount: -1,
      effective_from: '2099-02-01',
    });
    expect(negative.status).toBe(400);
  });

  it('takes effect in the daily run on its start date, and bills at it from then on', async () => {
    await api(env, 'PATCH', `/api/tools/${toolId}`, { renewal_date: '2099-11-20' });
    await api(env, 'POST', `/api/tools/${toolId}/price-changes`, { amount: 2200, effective_from: '2099-11-15' });

    // The bill due 20 Nov comes into view in November, priced at the new rate.
    const run = await runReminders(db, { APP_ENV: 'test' }, { today: '2099-11-01', channels: [] });
    expect(run.scheduled_payments).toMatchObject([{ due_date: '2099-11-20', amount: 2200 }]);
    expect((await getTool(db, toolId))?.cost_amount).toBe(2000);

    await runReminders(db, { APP_ENV: 'test' }, { today: '2099-11-15', channels: [] });
    expect((await getTool(db, toolId))?.cost_amount).toBe(2200);
  });
});
