import { openDb } from '@ledgerly/db';
import { describe, expect, it } from 'vitest';
import { seedDefaults } from '../seed.ts';
import { csv } from './adapters/csv.ts';
import { commitInvestmentImport, getHoldings, stageInvestmentStatement } from './portfolio.ts';
import { detectInvestmentAdapter } from './registry.ts';

const BROKER = `Instrument,Qty.,Avg. cost,LTP,Cur. val,P&L,Net chg.
Sample Corp Ltd,10,1500.00,1650.50,16505.00,1505.00,10.03
"Another Co, Limited",5,200.5,190,950,-52.5,-5.2
Total,,,,17455.00,,
`;

const FUNDS = `Scheme Name\tISIN\tFolio No\tUnits\tNAV\tCurrent Value\tInvested Amount\tCategory
Sample Index Fund - Direct - Growth\tINF000S02BB2\t3334444/55\t1,234.567\t98.7654\t1,21,932.50\t1,00,000.00\tEquity
Demo Gilt Fund\tINF000D01AA1\t11112222\t150\t100\t15,000\t14,000\tDebt
`;

describe('holdings CSV', () => {
  it('reads a broker export, with a quoted comma, a total row and average cost', () => {
    const parsed = csv.parse(BROKER);
    expect(parsed.holdings).toMatchObject([
      { name: 'Sample Corp Ltd', units: 10_000_000, nav: 1_650_500_000, value: 16_505_00, invested: 15_000_00, assetClass: 'equity' },
      { name: 'Another Co, Limited', value: 950_00, invested: 1_002_50 },
    ]);
    expect(parsed.holdings).toHaveLength(2);
  });

  it('reads a tab separated fund export with Indian digit grouping and ISINs', () => {
    const parsed = csv.parse(FUNDS);
    expect(parsed.holdings).toMatchObject([
      { name: 'Sample Index Fund - Direct - Growth', isin: 'INF000S02BB2', folio: '3334444/55', units: 1_234_567_000, value: 1_21_932_50, invested: 1_00_000_00, assetClass: 'equity' },
      { isin: 'INF000D01AA1', value: 15_000_00, assetClass: 'debt' },
    ]);
  });

  it('is recognised by its header, and does not claim other text', () => {
    expect(detectInvestmentAdapter(BROKER)?.id).toBe('csv-holdings');
    expect(detectInvestmentAdapter('hello\nworld')).toBeUndefined();
    expect(csv.detect('%PDF-1.4 anything, units, name')).toBe(0);
    expect(() => csv.parse('a,b,c\n1,2,3')).toThrow();
  });

  it('skips rows it cannot read, says so, and imports into the portfolio', () => {
    const db = openDb(':memory:');
    seedDefaults(db);
    const text = `${BROKER}Broken Co,abc,1,2,3\n`;
    const staged = stageInvestmentStatement(db, { text, file: { sha256: 'csv1', filename: 'holdings.csv', mimeType: 'text/csv', size: text.length, storedName: 'csv1.csv' } });
    expect(staged.warnings.join(' ')).toMatch(/could not be read|skipped/);
    commitInvestmentImport(db, staged.id);
    expect(getHoldings(db).holdings.map((h) => h.name).sort()).toEqual(['Another Co, Limited', 'Sample Corp Ltd']);
  });
});
