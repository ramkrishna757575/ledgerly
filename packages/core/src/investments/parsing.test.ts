import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cdsl } from './adapters/cdsl.ts';
import { scripbox } from './adapters/scripbox.ts';
import { toMicro } from './numbers.ts';
import { detectInvestmentAdapter } from './registry.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('CDSL consolidated account statement', () => {
  const parsed = cdsl.parse(fixture('cdsl-cas.txt'));

  it('reads the date, period and the statement\'s own total', () => {
    expect(parsed).toMatchObject({ source: 'cdsl', asOf: '2026-09-30', periodStart: '2026-09-01', statedTotal: 17733250 });
    expect(parsed.warnings).toEqual([]);
  });

  it('reads every holding with its units, price, value and cost', () => {
    expect(parsed.holdings).toHaveLength(3);
    expect(parsed.holdings[0]).toEqual({
      name: 'Demo Liquid Fund - Growth-Regular Plan (Direct Growth)',
      isin: 'INF000D01AA1',
      folio: '11112222',
      schemeCode: '123AB',
      assetClass: 'debt',
      units: toMicro('150.000'),
      nav: toMicro('100.0000'),
      value: 1500000,
      invested: 1400000,
    });
    expect(parsed.holdings[1]).toMatchObject({ isin: 'INF000S02BB2', folio: '3334444/55', units: 1234567000, value: 12193250, invested: 10000000, assetClass: 'equity' });
  });

  it('puts back a folio number that wrapped onto the next line', () => {
    expect(parsed.holdings[2]).toMatchObject({ isin: 'INF000E03CC3', folio: '55556666/7', value: 4040000, invested: 4200000 });
  });

  it('adds up to the statement\'s own total', () => {
    expect(parsed.holdings.reduce((sum, h) => sum + h.value, 0)).toBe(parsed.statedTotal);
  });

  it('reads the transactions of each scheme, with their opening and closing units', () => {
    expect(parsed.blocks.map((b) => [b.schemeCode, b.openingUnits, b.closingUnits, b.rows.length])).toEqual([
      ['123AB', 100_000_000, 150_000_000, 1],
      ['SMIF', 1_000_000_000, 1_234_567_000, 1],
      ['77', 1_000_000_000, 800_000_000, 1],
    ]);
  });

  it('knows a scheme code whether it has digits, is all capitals, or is just numbers', () => {
    expect(parsed.holdings.map((h) => h.schemeCode)).toEqual(['123AB', 'SMIF', '77']);
    expect(parsed.blocks.map((b) => b.schemeCode)).toEqual(['123AB', 'SMIF', '77']);
  });

  it('does not take a wrapped name line for a new scheme', () => {
    expect(parsed.blocks).toHaveLength(3);
  });

  it('works out the kind of each transaction and which way the units went', () => {
    const [sip, purchase, redemption] = parsed.blocks.map((b) => b.rows[0]!);
    expect(sip).toMatchObject({ date: '2026-09-05', kind: 'sip', amount: 500000, units: 50_000_000, nav: 100_000_000 });
    expect(purchase).toMatchObject({ date: '2026-09-10', kind: 'sip', amount: 2345670, units: 234_567_000 });
    expect(redemption).toMatchObject({ date: '2026-09-20', kind: 'redemption', amount: 1000000, units: -200_000_000 });
  });

  it('has units that carry each scheme from its opening to its closing balance', () => {
    for (const block of parsed.blocks) {
      const moved = block.rows.reduce((sum, row) => sum + row.units, 0);
      expect(block.openingUnits! + moved).toBe(block.closingUnits);
    }
  });

  it('flags a holding whose figures disagree with themselves', () => {
    const broken = fixture('cdsl-cas.txt').replace('1,21,932.50', '1,31,932.50');
    expect(cdsl.parse(broken).warnings.join(' ')).toMatch(/does not match|do not add up/);
  });

  it('declines a date it cannot find', () => {
    expect(() => cdsl.parse('CONSOLIDATED ACCOUNT STATEMENT\nnothing else')).toThrow(/date/);
  });
});

