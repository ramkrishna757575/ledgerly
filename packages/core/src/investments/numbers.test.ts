import { describe, expect, it } from 'vitest';
import { toBps, toMicro, valueOf } from './numbers.ts';
import { xirr } from './xirr.ts';

describe('numbers', () => {
  it('reads units and prices exactly', () => {
    expect(toMicro('1,234.567')).toBe(1_234_567_000);
    expect(toMicro('0.5')).toBe(500_000);
    expect(toMicro('.85')).toBe(850_000);
    expect(toMicro('12')).toBe(12_000_000);
    expect(toMicro('1,00,000.1234')).toBe(100_000_123_400);
  });

  it('reads negatives written with a minus or brackets, and ignores soft hyphens', () => {
    expect(toMicro('-9,999.9')).toBe(-9_999_900_000);
    expect(toMicro('(10.000)')).toBe(-10_000_000);
    expect(toMicro('12­3.4')).toBe(123_400_000);
  });

  it('rejects text that is not a number', () => {
    expect(() => toMicro('abc')).toThrow();
    expect(() => toMicro('1.2.3')).toThrow();
    expect(() => toMicro('1.1234567')).toThrow(/decimals/);
  });

  it('works out a value in paise, even where plain numbers would lose digits', () => {
    expect(valueOf(toMicro('100.000'), toMicro('25.5'))).toBe(255_000);
    expect(valueOf(toMicro('1234.567'), toMicro('98.7654'))).toBe(12_193_250);
    // 1,000 units at about 99,999 rupees each is beyond 2^53 in millionths.
    expect(valueOf(toMicro('1000'), toMicro('99999.999999'))).toBe(10_000_000_000);
  });

  it('reads percentages as basis points', () => {
    expect(toBps('12.34 %')).toBe(1234);
    expect(toBps('*-9.9 %')).toBe(-990);
    expect(toBps('9%')).toBe(900);
  });
});

describe('xirr', () => {
  it('gives the annual return of one purchase held for a year', () => {
    const rate = xirr([{ date: '2025-01-01', amount: -100000 }, { date: '2026-01-01', amount: 110000 }]);
    expect(rate).toBeCloseTo(0.1, 4);
  });

  it('weights each instalment by how long it was invested', () => {
    // Twelve monthly instalments of 1,000, worth 13,000 at the end of the year.
    const flows = Array.from({ length: 12 }, (_, i) => ({ date: `2025-${String(i + 1).padStart(2, '0')}-01`, amount: -1000 }));
    const rate = xirr([...flows, { date: '2026-01-01', amount: 13000 }])!;
    expect(rate).toBeGreaterThan(0.14);
    expect(rate).toBeLessThan(0.18);
  });

  it('handles a loss and money taken out along the way', () => {
    expect(xirr([{ date: '2025-01-01', amount: -100000 }, { date: '2026-01-01', amount: 90000 }])).toBeCloseTo(-0.1, 4);
    const rate = xirr([
      { date: '2025-01-01', amount: -100000 },
      { date: '2025-07-01', amount: 20000 },
      { date: '2026-01-01', amount: 95000 },
    ])!;
    expect(rate).toBeGreaterThan(0.1);
  });

  it('says nothing when there is no sensible answer', () => {
    expect(xirr([])).toBeUndefined();
    expect(xirr([{ date: '2025-01-01', amount: -100 }])).toBeUndefined();
    expect(xirr([{ date: '2025-01-01', amount: 100 }, { date: '2026-01-01', amount: 100 }])).toBeUndefined();
    expect(xirr([{ date: '2025-01-01', amount: -100 }, { date: '2025-01-01', amount: 120 }])).toBeUndefined();
  });
});
