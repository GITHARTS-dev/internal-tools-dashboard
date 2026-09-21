import { describe, expect, it } from 'vitest';
import { computeCeoSummary } from '../src/shared/ceo';
import { rateTable, type FxRate } from '../src/shared/fx';
import type { InternalProduct, Payment, Tool } from '../src/shared/types';

const rate = (currency: string, value: string, month: string): FxRate => ({
  month,
  currency,
  rate: value,
  source: 'ecb',
  fetched_at: '2026-01-01T00:00:00.000Z',
});

const TABLES = {
  '2025-06': rateTable([rate('USD', '1.10', '2025-06'), rate('INR', '90.0', '2025-06')]),
  '2026-08': rateTable([rate('USD', '1.15', '2026-08'), rate('INR', '110.0', '2026-08')]),
};

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1', name: 'A tool', vendor: null, category: 'Other', status: 'active',
    owner_name: null, owner_email: null, department: null,
    billing_cycle: 'monthly', cost_amount: 100_00, currency: 'INR',
    seats_purchased: null, seats_used: null, renewal_date: null, auto_renew: true,
    cancellation_notice_days: 0, account_ref: null, billing_email: null,
    payment_method: null, vendor_url: null, notes: null,
    started_on: null, cancelled_on: null, internal_product_id: null,
    created_at: '', updated_at: '',
    ...over,
  };
}

function product(over: Partial<InternalProduct> = {}): InternalProduct {
  return {
    id: 'prod-1', name: 'Timesheet', description: null, status: 'live',
    owner_name: null, owner_email: null, launched_on: null, retired_on: null,
    notes: null, created_at: '', updated_at: '',
    ...over,
  };
}

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-1', tool_id: 'tool-1', period_start: null, period_end: null,
    due_date: '2025-06-01', amount: 100_00, currency: 'INR', status: 'paid',
    paid_on: '2025-06-15', paid_by: null, invoice_ref: null, invoice_url: null,
    notes: null, created_at: '', updated_at: '',
    ...over,
  };
}

const base = {
  payments: [] as Payment[],
  products: [] as InternalProduct[],
  tables: TABLES,
  reportingCurrency: 'INR',
  today: '2026-09-19',
};

