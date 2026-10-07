import { describe, expect, it } from 'vitest';
import { computeCeoSummary } from '../src/shared/ceo';
import { breakdown, itemsBetween } from '../src/shared/drilldown';
import { rateTable, type FxRate } from '../src/shared/fx';
import type { InternalProduct, Payment, ProductCost, Tool } from '../src/shared/types';

/**
 * A drill-down is only worth opening if its lines add up to the figure it was
 * opened from. These tests hold the summary to that.
 */

const rate = (currency: string, value: string, month: string): FxRate => ({
  month,
  currency,
  rate: value,
  source: 'ecb',
  fetched_at: '2026-01-01T00:00:00.000Z',
});

const TABLES = {
  '2026-08': rateTable([rate('USD', '1.15', '2026-08'), rate('INR', '110.0', '2026-08')]),
  '2026-09': rateTable([rate('USD', '1.17', '2026-09'), rate('INR', '104.0', '2026-09')]),
};

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1', name: 'A tool', vendor: 'Vendor', category: 'Other', status: 'active',
    owner_name: null, owner_email: null, department: null,
    billing_cycle: 'monthly', cost_amount: 100_00, currency: 'INR',
    seats_purchased: null, seats_used: null, renewal_date: null, auto_renew: true,
    cancellation_notice_days: 0, account_ref: null, billing_email: null,
    payment_method: null, vendor_url: null, notes: null,
    started_on: null, cancelled_on: null, internal_product_id: null,
    created_at: '', updated_at: '', deleted_at: null, deleted_by: null,
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
    due_date: '2026-08-01', amount: 100_00, currency: 'INR', status: 'paid',
    paid_on: '2026-08-15', paid_by: null, invoice_ref: null, invoice_url: null,
    notes: null, created_at: '', updated_at: '',
    ...over,
  };
}

function cost(over: Partial<ProductCost> = {}): ProductCost {
  return {
    id: 'cost-1', product_id: 'prod-1', month: '2026-08', provider: 'AWS',
    amount: 16_000_00, currency: 'INR', source: 'manual', note: null,
    created_at: '', updated_at: '',
    ...over,
  };
}

const TODAY = '2026-10-07';

function summary() {
  return computeCeoSummary({
    tools: [
      tool({ id: 't-inr', name: 'Slack', cost_amount: 500_00 }),
      tool({ id: 't-usd', name: 'GitHub', cost_amount: 21_00, currency: 'USD' }),
      tool({ id: 't-prod', name: 'Supabase', cost_amount: 25_00, currency: 'USD', internal_product_id: 'prod-1' }),
    ],
    payments: [
      payment({ id: 'p1', tool_id: 't-inr', amount: 500_00, paid_on: '2026-08-03' }),
      payment({ id: 'p2', tool_id: 't-usd', amount: 21_00, currency: 'USD', paid_on: '2026-09-04' }),
      payment({ id: 'p3', tool_id: 't-usd', amount: 21_00, currency: 'USD', paid_on: '2026-10-02' }),
      // Not paid: never part of what was spent.
      payment({ id: 'p4', tool_id: 't-inr', status: 'due', paid_on: null, due_date: '2026-10-20' }),
    ],
    products: [product()],
    monthlyCosts: [
      cost({ id: 'c-aug', month: '2026-08', amount: 16_000_00 }),
      cost({ id: 'c-sep', month: '2026-09', amount: 40_000_00 }),
    ],
    tables: TABLES,
    reportingCurrency: 'INR',
    today: TODAY,
  });
}

