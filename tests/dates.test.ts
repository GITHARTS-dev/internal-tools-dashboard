import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  advanceByCycle,
  daysBetween,
  daysInMonth,
  formatDate,
  isIsoDate,
  isoWeekday,
  nextOccurrenceOnOrAfter,
  relativeDays,
  todayInTimezone,
} from '../src/shared/dates';

describe('isIsoDate', () => {
  it('accepts real calendar days', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true); // leap year
  });

  it('rejects days that do not exist', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-02-29')).toBe(false); // 2026 is not a leap year
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-00-10')).toBe(false);
    expect(isIsoDate('26-01-01')).toBe(false);
    expect(isIsoDate('2026-1-1')).toBe(false);
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(20260101)).toBe(false);
  });
});

describe('daysBetween', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-01-01', '2026-01-02')).toBe(1);
    expect(daysBetween('2026-01-02', '2026-01-01')).toBe(-1);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('is exact across month and year boundaries', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366); // leap year
  });

  it('is unaffected by daylight-saving transitions', () => {
    // US DST begins 2026-03-08; a naive local-time implementation returns 6.97
    // days here and rounds wrong.
    expect(daysBetween('2026-03-05', '2026-03-12')).toBe(7);
    // Europe DST ends 2026-10-25.
    expect(daysBetween('2026-10-22', '2026-10-29')).toBe(7);
  });
});

describe('addMonths', () => {
  it('clamps to the end of a shorter target month', () => {
    // The bug this prevents: a monthly renewal on the 31st silently walking
    // forward to the 3rd of the following month, every single month.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // leap year
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonths('2026-05-31', 1)).toBe('2026-06-30');
  });

  it('does not accumulate drift when clamping repeatedly', () => {
    // Anchored on the original date each time, Jan 31 -> Mar 31, not Mar 28.
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
  });

  it('crosses year boundaries in both directions', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-01-31', -2)).toBe('2025-11-30');
    expect(addMonths('2026-03-15', -14)).toBe('2025-01-15');
  });
});

describe('addDays', () => {
  it('handles month, year and leap boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-01', -30)).toBe('2026-01-30');
  });
});

describe('daysInMonth', () => {
  it('knows February', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400
    expect(daysInMonth(1900, 2)).toBe(28); // divisible by 100, not 400
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('advanceByCycle', () => {
  it('advances by one billing period', () => {
    expect(advanceByCycle('2026-01-15', 'monthly')).toBe('2026-02-15');
    expect(advanceByCycle('2026-01-15', 'quarterly')).toBe('2026-04-15');
    expect(advanceByCycle('2026-01-15', 'annual')).toBe('2027-01-15');
  });

  it('returns null for cycles with no fixed period', () => {
    expect(advanceByCycle('2026-01-15', 'one_time')).toBeNull();
    expect(advanceByCycle('2026-01-15', 'custom')).toBeNull();
  });
});

describe('nextOccurrenceOnOrAfter', () => {
  it('rolls a stale date forward to the next real occurrence', () => {
    // A monthly renewal nobody has touched for eight months should read as
    // "due soon", not "240 days overdue".
    expect(nextOccurrenceOnOrAfter('2026-01-10', 'monthly', '2026-09-18')).toBe('2026-10-10');
    expect(nextOccurrenceOnOrAfter('2024-03-01', 'annual', '2026-09-18')).toBe('2027-03-01');
    expect(nextOccurrenceOnOrAfter('2026-01-15', 'quarterly', '2026-09-18')).toBe('2026-10-15');
  });

  it('leaves a future date alone', () => {
    expect(nextOccurrenceOnOrAfter('2026-12-01', 'monthly', '2026-09-18')).toBe('2026-12-01');
  });

  it('returns today when the occurrence is today', () => {
    expect(nextOccurrenceOnOrAfter('2026-09-18', 'monthly', '2026-09-18')).toBe('2026-09-18');
  });

  it('preserves month-end clamping while rolling forward', () => {
    expect(nextOccurrenceOnOrAfter('2026-01-31', 'monthly', '2026-02-15')).toBe('2026-02-28');
  });

  it('cannot roll a one-off payment forward', () => {
    expect(nextOccurrenceOnOrAfter('2026-01-10', 'one_time', '2026-09-18')).toBeNull();
    expect(nextOccurrenceOnOrAfter('2026-12-10', 'one_time', '2026-09-18')).toBe('2026-12-10');
  });
});

describe('todayInTimezone', () => {
  it('resolves the calendar day for the business timezone, not UTC', () => {
    // 2026-09-18 20:00 UTC is already the 19th in Kolkata (+05:30).
    const at = new Date('2026-09-18T20:00:00Z');
    expect(todayInTimezone('Asia/Kolkata', at)).toBe('2026-09-19');
    expect(todayInTimezone('UTC', at)).toBe('2026-09-18');
    expect(todayInTimezone('America/Los_Angeles', at)).toBe('2026-09-18');
  });

  it('handles the moment just before midnight in Kolkata', () => {
    // 18:29 UTC is 23:59 IST on the same day; one minute later it flips.
    expect(todayInTimezone('Asia/Kolkata', new Date('2026-09-18T18:29:00Z'))).toBe('2026-09-18');
    expect(todayInTimezone('Asia/Kolkata', new Date('2026-09-18T18:31:00Z'))).toBe('2026-09-19');
  });

  it('falls back to UTC rather than throwing on a bad timezone', () => {
    // A typo in settings must not take the whole reminder job down.
    expect(todayInTimezone('Not/AZone', new Date('2026-09-18T12:00:00Z'))).toBe('2026-09-18');
  });
});

describe('isoWeekday', () => {
  it('returns 1 for Monday through 7 for Sunday', () => {
    expect(isoWeekday('2026-09-14')).toBe(1); // Monday
    expect(isoWeekday('2026-09-20')).toBe(7); // Sunday
  });
});

describe('formatting', () => {
  it('formats dates unambiguously', () => {
    expect(formatDate('2026-02-09')).toBe('9 Feb 2026');
    expect(formatDate(null)).toBe('--');
    expect(formatDate('nonsense')).toBe('--');
  });

  it('describes day offsets in words', () => {
    expect(relativeDays(0)).toBe('today');
    expect(relativeDays(1)).toBe('tomorrow');
    expect(relativeDays(-1)).toBe('yesterday');
    expect(relativeDays(12)).toBe('in 12 days');
    expect(relativeDays(-3)).toBe('3 days ago');
  });
});
