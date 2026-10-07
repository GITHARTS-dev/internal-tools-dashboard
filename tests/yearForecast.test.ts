import { describe, expect, it } from 'vitest';
import { computeCeoSummary } from '../src/shared/ceo';
import { rateTable, type FxRate } from '../src/shared/fx';
import type { InternalProduct, Payment, PriceChange, ProductCost, Tool } from '../src/shared/types';

const rate = (currency: string, value: string, month: string): FxRate => ({
  month,
  currency,
  rate: value,
  source: 'ecb',
  fetched_at: '2026-01-01T00:00:00.000Z',
});

const TABLES = {
  '2026-09': rateTable([rate('USD', '1.17', '2026-09'), rate('INR', '104.0', '2026-09')]),
};

const TODAY = '2026-10-07';

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1', name: 'A tool', vendor: null, category: 'Other', status: 'active',
    owner_name: null, owner_email: null, department: null,
    billing_cycle: 'monthly', cost_amount: 1_000_00, currency: 'INR',
    seats_purchased: null, seats_used: null, renewal_date: '2026-10-15', auto_renew: true,
    cancellation_notice_days: 0, account_ref: null, billing_email: null,
    payment_method: null, vendor_url: null, notes: null,
    started_on: null, cancelled_on: null, internal_product_id: null,
    created_at: '', updated_at: '', deleted_at: null, deleted_by: null,
    ...over,
  };
}

function payment(over: Partial<Payment> = {}): Payment {
  return {
    id: 'pay-1', tool_id: 'tool-1', period_start: null, period_end: null,
    due_date: '2026-09-15', amount: 1_000_00, currency: 'INR', status: 'paid',
    paid_on: '2026-09-15', paid_by: null, invoice_ref: null, invoice_url: null,
    notes: null, created_at: '', updated_at: '',
    ...over,
  };
}

function product(over: Partial<InternalProduct> = {}): InternalProduct {
  return {
    id: 'prod-1', name: 'Timesheet', description: null, status: 'live',
    owner_name: null, owner_email: null, launched_on: null, retired_on: null,
    notes: null, created_at: '2026-06-01T00:00:00.000Z', updated_at: '',
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

function forecast(over: {
  tools?: Tool[];
  payments?: Payment[];
  products?: InternalProduct[];
  monthlyCosts?: ProductCost[];
  priceChanges?: PriceChange[];
} = {}) {
  return computeCeoSummary({
    tools: over.tools ?? [],
    payments: over.payments ?? [],
    products: over.products ?? [],
    monthlyCosts: over.monthlyCosts ?? [],
    priceChanges: over.priceChanges ?? [],
    tables: TABLES,
    reportingCurrency: 'INR',
    today: TODAY,
  }).year_forecast;
}

describe('year forecast', () => {
  it('bills a monthly tool on each remaining date this year', () => {
    const result = forecast({ tools: [tool()] });
    expect(result.lines.map((l) => l.date)).toEqual(['2026-10-15', '2026-11-15', '2026-12-15']);
    expect(result.to_come).toBe(3_000_00);
  });

  it('counts an annual renewal once, in full, and one already past not at all', () => {
    const result = forecast({
      tools: [
        tool({ id: 'nov', name: 'Renews in Nov', billing_cycle: 'annual', cost_amount: 12_000_00, renewal_date: '2026-11-20' }),
        tool({ id: 'feb', name: 'Renews in Feb', billing_cycle: 'annual', cost_amount: 50_000_00, renewal_date: '2026-02-10' }),
      ],
    });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.label).toBe('Renews in Nov');
    expect(result.to_come).toBe(12_000_00);
  });

  it('never counts a month the ledger already holds a bill for', () => {
    const result = forecast({
      tools: [tool()],
      payments: [payment({ id: 'oct', due_date: '2026-10-15', status: 'due', paid_on: null })],
    });
    expect(result.lines.filter((l) => l.kind === 'renewal').map((l) => l.date)).toEqual(['2026-11-15', '2026-12-15']);
    expect(result.lines.filter((l) => l.kind === 'scheduled')).toHaveLength(1);
    // October's bill, already scheduled, is still to come -- not overdue.
    expect(result.overdue).toBe(0);
    expect(result.to_come).toBe(3_000_00);
  });

  it('splits unpaid bills into overdue and scheduled', () => {
    const result = forecast({
      tools: [tool({ renewal_date: null })],
      payments: [
        payment({ id: 'late', due_date: '2026-09-01', status: 'due', paid_on: null }),
        payment({ id: 'soon', due_date: '2026-10-20', status: 'due', paid_on: null }),
        payment({ id: 'waived', due_date: '2026-08-01', status: 'waived', paid_on: null }),
        payment({ id: 'last-year', due_date: '2025-12-01', status: 'due', paid_on: null }),
      ],
    });
    const kinds = Object.fromEntries(result.lines.map((l) => [l.id, l.kind]));
    expect(kinds).toEqual({ late: 'overdue', soon: 'scheduled' });
  });

  it('prices each bill at the price in effect on its date', () => {
    const result = forecast({
      tools: [tool()],
      priceChanges: [
        {
          id: 'pc', tool_id: 'tool-1', effective_from: '2026-12-01', amount: 1_500_00, currency: 'INR',
          previous_amount: 1_000_00, previous_currency: 'INR', note: null, changed_by: null, created_at: '',
        },
      ],
    });
    expect(result.lines.map((l) => l.amount)).toEqual([1_000_00, 1_000_00, 1_500_00]);
  });

  it('stops after the next bill when a tool does not auto-renew', () => {
    const result = forecast({ tools: [tool({ auto_renew: false })] });
    expect(result.lines).toHaveLength(1);
  });

  it('lists a live tool with no renewal date instead of guessing its bills', () => {
    const result = forecast({ tools: [tool({ name: 'No date', renewal_date: null })] });
    expect(result.lines).toHaveLength(0);
    expect(result.undated_tools.map((t) => t.label)).toEqual(['No date']);
  });

  it('ignores cancelled tools', () => {
    expect(forecast({ tools: [tool({ status: 'cancelled' })] }).lines).toHaveLength(0);
  });

  it('counts cloud bills entered as paid, and never predicts the months not yet billed', () => {
    const result = forecast({
      products: [product()],
      monthlyCosts: [
        cost({ id: 'aug', month: '2026-08', amount: 16_000_00 }),
        cost({ id: 'sep', month: '2026-09', amount: 40_000_00 }),
      ],
    });
    expect(result.paid).toBe(56_000_00);
    expect(result.lines).toHaveLength(0);
    expect(result.total).toBe(56_000_00);
  });

  it('adds it all up: paid, overdue and still to come', () => {
    const result = forecast({
      tools: [tool()],
      payments: [
        payment({ id: 'sep-paid' }),
        payment({ id: 'aug-late', due_date: '2026-08-15', status: 'due', paid_on: null }),
      ],
      products: [product()],
      monthlyCosts: [cost({ id: 'sep', month: '2026-09', amount: 20_000_00 })],
    });
    expect(result.paid).toBe(1_000_00 + 20_000_00);
    expect(result.overdue).toBe(1_000_00);
    expect(result.to_come).toBe(3_000_00);
    expect(result.total).toBe(result.paid + result.overdue + result.to_come);
  });

  it('converts a foreign bill at the latest rate held', () => {
    const result = forecast({ tools: [tool({ currency: 'USD', cost_amount: 10_00, renewal_date: '2026-12-01' })] });
    expect(result.lines[0]!.amount_reported).toBe(88_889); // 10 / 1.17 * 104
  });
});
