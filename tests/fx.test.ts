import { describe, expect, it } from 'vitest';
import {
  addMonthsToYearMonth,
  convert,
  formatRate,
  isYearMonth,
  monthOf,
  parseRate,
  rateTable,
  resolveMonth,
  sumConverted,
  RATE_SCALE,
  type FxRate,
} from '../src/shared/fx';
import { parseEcbCsv, splitCsvLine } from '../src/server/fx/ecb';

const rate = (currency: string, value: string, month = '2026-03'): FxRate => ({
  month,
  currency,
  rate: value,
  source: 'ecb',
  fetched_at: '2026-04-01T00:00:00.000Z',
});

// Roughly the real March 2026 shape: 1 EUR = 1.08 USD = 90.5 INR.
const MARCH = rateTable([rate('USD', '1.08'), rate('INR', '90.5')]);

describe('parseRate', () => {
  it('scales a decimal string without going through a float', () => {
    expect(parseRate('1')).toBe(RATE_SCALE);
    expect(parseRate('1.08')).toBe(10800000000n);
    expect(parseRate('90.5')).toBe(905000000000n);
  });

  it('keeps precision the ECB actually publishes', () => {
    expect(formatRate(parseRate('1.0856')!)).toBe('1.0856');
    expect(formatRate(parseRate('90.4237')!)).toBe('90.4237');
  });

  it('rejects anything that is not a positive decimal', () => {
    for (const bad of ['', '  ', 'abc', '-1.5', '1.2.3', 'NaN', '0', '1e5']) {
      expect(parseRate(bad)).toBeNull();
    }
    expect(parseRate(null)).toBeNull();
    expect(parseRate(undefined)).toBeNull();
  });
});

describe('convert', () => {
  it('leaves an amount alone when the currency already matches', () => {
    const result = convert(149900, 'INR', 'INR', MARCH, '2026-03');
    expect(result?.amount).toBe(149900);
    expect(result?.rate).toBeNull();
    expect(result?.rate_month).toBeNull();
  });

  it('converts through EUR using both currencies rates', () => {
    // $100.00 / 1.08 = EUR 92.5925...; x 90.5 = INR 8379.6296... -> ₹8,379.63
    const result = convert(10000, 'USD', 'INR', MARCH, '2026-03');
    expect(result).not.toBeNull();
    expect(result!.currency).toBe('INR');
    expect(result!.amount).toBe(837_963); // paise
    expect(result!.from_amount).toBe(10000);
    expect(result!.from_currency).toBe('USD');
    expect(result!.rate_month).toBe('2026-03');
  });

  it('round-trips to within one minor unit', () => {
    const toInr = convert(10000, 'USD', 'INR', MARCH)!;
    const back = convert(toInr.amount, 'INR', 'USD', MARCH)!;
    expect(Math.abs(back.amount - 10000)).toBeLessThanOrEqual(1);
  });

  it('handles the EUR base without a stored row for it', () => {
    const result = convert(10000, 'EUR', 'USD', MARCH)!;
    expect(result.amount).toBe(10800);
  });

  it('crosses a zero-decimal currency correctly', () => {
    // JPY has no minor unit: 1000 yen is 1000, not 100000.
    const table = rateTable([rate('JPY', '160'), rate('INR', '90.5')]);
    const result = convert(1000, 'JPY', 'INR', table)!;
    expect(result.amount).toBe(56_563); // ₹565.63
  });

  it('refuses rather than guessing when a rate is missing', () => {
    expect(convert(10000, 'AED', 'INR', MARCH)).toBeNull();
    expect(convert(10000, 'INR', 'AED', MARCH)).toBeNull();
  });

  it('keeps the sign of a negative amount', () => {
    const result = convert(-10000, 'USD', 'INR', MARCH)!;
    expect(result.amount).toBe(-837_963);
  });

  it('rounds half away from zero rather than truncating', () => {
    // A rate chosen so the exact result lands on .5 of a minor unit.
    const table = rateTable([rate('AAA', '2'), rate('BBB', '3')]);
    expect(convert(1, 'AAA', 'BBB', table)!.amount).toBe(2); // 1.5 -> 2
  });
});

