import { describe, expect, it } from 'vitest';
import { computeCeoSummary } from '../src/shared/ceo';
import { computeRenewalTimeline } from '../src/shared/metrics';
import { rateTable, type FxRate } from '../src/shared/fx';
import type { InternalProduct, Payment, ProductCost, Tool } from '../src/shared/types';

/**
 * The extra figures behind the dashboard's charts: the trend split into
 * subscriptions and cloud usage, which tools the idle seats are in, and each
 * auto-renewing tool's last day to cancel.
 */

const TODAY = '2026-09-19';

const rate = (currency: string, value: string, month: string): FxRate => ({
  month, currency, rate: value, source: 'ecb', fetched_at: '2026-01-01T00:00:00.000Z',
});

const TABLES = {
  '2026-07': rateTable([rate('USD', '1.00', '2026-07'), rate('INR', '100.0', '2026-07')]),
  '2026-08': rateTable([rate('USD', '1.00', '2026-08'), rate('INR', '100.0', '2026-08')]),
};

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: 't1', name: 'Tool', vendor: null, category: 'Other', status: 'active',
    owner_name: null, owner_email: null, department: null,
    billing_cycle: 'monthly', cost_amount: 100_00, currency: 'USD',
    seats_purchased: null, seats_used: null, renewal_date: null, auto_renew: true,
    cancellation_notice_days: 0, account_ref: null, billing_email: null,
    payment_method: null, vendor_url: null, notes: null,
    started_on: null, cancelled_on: null, internal_product_id: null,
    created_at: '', updated_at: '', deleted_at: null, deleted_by: null,
    ...over,
  };
}

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: 'p1', tool_id: 't1', period_start: null, period_end: null,
    due_date: '2026-08-01', amount: 100_00, currency: 'USD', status: 'paid',
    paid_on: '2026-08-05', paid_by: null, invoice_ref: null, invoice_url: null,
    notes: null, created_at: '', updated_at: '',
    ...over,
  };
}

const product: InternalProduct = {
  id: 'prod1', name: 'TRA', description: null, status: 'live',
  owner_name: null, owner_email: null, launched_on: null, retired_on: null,
  notes: null, created_at: '', updated_at: '',
};

function cost(over: Partial<ProductCost> = {}): ProductCost {
  return {
    id: 'c1', product_id: 'prod1', month: '2026-08', provider: 'AWS',
    amount: 300_00, currency: 'USD', source: 'manual', note: null,
    created_at: '', updated_at: '',
    ...over,
  };
}

const base = { tables: TABLES, reportingCurrency: 'USD', today: TODAY, products: [] as InternalProduct[] };

describe('the monthly trend, split', () => {
  it('keeps subscriptions and cloud usage apart, and adds them for the total', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product],
      tools: [tool()],
      payments: [payment({ paid_on: '2026-08-05', amount: 100_00 })],
      monthlyCosts: [cost({ month: '2026-08', amount: 300_00 })],
    });

    const august = result.paid_by_month.find((m) => m.month === '2026-08')!;
    expect(august.subscriptions).toBe(100_00);
    expect(august.usage).toBe(300_00);
    // The total is the two of them, so the chart's stack and its tooltip agree.
    expect(august.amount).toBe(400_00);
  });

  it('is all subscriptions when no usage has been recorded', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [tool()],
      payments: [payment()],
    });
    const august = result.paid_by_month.find((m) => m.month === '2026-08')!;
    expect(august.usage).toBe(0);
    expect(august.subscriptions).toBe(100_00);
  });

  it('is zero in both series for a month with nothing paid', () => {
    const result = computeCeoSummary({ ...base, tools: [], payments: [] });
    expect(result.paid_by_month.every((m) => m.subscriptions === 0 && m.usage === 0)).toBe(true);
    expect(result.paid_by_month).toHaveLength(24);
  });

  it('converts each series at its own months rate', () => {
    // 100 dollars is 10,000 rupees in July and August alike under these tables,
    // so an unconverted number sneaking through would show as 100.00, not 10,000.
    const result = computeCeoSummary({
      ...base,
      reportingCurrency: 'INR',
      products: [product],
      tools: [tool()],
      payments: [payment({ paid_on: '2026-07-05', amount: 100_00 })],
      monthlyCosts: [cost({ month: '2026-07', amount: 100_00 })],
    });
    const july = result.paid_by_month.find((m) => m.month === '2026-07')!;
    expect(july.subscriptions).toBe(10_000_00);
    expect(july.usage).toBe(10_000_00);
  });
});

