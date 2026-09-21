import { describe, expect, it } from 'vitest';
import { computeProductUsage, lastCompleteMonth } from '../src/shared/productCosts';
import { computeCeoSummary } from '../src/shared/ceo';
import { rateTable, type FxRate } from '../src/shared/fx';
import type { InternalProduct, ProductCost, Tool } from '../src/shared/types';

/**
 * Recorded monthly costs and what is made of them.
 *
 * "Today" is pinned to 2026-09-19 throughout, so the last complete month is
 * 2026-08 and the averaging window is June, July and August.
 */

const TODAY = '2026-09-19';

const rate = (currency: string, value: string, month: string): FxRate => ({
  month,
  currency,
  rate: value,
  source: 'ecb',
  fetched_at: '2026-01-01T00:00:00.000Z',
});

// USD gets a different rate each month, so a test can tell whether each entry
// was converted at its own month's rate or all at one.
const TABLES = {
  '2026-06': rateTable([rate('USD', '1.00', '2026-06'), rate('INR', '100.0', '2026-06')]),
  '2026-07': rateTable([rate('USD', '1.00', '2026-07'), rate('INR', '110.0', '2026-07')]),
  '2026-08': rateTable([rate('USD', '1.00', '2026-08'), rate('INR', '120.0', '2026-08')]),
};

let n = 0;
function cost(over: Partial<ProductCost> = {}): ProductCost {
  n += 1;
  return {
    id: `c${n}`,
    product_id: 'p1',
    month: '2026-08',
    provider: 'AWS',
    amount: 100_00,
    currency: 'USD',
    source: 'manual',
    note: null,
    created_at: '',
    updated_at: '',
    ...over,
  };
}

function product(over: Partial<InternalProduct> = {}): InternalProduct {
  return {
    id: 'p1', name: 'TRA', description: null, status: 'live',
    owner_name: null, owner_email: null, launched_on: null, retired_on: null,
    notes: null, created_at: '', updated_at: '',
    ...over,
  };
}

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: 't1', name: 'Domain', vendor: null, category: 'Other', status: 'active',
    owner_name: null, owner_email: null, department: null,
    billing_cycle: 'monthly', cost_amount: 10_00, currency: 'USD',
    seats_purchased: null, seats_used: null, renewal_date: null, auto_renew: true,
    cancellation_notice_days: 0, account_ref: null, billing_email: null,
    payment_method: null, vendor_url: null, notes: null,
    started_on: null, cancelled_on: null, internal_product_id: 'p1',
    created_at: '', updated_at: '',
    ...over,
  };
}