describe('paid items', () => {
  it('lists every paid payment and every cloud bill, and nothing unpaid', () => {
    const result = summary();
    expect(result.paid_items.map((i) => i.id).sort()).toEqual(['c-aug', 'c-sep', 'p1', 'p2', 'p3']);
  });

  it('adds up to each month of the trend, at the same rates', () => {
    const result = summary();
    for (const row of result.paid_by_month) {
      const month = breakdown(itemsBetween(result.paid_items, row.month, row.month), 'INR');
      expect(month.total).toBe(row.amount);
      expect(month.subscriptions).toBe(row.subscriptions);
      expect(month.usage).toBe(row.usage);
    }
  });

  it('adds up to each year of what was paid', () => {
    const result = summary();
    for (const row of result.paid_by_year) {
      const year = breakdown(itemsBetween(result.paid_items, `${row.year}-01`, `${row.year}-12`), 'INR');
      expect(year.total).toBe(row.amount);
    }
  });

  it('adds up to the last 12 complete months', () => {
    const result = summary();
    const last12 = breakdown(
      itemsBetween(result.paid_items, result.comparison.from!, result.comparison.to!),
      'INR',
    );
    expect(last12.total).toBe(result.comparison.trailing_12);
  });

  it('includes the current month in the year so far, which the trend leaves out', () => {
    const result = summary();
    const ytd = breakdown(itemsBetween(result.paid_items, '2026-01', '2026-10'), 'INR');
    const completeMonths = result.paid_by_month
      .filter((row) => row.month.startsWith('2026'))
      .reduce((sum, row) => sum + row.amount, 0);
    // October's payment of $21 is in the year so far but not in any complete month.
    expect(ytd.total).toBeGreaterThan(completeMonths);
    expect(ytd.payment_count).toBe(3);
    expect(ytd.bill_count).toBe(2);
  });

  it('keeps the amount as paid beside the converted one, and names the rate month', () => {
    const result = summary();
    const github = result.paid_items.find((i) => i.id === 'p2')!;
    expect(github.amount).toBe(21_00);
    expect(github.currency).toBe('USD');
    expect(github.rate_month).toBe('2026-09');
    expect(github.amount_reported).toBe(186_667); // 21 / 1.17 * 104

    const slack = result.paid_items.find((i) => i.id === 'p1')!;
    expect(slack.rate_month).toBeNull();
    expect(slack.amount_reported).toBe(500_00);
  });

  it('names the tool and the product a line belongs to', () => {
    const result = summary();
    const bill = result.paid_items.find((i) => i.id === 'c-sep')!;
    expect(bill.kind).toBe('usage');
    expect(bill.label).toBe('Timesheet');
    expect(bill.detail).toBe('AWS');
    expect(bill.date).toBeNull();
    expect(result.paid_items.find((i) => i.id === 'p2')!.label).toBe('GitHub');
  });

  it('orders newest first', () => {
    const months = summary().paid_items.map((i) => i.month);
    expect(months).toEqual([...months].sort().reverse());
  });
});

describe('breakdown', () => {
  it('splits by currency, as paid and converted, and the currencies sum to the total', () => {
    const result = summary();
    const ytd = breakdown(itemsBetween(result.paid_items, '2026-01', '2026-10'), 'INR');
    const inr = ytd.by_currency.find((l) => l.currency === 'INR')!;
    const usd = ytd.by_currency.find((l) => l.currency === 'USD')!;

    expect(inr.amount).toBe(500_00 + 16_000_00 + 40_000_00);
    expect(usd.amount).toBe(42_00);
    expect(usd.count).toBe(2);
    expect(ytd.by_currency.reduce((s, l) => s + l.reported, 0)).toBe(ytd.total);
  });

  it('leaves an amount with no rate out of the total and counts it', () => {
    const result = computeCeoSummary({
      tools: [tool({ id: 't-aed', currency: 'AED' })],
      payments: [payment({ id: 'p-aed', tool_id: 't-aed', currency: 'AED', amount: 50_00 })],
      products: [],
      tables: TABLES,
      reportingCurrency: 'INR',
      today: TODAY,
    });
    const data = breakdown(result.paid_items, 'INR');
    expect(data.total).toBe(0);
    expect(data.unconverted).toBe(1);
    expect(data.by_currency[0]!.unconverted).toBe(1);
  });
});

describe('run rate items', () => {
  it('lists each live subscription, and they add up to the forecast', () => {
    const result = summary();
    const bought = result.run_rate_items.filter((i) => i.product_id === null);
    const ownProducts = result.run_rate_items.filter((i) => i.product_id === 'prod-1');

    expect(bought.map((i) => i.label).sort()).toEqual(['GitHub', 'Slack']);
    expect(bought.reduce((s, i) => s + (i.annual_reported ?? 0), 0)).toBe(result.subscriptions.annual_reported);
    expect(bought.reduce((s, i) => s + (i.monthly_reported ?? 0), 0)).toBe(result.subscriptions.monthly_reported);
    expect(ownProducts.reduce((s, i) => s + (i.annual_reported ?? 0), 0)).toBe(
      result.products[0]!.fixed_annual_reported,
    );
  });

  it('keeps the price as charged, with its cycle and a year of it', () => {
    const github = summary().run_rate_items.find((i) => i.tool_id === 't-usd')!;
    expect(github.cost_amount).toBe(21_00);
    expect(github.billing_cycle).toBe('monthly');
    expect(github.annual).toBe(252_00);
    expect(github.currency).toBe('USD');
  });

  it('shows the months a product usage average was taken over', () => {
    const entry = summary().products[0]!;
    expect(entry.usage_window.map((m) => m.month)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(entry.usage_window[0]!.entered).toBe(false);
    // (16,000 + 40,000) / 2, not / 3: a month with no bill is unknown, not zero.
    expect(entry.usage_monthly_reported).toBe(28_000_00);
    expect(entry.usage_annual_reported).toBe(3_36_000_00);
  });
});