describe('idle seats, by tool', () => {
  const seats = (id: string, name: string, cost_amount: number, purchased: number, used: number) =>
    tool({ id, name, cost_amount, seats_purchased: purchased, seats_used: used, billing_cycle: 'annual' });

  it('ranks the tools by the annual value of their idle seats', () => {
    const result = computeCeoSummary({
      ...base,
      payments: [],
      tools: [
        seats('a', 'Small', 1000_00, 10, 5), // 500 idle
        seats('b', 'Big', 10_000_00, 10, 2), // 8000 idle
        seats('c', 'Middle', 4000_00, 10, 5), // 2000 idle
      ],
    });

    expect(result.idle_tools.map((t) => t.label)).toEqual(['Big', 'Middle', 'Small']);
    expect(result.idle_tools[0]).toMatchObject({ seats_purchased: 10, seats_used: 2, annual_reported: 8000_00 });
  });

  it('leaves out a tool whose seats are all in use, or whose seat data is missing', () => {
    const result = computeCeoSummary({
      ...base,
      payments: [],
      tools: [
        seats('a', 'Full', 1000_00, 10, 10),
        tool({ id: 'b', name: 'Unknown', seats_purchased: null, seats_used: null }),
        tool({ id: 'c', name: 'Purchased only', seats_purchased: 10, seats_used: null }),
      ],
    });
    expect(result.idle_tools).toEqual([]);
  });

  it('shows the five biggest and no more', () => {
    const tools = Array.from({ length: 8 }, (_, i) => seats(`t${i}`, `Tool ${i}`, (i + 1) * 1000_00, 10, 5));
    const result = computeCeoSummary({ ...base, payments: [], tools });
    expect(result.idle_tools).toHaveLength(5);
    expect(result.idle_tools[0]!.label).toBe('Tool 7');
  });

  it('agrees with the headline idle cost when everything is listed', () => {
    const result = computeCeoSummary({
      ...base,
      payments: [],
      tools: [seats('a', 'A', 1000_00, 10, 5), seats('b', 'B', 2000_00, 10, 5)],
    });
    const listed = result.idle_tools.reduce((sum, t) => sum + t.annual_reported, 0);
    expect(listed).toBe(result.idle_seat_cost);
  });
});

describe('the renewal timeline and its cancellation window', () => {
  it('puts the last day to cancel the notice period before the renewal', () => {
    const [entry] = computeRenewalTimeline(
      [tool({ renewal_date: '2026-10-19', auto_renew: true, cancellation_notice_days: 30 })],
      TODAY,
    );
    expect(entry!.date).toBe('2026-10-19');
    expect(entry!.notice_date).toBe('2026-09-19');
    expect(entry!.notice_days_until).toBe(0);
  });

  it('has no deadline for a tool that will not auto-renew', () => {
    const [entry] = computeRenewalTimeline(
      [tool({ renewal_date: '2026-10-19', auto_renew: false, cancellation_notice_days: 30 })],
      TODAY,
    );
    expect(entry!.notice_date).toBeNull();
    expect(entry!.notice_days_until).toBeNull();
  });

  it('has no deadline for a tool that asks for no notice', () => {
    const [entry] = computeRenewalTimeline(
      [tool({ renewal_date: '2026-10-19', auto_renew: true, cancellation_notice_days: 0 })],
      TODAY,
    );
    expect(entry!.notice_date).toBeNull();
  });

  it('reports a window that has already closed as a negative number of days', () => {
    // Renews in 10 days but needs 30 days notice: the deadline was 20 days ago.
    const [entry] = computeRenewalTimeline(
      [tool({ renewal_date: '2026-09-29', auto_renew: true, cancellation_notice_days: 30 })],
      TODAY,
    );
    expect(entry!.days_until).toBe(10);
    expect(entry!.notice_days_until).toBe(-20);
  });
});
