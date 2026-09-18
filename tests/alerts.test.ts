import { describe, expect, it } from 'vitest';
import { computeAlerts, effectiveRenewalDate, isNotifiable } from '../src/shared/alerts';
import type { Alert, AlertRule } from '../src/shared/types';
import { makePayment, makeTool, settings } from './helpers';

const TODAY = '2026-09-18';

function rules(alerts: Alert[]): AlertRule[] {
  return alerts.map((a) => a.rule);
}

function forRule(alerts: Alert[], rule: AlertRule): Alert[] {
  return alerts.filter((a) => a.rule === rule);
}

/** A tool with every field populated, so only the field under test can fire. */
function cleanTool(overrides = {}) {
  return makeTool({
    cancellation_notice_days: 0,
    seats_purchased: 5,
    seats_used: 5,
    renewal_date: '2027-06-01',
    ...overrides,
  });
}

describe('payment alerts', () => {
  it('flags an unpaid payment past its due date as critical', () => {
    const tool = cleanTool();
    const payment = makePayment({ due_date: '2026-09-10', status: 'due' });
    const alerts = computeAlerts([tool], [payment], settings(), TODAY);

    const overdue = forRule(alerts, 'payment_overdue');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.severity).toBe('critical');
    expect(overdue[0]!.days_until).toBe(-8);
    expect(overdue[0]!.payment_id).toBe('p1');
    expect(overdue[0]!.detail).toContain('8 days ago');
  });

  it('does not flag payments that are paid or waived', () => {
    const tool = cleanTool();
    const paid = makePayment({ id: 'p1', due_date: '2026-09-10', status: 'paid', paid_on: '2026-09-09' });
    const waived = makePayment({ id: 'p2', due_date: '2026-09-10', status: 'waived' });
    const alerts = computeAlerts([tool], [paid, waived], settings(), TODAY);
    expect(forRule(alerts, 'payment_overdue')).toHaveLength(0);
  });

  it('re-raises an overdue payment weekly rather than every morning', () => {
    const tool = cleanTool();
    const payment = makePayment({ due_date: '2026-09-10' });
    const keyOn = (today: string) =>
      forRule(computeAlerts([tool], [payment], settings(), today), 'payment_overdue')[0]!.dedupe_key;

    // Days 1-6 overdue share a key, so only the first send goes out.
    expect(keyOn('2026-09-11')).toBe(keyOn('2026-09-14'));
    expect(keyOn('2026-09-11')).toBe(keyOn('2026-09-16'));
    // Day 7 starts a new week and notifies again.
    expect(keyOn('2026-09-17')).not.toBe(keyOn('2026-09-11'));
  });

  it('warns ahead of the due date at each configured lead step', () => {
    const tool = cleanTool();
    const payment = makePayment({ due_date: '2026-09-25' }); // 7 days out
    const alerts = computeAlerts([tool], [payment], settings(), TODAY);

    const dueSoon = forRule(alerts, 'payment_due_soon');
    expect(dueSoon).toHaveLength(1);
    expect(dueSoon[0]!.days_until).toBe(7);
    expect(dueSoon[0]!.dedupe_key).toBe('payment_due_soon:p1:7');
  });

  it('holds one key per lead step, so each step notifies exactly once', () => {
    const tool = cleanTool();
    const payment = makePayment({ due_date: '2026-09-25' });
    const keyOn = (today: string) => {
      const a = forRule(computeAlerts([tool], [payment], settings(), today), 'payment_due_soon');
      return a.length > 0 ? a[0]!.dedupe_key : null;
    };

    expect(keyOn('2026-09-17')).toBeNull(); // 8 days out: outside the widest lead
    expect(keyOn('2026-09-18')).toBe('payment_due_soon:p1:7'); // 7 days
    expect(keyOn('2026-09-20')).toBe('payment_due_soon:p1:7'); // 5 days, same step
    expect(keyOn('2026-09-22')).toBe('payment_due_soon:p1:3'); // 3 days, new step
    expect(keyOn('2026-09-23')).toBe('payment_due_soon:p1:3'); // 2 days, same step
    expect(keyOn('2026-09-24')).toBe('payment_due_soon:p1:1'); // tomorrow
    expect(keyOn('2026-09-25')).toBe('payment_due_soon:p1:0'); // due today
  });

  it('still chases a bill for a cancelled tool', () => {
    // The final invoice after cancelling is exactly the one people forget.
    const tool = cleanTool({ status: 'cancelled', cancelled_on: '2026-09-01' });
    const payment = makePayment({ due_date: '2026-09-10' });
    const alerts = computeAlerts([tool], [payment], settings(), TODAY);

    expect(forRule(alerts, 'payment_overdue')).toHaveLength(1);
    // ...but a cancelled tool gets no renewal or data-quality nagging.
    expect(forRule(alerts, 'renewal_upcoming')).toHaveLength(0);
    expect(forRule(alerts, 'missing_data')).toHaveLength(0);
  });

  it('ignores a payment whose tool no longer exists', () => {
    const alerts = computeAlerts([], [makePayment({ due_date: '2026-09-10' })], settings(), TODAY);
    expect(alerts).toHaveLength(0);
  });
});

