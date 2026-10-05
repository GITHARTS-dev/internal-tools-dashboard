import { beforeEach, describe, expect, it } from 'vitest';
import { paymentsToSchedule, schedulingHorizon } from '../src/shared/schedule';
import { runReminders } from '../src/server/reminders';
import { createTool } from '../src/server/repo/tools';
import { createPayment, deletePayment, listPayments, markPaid } from '../src/server/repo/payments';
import { listAuditForEntity } from '../src/server/repo/audit';
import { updateSettings } from '../src/server/repo/settings';
import type { Channel } from '../src/server/notify/types';
import type { Db } from '../src/server/repo/db';
import { makePayment, makeTool, settings } from './helpers';
import { api, testDb, testEnv } from './db-helper';

const TODAY = '2026-10-05';
const monthly = (overrides = {}) =>
  makeTool({ billing_cycle: 'monthly', cost_amount: 2000, currency: 'USD', renewal_date: '2026-10-20', ...overrides });

describe('paymentsToSchedule', () => {
  it('schedules a bill due later this month at the tool’s current cost', () => {
    const [plan, ...rest] = paymentsToSchedule([monthly()], [], settings(), TODAY);
    expect(rest).toHaveLength(0);
    expect(plan).toMatchObject({
      due_date: '2026-10-20',
      period_start: '2026-10-20',
      period_end: '2026-11-20',
      amount: 2000,
      currency: 'USD',
      already_in_ledger: false,
    });
  });

  it('waits for next month’s bill until it enters the payment reminder window', () => {
    const tool = monthly({ renewal_date: '2026-11-03' });
    expect(paymentsToSchedule([tool], [], settings(), TODAY)).toHaveLength(0);
    // Seven days out, so its 7-day reminder can still fire.
    expect(paymentsToSchedule([tool], [], settings(), '2026-10-27')).toHaveLength(1);
    expect(schedulingHorizon(settings(), '2026-10-27')).toBe('2026-11-03');
  });

  it('rolls a stale renewal date forward for a tool that renews by itself', () => {
    const [plan] = paymentsToSchedule([monthly({ renewal_date: '2026-01-20' })], [], settings(), TODAY);
    expect(plan?.due_date).toBe('2026-10-20');
  });

  it('schedules tools that do not auto-renew too, up to their renewal date', () => {
    expect(paymentsToSchedule([monthly({ auto_renew: false })], [], settings(), TODAY)).toHaveLength(1);
    // Past it, the tool has lapsed: nothing to bill.
    expect(
      paymentsToSchedule([monthly({ auto_renew: false, renewal_date: '2026-09-20' })], [], settings(), TODAY),
    ).toHaveLength(0);
  });

  it('skips tools with no cost, no renewal date, or that are not live', () => {
    const tools = [
      monthly({ id: 'a', cost_amount: null }),
      monthly({ id: 'b', renewal_date: null }),
      monthly({ id: 'c', status: 'cancelled' }),
      monthly({ id: 'd', status: 'expired' }),
      monthly({ id: 'e', deleted_at: '2026-10-01T00:00:00.000Z' }),
    ];
    expect(paymentsToSchedule(tools, [], settings(), TODAY)).toHaveLength(0);
  });

  it('does not schedule a due date the job has already handled', () => {
    const tool = monthly({ payments_scheduled_through: '2026-10-20' });
    expect(paymentsToSchedule([tool], [], settings(), TODAY)).toHaveLength(0);
  });

  it('treats a payment already due that month as this bill', () => {
    const existing = makePayment({ due_date: '2026-10-18', period_start: '2026-10-18' });
    const [plan] = paymentsToSchedule([monthly()], [existing], settings(), TODAY);
    expect(plan?.already_in_ledger).toBe(true);
  });
});