describe('computeProductUsage', () => {
  it('averages the last three complete months', () => {
    const usage = computeProductUsage(
      [
        cost({ month: '2026-06', amount: 100_00 }),
        cost({ month: '2026-07', amount: 200_00 }),
        cost({ month: '2026-08', amount: 300_00 }),
      ],
      TABLES,
      'USD',
      TODAY,
    );

    expect(usage.average_reported).toBe(200_00);
    expect(usage.months_counted).toBe(3);
    expect(usage.window.map((m) => m.month)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('never counts the current month', () => {
    const usage = computeProductUsage(
      [cost({ month: '2026-08', amount: 100_00 }), cost({ month: '2026-09', amount: 9_999_00 })],
      TABLES,
      'USD',
      TODAY,
    );

    // September is still being billed; averaging it in would misstate the run.
    expect(usage.average_reported).toBe(100_00);
    expect(usage.window.some((m) => m.month === '2026-09')).toBe(false);
    // But it is still the most recent thing anyone entered.
    expect(usage.last_cost_month).toBe('2026-09');
  });

  it('treats a month with no entry as unknown, not zero', () => {
    const usage = computeProductUsage(
      [cost({ month: '2026-06', amount: 300_00 }), cost({ month: '2026-08', amount: 100_00 })],
      TABLES,
      'USD',
      TODAY,
    );

    // July was never entered. Averaging in a zero would say 133.33; the honest
    // figure is the mean of the two months that are actually known.
    expect(usage.average_reported).toBe(200_00);
    expect(usage.months_counted).toBe(2);
    expect(usage.window.find((m) => m.month === '2026-07')).toMatchObject({
      entered: false,
      amount: null,
    });
  });

  it('reports nothing rather than zero when no month is in the window', () => {
    const usage = computeProductUsage(
      [cost({ month: '2025-01', amount: 500_00 })],
      TABLES,
      'USD',
      TODAY,
    );
    expect(usage.average_reported).toBeNull();
    expect(usage.months_counted).toBe(0);
  });

  it('is null with no costs at all', () => {
    const usage = computeProductUsage([], TABLES, 'USD', TODAY);
    expect(usage.average_reported).toBeNull();
    expect(usage.last_cost_month).toBeNull();
    expect(usage.latest_month_missing).toBe(true);
  });

  it('sums the providers within a month before averaging', () => {
    const usage = computeProductUsage(
      [
        cost({ month: '2026-08', provider: 'AWS', amount: 300_00 }),
        cost({ month: '2026-08', provider: 'Supabase', amount: 25_00 }),
      ],
      TABLES,
      'USD',
      TODAY,
    );
    expect(usage.average_reported).toBe(325_00);
    expect(usage.months_counted).toBe(1);
  });

  it('converts each month at that month\'s own rate', () => {
    const usage = computeProductUsage(
      [
        cost({ month: '2026-06', amount: 100_00 }), // $100 at 100 INR/USD
        cost({ month: '2026-08', amount: 100_00 }), // $100 at 120 INR/USD
      ],
      TABLES,
      'INR',
      TODAY,
    );
    // (10,000 + 12,000) / 2 rupees, in paise. One flat rate would give a
    // different figure for the same dollars.
    expect(usage.average_reported).toBe(11_000_00);
  });

  it('flags a missing last month, and clears the flag once it is entered', () => {
    const without = computeProductUsage([cost({ month: '2026-07' })], TABLES, 'USD', TODAY);
    expect(without.latest_complete_month).toBe('2026-08');
    expect(without.latest_month_missing).toBe(true);

    const withIt = computeProductUsage(
      [cost({ month: '2026-07' }), cost({ month: '2026-08' })],
      TABLES,
      'USD',
      TODAY,
    );
    expect(withIt.latest_month_missing).toBe(false);
  });

  it('leaves out a month it cannot convert and says so', () => {
    const usage = computeProductUsage(
      [
        cost({ month: '2026-07', amount: 100_00, currency: 'USD' }),
        // No AED rate exists, so this month's size is unknown.
        cost({ month: '2026-08', amount: 999_00, currency: 'AED' }),
      ],
      TABLES,
      'USD',
      TODAY,
    );

    expect(usage.average_reported).toBe(100_00);
    expect(usage.months_counted).toBe(1);
    expect(usage.gaps).toEqual([{ currency: 'AED', month: '2026-08', count: 1 }]);
    // Entered, but unusable -- which is not the same as never entered.
    const august = usage.window.find((m) => m.month === '2026-08');
    expect(august).toMatchObject({ entered: true, amount: null });
    expect(usage.latest_month_missing).toBe(false);
  });

  it('finds the last complete month across a year boundary', () => {
    expect(lastCompleteMonth('2026-01-05')).toBe('2025-12');
    expect(lastCompleteMonth('2026-09-30')).toBe('2026-08');
  });
});

describe('the CEO summary with recorded product costs', () => {
  const base = {
    payments: [],
    tables: TABLES,
    reportingCurrency: 'USD',
    today: TODAY,
  };

  it('adds usage to the fixed subscriptions for a product', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [tool({ cost_amount: 10_00 })], // $10 a month, fixed
      monthlyCosts: [cost({ month: '2026-08', amount: 300_00 })], // $300 usage
    });

    const tra = result.products[0]!;
    expect(tra.fixed_monthly_reported).toBe(10_00);
    expect(tra.usage_monthly_reported).toBe(300_00);
    expect(tra.monthly_reported).toBe(310_00);
    expect(tra.annual_reported).toBe(310_00 * 12);
    expect(tra.usage_months_counted).toBe(1);
  });

  it('carries usage into the internal total and names how much of it varies', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [tool({ cost_amount: 10_00 })],
      monthlyCosts: [cost({ month: '2026-08', amount: 300_00 })],
    });

    expect(result.internal.monthly_reported).toBe(310_00);
    expect(result.internal.usage_annual_reported).toBe(300_00 * 12);
    expect(result.total_annual_reported).toBe(310_00 * 12);
  });

  it('leaves the totals alone when no usage has been entered', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [tool({ cost_amount: 10_00 })],
    });

    expect(result.products[0]!.usage_monthly_reported).toBeNull();
    // Unknown adds nothing; it must not become a confident zero.
    expect(result.products[0]!.monthly_reported).toBe(10_00);
    expect(result.internal.usage_annual_reported).toBeNull();
  });

  it('counts a product with only usage and no subscriptions', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [],
      monthlyCosts: [cost({ month: '2026-08', amount: 400_00 })],
    });
    expect(result.products[0]!.monthly_reported).toBe(400_00);
    expect(result.internal.tool_count).toBe(0);
  });

  it('flags a product whose latest month is missing, but not a retired one', () => {
    const live = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [],
      monthlyCosts: [cost({ month: '2026-06' })],
    });
    expect(live.products[0]!.latest_month_missing).toBe(true);

    const retired = computeCeoSummary({
      ...base,
      products: [product({ status: 'retired' })],
      tools: [],
      monthlyCosts: [cost({ month: '2026-06' })],
    });
    // Nobody is expected to keep entering bills for something that is switched off.
    expect(retired.products[0]!.latest_month_missing).toBe(false);
  });

  it('puts recorded costs into what was actually paid', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [],
      monthlyCosts: [
        cost({ month: '2026-07', amount: 200_00 }),
        cost({ month: '2026-08', amount: 300_00 }),
      ],
    });

    const trend = Object.fromEntries(result.paid_by_month.map((m) => [m.month, m.amount]));
    expect(trend['2026-07']).toBe(200_00);
    expect(trend['2026-08']).toBe(300_00);
    expect(result.paid_by_year.find((y) => y.year === '2026')!.amount).toBe(500_00);
    expect(result.comparison.trailing_12).toBe(500_00);
  });

  it('keeps the current month out of the trend but not out of the year', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [],
      monthlyCosts: [cost({ month: '2026-09', amount: 700_00 })],
    });

    // Plotted beside complete months a part-billed September reads as a drop...
    expect(result.paid_by_month.some((m) => m.month === '2026-09')).toBe(false);
    // ...but the year total is what has really been spent so far.
    expect(result.paid_by_year.find((y) => y.year === '2026')!.amount).toBe(700_00);
  });

  it('reports an unconvertible usage month as a gap in the totals', () => {
    const result = computeCeoSummary({
      ...base,
      products: [product()],
      tools: [],
      monthlyCosts: [cost({ month: '2026-08', amount: 500_00, currency: 'AED' })],
    });

    expect(result.gaps.some((g) => g.currency === 'AED')).toBe(true);
    expect(result.products[0]!.usage_monthly_reported).toBeNull();
  });

  it('is unchanged for callers that pass no monthly costs at all', () => {
    const result = computeCeoSummary({ ...base, products: [product()], tools: [tool()] });
    expect(result.products[0]!.monthly_reported).toBe(10_00);
  });
});