describe('CDSL consolidated account statement, newer layout', () => {
  // Same statement family, but no distributor column: each row is the ISIN, folio, then six figures,
  // and the scheme name wraps over the lines above and below the row.
  const parsed = cdsl.parse(fixture('cdsl-cas-v2.txt'));

  it('reads every holding and checks the total against the statement', () => {
    expect(parsed).toMatchObject({ source: 'cdsl', asOf: '2026-09-30', statedTotal: 3_512_010 });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.holdings).toHaveLength(3);
    expect(parsed.holdings.reduce((sum, h) => sum + h.value, 0)).toBe(3_512_010);
  });

  it('puts the wrapped scheme name back together without the figures or the next scheme', () => {
    expect(parsed.holdings.map((h) => [h.schemeCode, h.name])).toEqual([
      ['DLF', 'Demo Liquid Fund - Growth- Regular Plan (Formerly known as Demo Savings Fund)'],
      ['SIF', 'Sample Index Fund - Regular Plan - Growth'],
      ['77', 'Example Debt Fund - Regular Plan Growth'],
    ]);
  });

  it('reads units, price, value, cost and the folio, including a loss', () => {
    expect(parsed.holdings[0]).toMatchObject({ isin: 'INF000D01AA1', folio: '11112222/95', units: 100_000_000, nav: 150_000_000, value: 1_500_000, invested: 1_200_000 });
    expect(parsed.holdings[2]).toMatchObject({ isin: 'INF000E01CC3', value: 1_005_000, invested: 1_100_000 });
  });

  it('still reads the month\'s transactions, and is picked by the same adapter', () => {
    expect(parsed.blocks[0]!.rows).toHaveLength(1);
    expect(detectInvestmentAdapter(fixture('cdsl-cas-v2.txt'))?.id).toBe('cas-cdsl');
  });
});

describe('Scripbox portfolio report', () => {
  const parsed = scripbox.parse(fixture('scripbox-portfolio.txt'));

  it('reads the date and checks its own totals', () => {
    expect(parsed).toMatchObject({ source: 'scripbox', asOf: '2026-11-09', statedTotal: 17857500 });
    expect(parsed.holdings.reduce((sum, h) => sum + h.value, 0)).toBe(17857500);
    expect(parsed.warnings).toEqual([]);
  });

  it('reads each fund with what was invested, what it is worth, and its return', () => {
    expect(parsed.holdings).toEqual([
      { name: 'Demo Liquid Fund Growth', folio: '11112222', assetClass: 'debt', units: 150_000_000, nav: 102_000_000, value: 1530000, invested: 1400000, xirrBps: 750 },
      { name: 'Example Debt Fund - Regular Growth', folio: '55556666/7', assetClass: 'debt', units: 800_000_000, nav: 49_000_000, value: 3920000, invested: 4200000, xirrBps: -410 },
      { name: 'Sample Index Fund', folio: '3334444/55', assetClass: 'equity', units: 1_234_570_000, nav: 100_500_000, value: 12407500, invested: 10000000, xirrBps: 1820 },
    ]);
  });

  it('takes the asset class from the section it is in', () => {
    expect(parsed.holdings.map((h) => h.assetClass)).toEqual(['debt', 'debt', 'equity']);
  });
});

describe('recognising a statement', () => {
  it('picks the right adapter, and none for anything else', () => {
    expect(detectInvestmentAdapter(fixture('cdsl-cas.txt'))?.id).toBe('cas-cdsl');
    expect(detectInvestmentAdapter(fixture('scripbox-portfolio.txt'))?.id).toBe('scripbox-portfolio');
    expect(detectInvestmentAdapter('Dear customer, your order has shipped.')).toBeUndefined();
  });
});