describe('the daily run schedules payments', () => {
  let db: Db;
  const env = { APP_ENV: 'test' };
  const silent: Channel[] = [];

  beforeEach(async () => {
    ({ db } = testDb());
    await updateSettings(db, { timezone: 'Asia/Kolkata' });
  });

  async function claude() {
    return createTool(db, {
      name: 'Claude',
      category: 'AI',
      status: 'active',
      billing_cycle: 'monthly',
      cost_amount: 2000,
      currency: 'USD',
      renewal_date: '2026-10-20',
      auto_renew: true,
      cancellation_notice_days: 0,
    } as never);
  }

  it('adds the bill once, with an audit entry, and reports it', async () => {
    const tool = await claude();
    const run = await runReminders(db, env, { today: TODAY, channels: silent });

    expect(run.scheduled_payments).toEqual([
      { tool_id: tool.id, tool_name: 'Claude', due_date: '2026-10-20', amount: 2000, currency: 'USD' },
    ]);
    const [payment, ...rest] = await listPayments(db, { toolId: tool.id });
    expect(rest).toHaveLength(0);
    expect(payment).toMatchObject({ due_date: '2026-10-20', amount: 2000, status: 'due' });

    const audit = await listAuditForEntity(db, 'payment', payment!.id);
    expect(audit[0]?.actor).toBe('system');

    // The next morning finds it already there.
    const again = await runReminders(db, env, { today: '2026-10-06', channels: silent });
    expect(again.scheduled_payments).toHaveLength(0);
    expect(await listPayments(db, { toolId: tool.id })).toHaveLength(1);
  });

  it('does not bring back a payment someone removed', async () => {
    const tool = await claude();
    await runReminders(db, env, { today: TODAY, channels: silent });
    const [payment] = await listPayments(db, { toolId: tool.id });
    await deletePayment(db, payment!.id);

    await runReminders(db, env, { today: '2026-10-06', channels: silent });
    expect(await listPayments(db, { toolId: tool.id })).toHaveLength(0);
  });

  it('adds next month’s bill once this one is paid and the next comes into view', async () => {
    const tool = await claude();
    await runReminders(db, env, { today: TODAY, channels: silent });
    const [october] = await listPayments(db, { toolId: tool.id });
    await markPaid(db, october!.id, { paid_on: '2026-10-20' });

    await runReminders(db, env, { today: '2026-11-01', channels: silent });
    const dues = (await listPayments(db, { toolId: tool.id })).map((p) => p.due_date);
    expect(dues).toEqual(['2026-11-20', '2026-10-20']);
  });

  it('leaves a payment someone added by hand for that month alone', async () => {
    const tool = await claude();
    await createPayment(db, { tool_id: tool.id, due_date: '2026-10-19', amount: 2000, currency: 'USD', status: 'due' } as never);

    const run = await runReminders(db, env, { today: TODAY, channels: silent });
    expect(run.scheduled_payments).toHaveLength(0);
    expect(await listPayments(db, { toolId: tool.id })).toHaveLength(1);
  });

  it('previews the bill in a dry run without writing it, and its reminder with it', async () => {
    const tool = await claude();
    const run = await runReminders(db, env, { today: '2026-10-13', channels: silent, dryRun: true });

    expect(run.scheduled_payments).toHaveLength(1);
    expect(run.alerts.some((a) => a.rule === 'payment_due_soon' && a.tool_id === tool.id)).toBe(true);
    expect(await listPayments(db, { toolId: tool.id })).toHaveLength(0);
  });
});

describe('a price change reaches unpaid payments', () => {
  it('treats a cost typed into the edit form as a price change from today', async () => {
    const { db } = testDb();
    const env = testEnv(db);
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
    const toolId = created.json.tool.id;
    const add = (due_date: string, amount: number, status = 'due') =>
      createPayment(db, { tool_id: toolId, due_date, amount, currency: 'USD', status } as never);

    const upcoming = await add('2099-01-20', 2000);
    const paid = await add('2098-12-20', 2000, 'paid');
    const overdue = await add('2000-01-20', 2000);
    const later = await add('2099-02-20', 2150);

    const res = await api(env, 'PATCH', `/api/tools/${toolId}`, { cost_amount: 2200 });
    expect(res.status).toBe(200);

    const amounts = Object.fromEntries((await listPayments(db, { toolId })).map((p) => [p.id, p.amount]));
    expect(amounts[upcoming.id]).toBe(2200);
    expect(amounts[paid.id]).toBe(2000);
    expect(amounts[overdue.id]).toBe(2000);
    expect(amounts[later.id]).toBe(2200);

    const audit = await listAuditForEntity(db, 'payment', upcoming.id);
    expect(audit[0]?.summary).toBe("Repriced with Claude's new price");

    const detail = await api(env, 'GET', `/api/tools/${toolId}`);
    expect(detail.json.price_changes).toHaveLength(1);
    expect(detail.json.price_changes[0]).toMatchObject({ amount: 2200, previous_amount: 2000 });
  });
});