describe('renewal alerts', () => {
  it('warns at the configured lead steps before renewal', () => {
    const tool = cleanTool({ renewal_date: '2026-10-18' }); // 30 days out
    const alerts = computeAlerts([tool], [], settings(), TODAY);

    const renewal = forRule(alerts, 'renewal_upcoming');
    expect(renewal).toHaveLength(1);
    expect(renewal[0]!.days_until).toBe(30);
    expect(renewal[0]!.dedupe_key).toBe('renewal_upcoming:t1:2026-10-18:30');
  });

  it('stays quiet outside the widest lead window', () => {
    const tool = cleanTool({ renewal_date: '2027-06-01' });
    expect(forRule(computeAlerts([tool], [], settings(), TODAY), 'renewal_upcoming')).toHaveLength(0);
  });

  it('rolls a stale auto-renew date forward instead of screaming "overdue"', () => {
    // A monthly tool set up in January that nobody has touched since.
    const tool = cleanTool({ renewal_date: '2026-01-20', billing_cycle: 'monthly', auto_renew: true });
    expect(effectiveRenewalDate(tool, TODAY)).toBe('2026-09-20');

    const renewal = forRule(computeAlerts([tool], [], settings(), TODAY), 'renewal_upcoming');
    expect(renewal).toHaveLength(1);
    expect(renewal[0]!.days_until).toBe(2);
  });

  it('includes the renewal date in the key so the next cycle notifies again', () => {
    const tool = cleanTool({ renewal_date: '2026-01-20', billing_cycle: 'monthly' });
    const sep = forRule(computeAlerts([tool], [], settings(), '2026-09-18'), 'renewal_upcoming')[0]!;
    const oct = forRule(computeAlerts([tool], [], settings(), '2026-10-18'), 'renewal_upcoming')[0]!;
    expect(sep.dedupe_key).not.toBe(oct.dedupe_key);
  });

  it('treats a lapsed non-auto-renew date as a data problem, not a renewal', () => {
    const tool = cleanTool({ renewal_date: '2026-08-01', auto_renew: false });
    const alerts = computeAlerts([tool], [], settings(), TODAY);

    expect(forRule(alerts, 'renewal_upcoming')).toHaveLength(0);
    const stale = forRule(alerts, 'missing_data').filter((a) => a.dedupe_key.includes('stale_renewal'));
    expect(stale).toHaveLength(1);
    expect(stale[0]!.detail).toContain('not set to auto-renew');
  });
});

describe('cancellation notice deadlines', () => {
  it('warns before the last day to cancel', () => {
    // Renews in 37 days with 30 days' notice: 7 days left to decide.
    const tool = cleanTool({ renewal_date: '2026-10-25', cancellation_notice_days: 30 });
    const alerts = computeAlerts([tool], [], settings(), TODAY);

    const notice = forRule(alerts, 'notice_deadline');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.days_until).toBe(7);
    expect(notice[0]!.date).toBe('2026-09-25');
    expect(notice[0]!.detail).toContain('cancel by 25 Sep 2026');
  });

  it('escalates to critical in the last three days', () => {
    const tool = cleanTool({ renewal_date: '2026-10-20', cancellation_notice_days: 30 });
    const notice = forRule(computeAlerts([tool], [], settings(), TODAY), 'notice_deadline');
    expect(notice[0]!.days_until).toBe(2);
    expect(notice[0]!.severity).toBe('critical');
  });

  it('says plainly when the window has already closed', () => {
    const tool = cleanTool({ renewal_date: '2026-10-05', cancellation_notice_days: 30 });
    const notice = forRule(computeAlerts([tool], [], settings(), TODAY), 'notice_deadline');

    expect(notice).toHaveLength(1);
    expect(notice[0]!.dedupe_key).toContain(':passed');
    expect(notice[0]!.title).toContain('can no longer be cancelled');
  });

  it('does not apply to tools that do not auto-renew', () => {
    const tool = cleanTool({ renewal_date: '2026-10-25', cancellation_notice_days: 30, auto_renew: false });
    expect(forRule(computeAlerts([tool], [], settings(), TODAY), 'notice_deadline')).toHaveLength(0);
  });

  it('does not apply when no notice period is recorded', () => {
    const tool = cleanTool({ renewal_date: '2026-10-25', cancellation_notice_days: 0 });
    expect(forRule(computeAlerts([tool], [], settings(), TODAY), 'notice_deadline')).toHaveLength(0);
  });
});