describe('sumConverted', () => {
  const tables = {
    '2026-02': rateTable([rate('USD', '1.10', '2026-02'), rate('INR', '89.0', '2026-02')]),
    '2026-03': MARCH,
  };

  it('uses each entrys own month, so history does not move', () => {
    const result = sumConverted(
      [
        { amount: 10000, currency: 'USD', month: '2026-02' },
        { amount: 10000, currency: 'USD', month: '2026-03' },
      ],
      'INR',
      tables,
    );
    // Different months, different rates: the two must not be equal.
    const feb = convert(10000, 'USD', 'INR', tables['2026-02'])!.amount;
    const mar = convert(10000, 'USD', 'INR', tables['2026-03'])!.amount;
    expect(feb).not.toBe(mar);
    expect(result.amount).toBe(feb + mar);
    expect(result.months).toEqual(['2026-02', '2026-03']);
  });

  it('falls back to the latest earlier month for an unpublished one', () => {
    // April is not published yet; it must use March rather than refuse.
    const result = sumConverted([{ amount: 10000, currency: 'USD', month: '2026-04' }], 'INR', tables);
    expect(result.amount).toBe(convert(10000, 'USD', 'INR', MARCH)!.amount);
    expect(result.gaps).toEqual([]);
  });

  it('reports what it could not convert instead of dropping it silently', () => {
    const result = sumConverted(
      [
        { amount: 10000, currency: 'USD', month: '2026-03' },
        { amount: 50000, currency: 'AED', month: '2026-03' },
        { amount: 70000, currency: 'AED', month: '2026-03' },
      ],
      'INR',
      tables,
    );
    expect(result.amount).toBe(837_963);
    expect(result.gaps).toEqual([{ currency: 'AED', month: '2026-03', count: 2 }]);
  });

  it('passes the target currency straight through', () => {
    const result = sumConverted([{ amount: 149900, currency: 'INR', month: null }], 'INR', tables);
    expect(result.amount).toBe(149900);
    expect(result.gaps).toEqual([]);
  });

  it('produces zero, not a crash, with nothing to sum', () => {
    expect(sumConverted([], 'INR', tables).amount).toBe(0);
    expect(sumConverted([], 'INR', {}).amount).toBe(0);
  });
});

describe('month helpers', () => {
  it('recognises only real YYYY-MM strings', () => {
    expect(isYearMonth('2026-03')).toBe(true);
    expect(isYearMonth('2026-13')).toBe(false);
    expect(isYearMonth('2026-00')).toBe(false);
    expect(isYearMonth('2026-03-01')).toBe(false);
    expect(isYearMonth(20263)).toBe(false);
  });

  it('steps across year boundaries in both directions', () => {
    expect(addMonthsToYearMonth('2026-01', -1)).toBe('2025-12');
    expect(addMonthsToYearMonth('2026-12', 1)).toBe('2027-01');
    expect(addMonthsToYearMonth('2026-09', -24)).toBe('2024-09');
  });

  it('takes the month off a date', () => {
    expect(monthOf('2026-03-17')).toBe('2026-03');
  });

  it('resolves to the latest earlier month it holds', () => {
    const held = ['2025-12', '2026-01', '2026-03'];
    expect(resolveMonth('2026-03', held)).toBe('2026-03');
    expect(resolveMonth('2026-02', held)).toBe('2026-01');
    expect(resolveMonth('2026-09', held)).toBe('2026-03');
    expect(resolveMonth('2025-01', held)).toBeNull();
  });
});

describe('ECB CSV parsing', () => {
  it('splits quoted fields without shifting columns', () => {
    expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsvLine('a,"say ""hi""",b')).toEqual(['a', 'say "hi"', 'b']);
  });

  it('locates columns by header name, not position', () => {
    const csv = [
      'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,TIME_PERIOD,OBS_VALUE',
      'EXR.M.USD.EUR.SP00.A,M,USD,EUR,SP00,2026-03,1.0856',
      'EXR.M.INR.EUR.SP00.A,M,INR,EUR,SP00,2026-03,90.4237',
    ].join('\n');

    const rates = parseEcbCsv(csv, '2026-04-01T00:00:00.000Z');
    expect(rates).toHaveLength(2);
    expect(rates[0]).toMatchObject({ month: '2026-03', currency: 'USD', rate: '1.0856' });
    expect(rates[1]).toMatchObject({ month: '2026-03', currency: 'INR', rate: '90.4237' });
  });

  it('survives a reordered header', () => {
    const csv = ['OBS_VALUE,TIME_PERIOD,CURRENCY', '1.0856,2026-03,USD'].join('\n');
    expect(parseEcbCsv(csv, 'now')[0]).toMatchObject({ currency: 'USD', rate: '1.0856' });
  });

  it('drops rows with a blank or unusable observation', () => {
    const csv = [
      'CURRENCY,TIME_PERIOD,OBS_VALUE',
      'USD,2026-03,1.0856',
      'USD,2026-04,',
      'USD,not-a-month,1.09',
      'USD,2026-05,NaN',
    ].join('\n');
    expect(parseEcbCsv(csv, 'now')).toHaveLength(1);
  });

  it('returns nothing for an empty or headerless body', () => {
    expect(parseEcbCsv('', 'now')).toEqual([]);
    expect(parseEcbCsv('just a header line', 'now')).toEqual([]);
    expect(parseEcbCsv('A,B\n1,2', 'now')).toEqual([]);
  });
});