describe('computeCeoSummary', () => {
  it('splits bought tools from our own products', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [
        tool({ id: 'a', cost_amount: 100_00 }),
        tool({ id: 'b', cost_amount: 300_00, internal_product_id: 'prod-1' }),
      ],
    });

    expect(result.subscriptions.tool_count).toBe(1);
    expect(result.internal.tool_count).toBe(1);
    expect(result.subscriptions.monthly_reported).toBe(100_00);
    expect(result.internal.monthly_reported).toBe(300_00);
  });

  it('keeps the total unchanged when a tool is attributed to a product', () => {
    const tools = [tool({ id: 'a', cost_amount: 100_00 }), tool({ id: 'b', cost_amount: 300_00 })];
    const before = computeCeoSummary({ ...base, tools });
    const after = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [tools[0]!, { ...tools[1]!, internal_product_id: 'prod-1' }],
    });

    // Attribution moves money between buckets; it must not create or lose any.
    expect(after.total_monthly_reported).toBe(before.total_monthly_reported);
  });

  it('counts a tool pointing at a deleted product as bought SaaS', () => {
    const result = computeCeoSummary({
      ...base,
      products: [],
      tools: [tool({ cost_amount: 500_00, internal_product_id: 'gone' })],
    });

    // The money must still appear somewhere.
    expect(result.subscriptions.tool_count).toBe(1);
    expect(result.total_monthly_reported).toBe(500_00);
  });

  it('ignores cancelled tools in the run rate', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [tool({ id: 'a', status: 'cancelled', cost_amount: 999_00 }), tool({ id: 'b' })],
    });
    expect(result.subscriptions.tool_count).toBe(1);
    expect(result.total_monthly_reported).toBe(100_00);
  });

  it('converts a foreign run rate at the latest month', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [tool({ cost_amount: 100_00, currency: 'USD' })],
    });
    // $100 / 1.15 * 110 = INR 9565.21...
    expect(result.total_monthly_reported).toBe(956_522);
  });

  it('values each past payment at its own months rate', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [],
      payments: [
        payment({ id: 'p1', currency: 'USD', amount: 100_00, paid_on: '2025-06-15' }),
        payment({ id: 'p2', currency: 'USD', amount: 100_00, paid_on: '2026-08-15' }),
      ],
    });

    const [y2025, y2026] = result.paid_by_year;
    // Same dollars, different years, different rates: the totals must differ.
    expect(y2025!.year).toBe('2025');
    expect(y2026!.year).toBe('2026');
    expect(y2025!.amount).not.toBe(y2026!.amount);
    expect(y2025!.amount).toBe(818_182); // 100/1.10*90
    expect(y2026!.amount).toBe(956_522); // 100/1.15*110
  });

  it('excludes unconvertible amounts and says so', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [tool({ id: 'a', cost_amount: 100_00 }), tool({ id: 'b', cost_amount: 50_00, currency: 'AED' })],
    });

    expect(result.gaps.some((g) => g.currency === 'AED')).toBe(true);
    // The INR tool is still counted; only the unconvertible one is left out.
    expect(result.subscriptions.monthly_reported).toBe(100_00);
  });

  it('reports no rates as a flag rather than a wrong total', () => {
    const result = computeCeoSummary({
      ...base,
      tables: {},
      tools: [tool({ cost_amount: 100_00, currency: 'USD' })],
    });

    expect(result.fx_available).toBe(false);
    expect(result.subscriptions.monthly_reported).toBeNull();
    expect(result.total_monthly_reported).toBeNull();
  });

  it('still totals correctly when everything is already in the target currency', () => {
    const result = computeCeoSummary({
      ...base,
      tables: {},
      tools: [tool({ cost_amount: 100_00, currency: 'INR' })],
    });
    expect(result.total_monthly_reported).toBe(100_00);
    expect(result.gaps).toEqual([]);
  });

  it('annualises a non-monthly cycle', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [tool({ cost_amount: 1200_00, billing_cycle: 'annual' })],
    });
    expect(result.total_annual_reported).toBe(1200_00);
    expect(result.total_monthly_reported).toBe(100_00);
  });

  it('leaves one-off purchases out of the run rate', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [tool({ cost_amount: 5000_00, billing_cycle: 'one_time' })],
    });
    // A one-off has no annual run rate; counting it would overstate every month.
    expect(result.total_monthly_reported).toBe(0);
  });

  it('excludes the current month from the trend', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [],
      today: '2026-09-19',
      payments: [payment({ paid_on: '2026-09-10', currency: 'INR', amount: 999_00 })],
    });

    // September is still being paid; including it would read as a collapse.
    expect(result.paid_by_month.at(-1)!.month).toBe('2026-08');
    expect(result.paid_by_month.some((m) => m.month === '2026-09')).toBe(false);
    expect(result.paid_by_month.every((m) => m.amount === 0)).toBe(true);
  });

  it('spans exactly 24 complete months, oldest first', () => {
    const result = computeCeoSummary({ ...base, tools: [], today: '2026-09-19' });
    expect(result.paid_by_month).toHaveLength(24);
    expect(result.paid_by_month[0]!.month).toBe('2024-09');
    expect(result.paid_by_month.at(-1)!.month).toBe('2026-08');
  });

  it('compares two like-for-like 12-month windows', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [],
      today: '2026-09-19',
      payments: [
        // Previous window (2024-09..2025-08): 100
        payment({ id: 'a', paid_on: '2025-01-10', currency: 'INR', amount: 100_00 }),
        // Trailing window (2025-09..2026-08): 150
        payment({ id: 'b', paid_on: '2026-01-10', currency: 'INR', amount: 150_00 }),
      ],
    });

    expect(result.comparison.previous_12).toBe(100_00);
    expect(result.comparison.trailing_12).toBe(150_00);
    expect(result.comparison.change_pct).toBeCloseTo(50, 5);
    expect(result.comparison.from).toBe('2025-09');
    expect(result.comparison.to).toBe('2026-08');
  });

  it('reports no percentage when there is nothing to compare against', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [],
      today: '2026-09-19',
      payments: [payment({ paid_on: '2026-01-10', currency: 'INR', amount: 150_00 })],
    });
    // Growth from zero is not a percentage; it is a start.
    expect(result.comparison.previous_12).toBe(0);
    expect(result.comparison.change_pct).toBeNull();
  });

  it('ranks the biggest subscriptions, converted, and caps the list', () => {
    const tools = Array.from({ length: 12 }, (_, i) =>
      tool({ id: `t${i}`, name: `Tool ${i}`, cost_amount: (i + 1) * 100_00, billing_cycle: 'annual' }),
    );
    const result = computeCeoSummary({ ...base, tools });

    expect(result.top_tools).toHaveLength(8);
    expect(result.top_tools[0]!.label).toBe('Tool 11');
    // Strictly descending.
    for (let i = 1; i < result.top_tools.length; i++) {
      expect(result.top_tools[i - 1]!.annual_reported).toBeGreaterThanOrEqual(
        result.top_tools[i]!.annual_reported,
      );
    }
  });

  it('groups categories and converts each to the reporting currency', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [
        tool({ id: 'a', category: 'Design', cost_amount: 100_00, billing_cycle: 'annual' }),
        tool({ id: 'b', category: 'Design', cost_amount: 200_00, billing_cycle: 'annual' }),
        tool({ id: 'c', category: 'Security', cost_amount: 50_00, billing_cycle: 'annual' }),
      ],
    });

    expect(result.by_category[0]).toMatchObject({ label: 'Design', annual_reported: 300_00 });
    expect(result.by_category[1]).toMatchObject({ label: 'Security', annual_reported: 50_00 });
  });

  it('values idle seats per year, not per billing period', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [
        tool({
          cost_amount: 1000_00,
          billing_cycle: 'monthly',
          seats_purchased: 10,
          seats_used: 6,
          currency: 'INR',
        }),
      ],
    });

    // 4 idle of 10 => 400/month => 4800/year.
    expect(result.idle_seat_cost).toBe(4800_00);
    expect(result.idle_seat_count).toBe(4);
  });

  it('counts no idle seats when seat data is missing', () => {
    const result = computeCeoSummary({
      ...base,
      tools: [tool({ seats_purchased: null, seats_used: null })],
    });
    expect(result.idle_seat_count).toBe(0);
    expect(result.idle_seat_cost).toBe(0);
  });

  it('does not count retired products as live', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product({ id: 'p1' }), product({ id: 'p2', status: 'retired' })],
      tools: [],
    });
    expect(result.internal.product_count).toBe(1);
  });
});