describe('data quality alerts', () => {
  it('names every missing field in one alert', () => {
    const tool = cleanTool({ owner_name: null, owner_email: null, cost_amount: null, renewal_date: null });
    const gaps = forRule(computeAlerts([tool], [], settings(), TODAY), 'missing_data');

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.detail).toContain('no owner');
    expect(gaps[0]!.detail).toContain('no cost');
    expect(gaps[0]!.detail).toContain('no renewal date');
  });

  it('accepts an owner identified by either name or email', () => {
    const byEmail = cleanTool({ owner_name: null, owner_email: 'a@example.com' });
    expect(forRule(computeAlerts([byEmail], [], settings(), TODAY), 'missing_data')).toHaveLength(0);

    const byName = cleanTool({ owner_name: 'Priya', owner_email: null });
    expect(forRule(computeAlerts([byName], [], settings(), TODAY), 'missing_data')).toHaveLength(0);
  });

  it('re-raises monthly rather than daily', () => {
    const tool = cleanTool({ cost_amount: null });
    const keyOn = (d: string) => forRule(computeAlerts([tool], [], settings(), d), 'missing_data')[0]!.dedupe_key;
    expect(keyOn('2026-09-18')).toBe(keyOn('2026-09-29'));
    expect(keyOn('2026-09-18')).not.toBe(keyOn('2026-10-01'));
  });
});

describe('unused seat alerts', () => {
  it('flags a tool whose seats are mostly idle', () => {
    const tool = cleanTool({ seats_purchased: 10, seats_used: 4, cost_amount: 500000, billing_cycle: 'monthly' });
    const seats = forRule(computeAlerts([tool], [], settings(), TODAY), 'seats_underused');

    expect(seats).toHaveLength(1);
    expect(seats[0]!.severity).toBe('info');
    expect(seats[0]!.title).toContain('6 unused seats');
    expect(seats[0]!.detail).toContain('₹3,000.00');
  });

  it('says "seat" rather than "seats" for a single idle seat', () => {
    const tool = cleanTool({ seats_purchased: 10, seats_used: 9, cost_amount: 500000 });
    const s = settings({ seat_underuse_ratio: 0.95 });
    expect(forRule(computeAlerts([tool], [], s, TODAY), 'seats_underused')[0]!.title).toContain('1 unused seat');
  });

  it('stays quiet when seats are well used or unknown', () => {
    const wellUsed = cleanTool({ seats_purchased: 10, seats_used: 9 });
    expect(forRule(computeAlerts([wellUsed], [], settings(), TODAY), 'seats_underused')).toHaveLength(0);

    const unknown = cleanTool({ seats_purchased: 10, seats_used: null });
    expect(forRule(computeAlerts([unknown], [], settings(), TODAY), 'seats_underused')).toHaveLength(0);
  });

  it('is only pushed to Teams/email when a renewal is close enough to act on', () => {
    const far = cleanTool({ seats_purchased: 10, seats_used: 4, renewal_date: '2027-06-01' });
    const soon = cleanTool({ seats_purchased: 10, seats_used: 4, renewal_date: '2026-10-18' });

    expect(isNotifiable(forRule(computeAlerts([far], [], settings(), TODAY), 'seats_underused')[0]!)).toBe(false);
    expect(isNotifiable(forRule(computeAlerts([soon], [], settings(), TODAY), 'seats_underused')[0]!)).toBe(true);
  });
});

describe('ordering and identity', () => {
  it('puts the most urgent alert first', () => {
    const overdueTool = cleanTool({ id: 't1', name: 'Zoom' });
    const renewingTool = cleanTool({ id: 't2', name: 'Adobe', renewal_date: '2026-10-18' });
    const payment = makePayment({ tool_id: 't1', due_date: '2026-09-01' });

    const alerts = computeAlerts([renewingTool, overdueTool], [payment], settings(), TODAY);
    expect(alerts[0]!.rule).toBe('payment_overdue');
    expect(alerts[0]!.severity).toBe('critical');
  });

  it('gives every alert in a run a distinct dedupe key', () => {
    const tools = [
      cleanTool({ id: 't1', name: 'Canva', renewal_date: '2026-10-18', cancellation_notice_days: 14 }),
      cleanTool({ id: 't2', name: 'M365', cost_amount: null, seats_purchased: 10, seats_used: 2 }),
      cleanTool({ id: 't3', name: 'Clockify', renewal_date: '2026-09-21' }),
    ];
    const payments = [
      makePayment({ id: 'p1', tool_id: 't1', due_date: '2026-09-01' }),
      makePayment({ id: 'p2', tool_id: 't3', due_date: '2026-09-21' }),
    ];

    const alerts = computeAlerts(tools, payments, settings(), TODAY);
    const keys = alerts.map((a) => a.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(alerts.length).toBeGreaterThan(4);
  });

  it('produces nothing at all for a clean, quiet portfolio', () => {
    const alerts = computeAlerts([cleanTool()], [], settings(), TODAY);
    expect(rules(alerts)).toEqual([]);
  });

  it('honours custom lead-day settings', () => {
    const tool = cleanTool({ renewal_date: '2026-09-23' }); // 5 days out
    expect(forRule(computeAlerts([tool], [], settings({ renewal_lead_days: [3] }), TODAY), 'renewal_upcoming')).toHaveLength(0);
    expect(forRule(computeAlerts([tool], [], settings({ renewal_lead_days: [10] }), TODAY), 'renewal_upcoming')).toHaveLength(1);
  });
});
