import { describe, expect, it } from 'vitest';
import {
  annualisedCost,
  costPerSeat,
  formatMoney,
  monthlyCost,
  parseMoneyInput,
  sumByCurrency,
  toDecimalString,
  wastedSeatCost,
} from '../src/shared/money';

describe('parseMoneyInput', () => {
  it('accepts the shapes people actually type', () => {
    expect(parseMoneyInput('1499')).toBe(149900);
    expect(parseMoneyInput('1,499')).toBe(149900);
    expect(parseMoneyInput('1499.50')).toBe(149950);
    expect(parseMoneyInput('₹1,499.00')).toBe(149900);
    expect(parseMoneyInput('$ 1499')).toBe(149900);
    expect(parseMoneyInput(' 1499 ')).toBe(149900);
  });

  it('rounds to the minor unit rather than carrying a float', () => {
    expect(parseMoneyInput('0.1')).toBe(10);
    expect(parseMoneyInput('0.005')).toBe(1);
    expect(parseMoneyInput('19.99')).toBe(1999);
  });

  it('respects zero-decimal currencies', () => {
    expect(parseMoneyInput('5000', 'JPY')).toBe(5000);
    expect(parseMoneyInput('5000', 'USD')).toBe(500000);
  });

  it('distinguishes "not entered" from zero', () => {
    expect(parseMoneyInput('')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
    expect(parseMoneyInput('.')).toBeNull();
    expect(parseMoneyInput('0')).toBe(0);
  });
});

describe('toDecimalString', () => {
  it('round-trips through parseMoneyInput', () => {
    expect(toDecimalString(149900)).toBe('1499.00');
    expect(toDecimalString(parseMoneyInput('1499.50'))).toBe('1499.50');
    expect(toDecimalString(5000, 'JPY')).toBe('5000');
    expect(toDecimalString(null)).toBe('');
  });
});

describe('formatMoney', () => {
  it('uses Indian digit grouping for INR', () => {
    expect(formatMoney(149900, 'INR')).toBe('₹1,499.00');
    // 12,34,567.00 -- lakhs grouping, not 1,234,567.00
    expect(formatMoney(123456700, 'INR')).toBe('₹12,34,567.00');
  });

  it('formats other currencies with western grouping', () => {
    expect(formatMoney(123456700, 'USD')).toBe('$1,234,567.00');
  });

  it('shows a placeholder rather than a misleading zero', () => {
    expect(formatMoney(null)).toBe('--');
    expect(formatMoney(0)).toBe('₹0.00');
  });
});

describe('annualisedCost / monthlyCost', () => {
  it('converts between billing periods', () => {
    expect(annualisedCost(100000, 'monthly')).toBe(1200000);
    expect(annualisedCost(100000, 'quarterly')).toBe(400000);
    expect(annualisedCost(100000, 'annual')).toBe(100000);
    expect(monthlyCost(1200000, 'annual')).toBe(100000);
    expect(monthlyCost(300000, 'quarterly')).toBe(100000);
  });

  it('refuses to invent a run-rate for non-recurring spend', () => {
    // Counting a one-off purchase as monthly spend would overstate the budget
    // every month forever.
    expect(annualisedCost(500000, 'one_time')).toBeNull();
    expect(monthlyCost(500000, 'one_time')).toBeNull();
    expect(annualisedCost(500000, 'custom')).toBeNull();
  });

  it('propagates a missing amount instead of guessing zero', () => {
    expect(annualisedCost(null, 'monthly')).toBeNull();
    expect(monthlyCost(null, 'monthly')).toBeNull();
  });
});

describe('seat economics', () => {
  it('computes cost per seat', () => {
    expect(costPerSeat(500000, 10)).toBe(50000);
    expect(costPerSeat(500000, 0)).toBeNull();
    expect(costPerSeat(500000, null)).toBeNull();
    expect(costPerSeat(null, 10)).toBeNull();
  });

  it('values idle seats', () => {
    expect(wastedSeatCost(500000, 10, 4)).toBe(300000); // 6 idle of 10
    expect(wastedSeatCost(500000, 10, 10)).toBe(0);
    expect(wastedSeatCost(500000, 10, 12)).toBe(0); // over-assigned, not negative
    expect(wastedSeatCost(500000, 10, null)).toBeNull();
    expect(wastedSeatCost(null, 10, 4)).toBeNull();
  });
});

describe('sumByCurrency', () => {
  it('keeps currencies apart and names the dominant one', () => {
    const { totals, dominant } = sumByCurrency([
      { amount: 100000, currency: 'INR' },
      { amount: 50000, currency: 'INR' },
      { amount: 2000, currency: 'USD' },
      { amount: null, currency: 'INR' },
    ]);
    expect(totals).toEqual({ INR: 150000, USD: 2000 });
    expect(dominant).toBe('INR');
  });

  it('returns no dominant currency for an empty set', () => {
    expect(sumByCurrency([]).dominant).toBeNull();
  });
});
