import { investmentImports, investmentTransactions, openDb, positions } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from './accounts.ts';
import { EARLIER_RATES, RATES, capitalGains, capitalGainsCsv, deductions, fyOf, fyRange, setSectionMap, taxSummary } from './tax.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';
import { createSimpleTransaction } from './transactions.ts';

let db: ReturnType<typeof openDb>;
let importId: number;
let n = 0;

function fund(name: string, assetClass: 'equity' | 'debt' | 'gold' = 'equity') {
  return db.insert(positions).values({ name, assetClass }).returning().get().id;
}
function trade(positionId: number, date: string, kind: 'purchase' | 'sip' | 'redemption', rupees: number, units: number) {
  db.insert(investmentTransactions)
    .values({ importId, positionId, date, kind, amount: rupees * 100, units: Math.round(units * 1_000_000) * (kind === 'redemption' ? -1 : 1), description: kind, fingerprint: `f${n++}` })
    .run();
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  importId = db.insert(investmentImports).values({ source: 'cdsl', asOf: '2026-11-01', payload: {} as never, warnings: [] }).returning().get().id;
});

describe('financial years', () => {
  it('runs April to March', () => {
    expect(fyOf('2026-03-31')).toBe('2025-26');
    expect(fyOf('2026-04-01')).toBe('2026-27');
    expect(fyOf('2027-01-15')).toBe('2026-27');
    expect(fyRange('2026-27')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });
});

describe('capital gains', () => {
  it('works out gains first in, first out, with long and short term by holding period', () => {
    const f = fund('Index Fund');
    trade(f, '2024-01-10', 'purchase', 10_000, 100); // 100 each
    trade(f, '2026-05-10', 'purchase', 20_000, 100); // 200 each
    trade(f, '2026-09-01', 'redemption', 45_000, 150); // 300 each: all of lot 1, half of lot 2
    const g = capitalGains(db, '2026-27');
    expect(g.sales).toHaveLength(2);
    expect(g.sales[0]).toMatchObject({ term: 'long', cost: 10_000_00, proceeds: 30_000_00, gain: 20_000_00 });
    expect(g.sales[1]).toMatchObject({ term: 'short', cost: 10_000_00, proceeds: 15_000_00, gain: 5_000_00, heldDays: 114 });
    expect(g.complete).toBe(true);
    expect(g.equity).toMatchObject({ shortTermGain: 5_000_00, longTermGain: 20_000_00, longTermExempt: 20_000_00 });
    // Short-term gain at 20%; the long-term gain is under the exemption.
    expect(g.equity.estimatedTax).toBe(Math.round(5_000_00 * RATES.equityShortTerm));
    expect(capitalGains(db, '2025-26').sales).toEqual([]);
  });

  it('applies the long-term exemption and taxes only the rest', () => {
    const f = fund('Big Winner');
    trade(f, '2020-01-01', 'purchase', 1_00_000, 1000);
    trade(f, '2026-06-01', 'redemption', 3_00_000, 1000);
    const g = capitalGains(db, '2026-27');
    expect(g.equity.longTermGain).toBe(2_00_000_00);
    expect(g.equity.estimatedTax).toBe(Math.round((2_00_000_00 - RATES.equityLongTermExemption) * RATES.equityLongTerm));
  });

  it('sets a short-term loss against a long-term gain, and carries a long-term loss forward', () => {
    const a = fund('Winner');
    const b = fund('Loser');
    trade(a, '2020-01-01', 'purchase', 1_00_000, 100);
    trade(a, '2026-06-01', 'redemption', 3_00_000, 100);
    trade(b, '2026-03-01', 'purchase', 1_00_000, 100);
    trade(b, '2026-07-01', 'redemption', 60_000, 100);
    expect(capitalGains(db, '2026-27').equity).toMatchObject({ shortTermGain: 0, longTermGain: 2_00_000_00 - 40_000_00 });

    const c = fund('Old loser');
    trade(c, '2019-01-01', 'purchase', 1_00_000, 100);
    trade(c, '2026-07-01', 'redemption', 50_000, 100);
    const after = capitalGains(db, '2026-27').equity;
    expect(after.longTermGain).toBe(2_00_000_00 - 40_000_00 - 50_000_00);
    expect(after.lossToCarryForward).toBe(0);
  });

  it('says when a sale reaches past the purchases it knows about', () => {
    const f = fund('Old Holding');
    trade(f, '2026-08-01', 'purchase', 10_000, 100);
    trade(f, '2026-09-01', 'redemption', 30_000, 300);
    const g = capitalGains(db, '2026-27');
    expect(g.complete).toBe(false);
    expect(g.unmatchedProceeds).toBe(20_000_00);
    expect(g.sales).toHaveLength(1);
  });

  it('keeps debt and other funds out of the equity estimate', () => {
    const f = fund('Debt Fund', 'debt');
    trade(f, '2025-01-01', 'purchase', 1_00_000, 1000);
    trade(f, '2026-06-01', 'redemption', 1_20_000, 1000);
    const g = capitalGains(db, '2026-27');
    expect(g.equity.estimatedTax).toBe(0);
    expect(g.other).toMatchObject({ gain: 20_000_00 });
  });
});

describe('rates that changed in July 2024', () => {
  it('uses the old rates and the ₹1 lakh exemption for a year before the change', () => {
    const f = fund('Old Year Fund');
    trade(f, '2021-01-01', 'purchase', 1_00_000, 1000);
    trade(f, '2023-06-01', 'redemption', 2_50_000, 1000); // 1.5 lakh long-term gain
    const g = capitalGains(db, '2023-24');
    expect(g.equity.exemption).toBe(EARLIER_RATES.equityLongTermExemption);
    expect(g.equity.estimatedTax).toBe(Math.round((1_50_000_00 - EARLIER_RATES.equityLongTermExemption) * EARLIER_RATES.equityLongTerm));
  });

  it('blends the two rates in a year that has sales on both sides of the change', () => {
    const f = fund('Mixed Year Fund');
    trade(f, '2024-01-01', 'purchase', 1_00_000, 1000);
    trade(f, '2024-05-01', 'redemption', 1_10_000, 500); // before the change: a 60,000 short-term gain
    trade(f, '2024-09-01', 'redemption', 1_20_000, 500); // after it: a 70,000 short-term gain
    const g = capitalGains(db, '2024-25');
    expect(g.equity.shortTermGain).toBe(60_000_00 + 70_000_00);
    expect(g.equity.shortTermRate).toBeCloseTo((60_000 * 0.15 + 70_000 * 0.2) / 130_000, 5);
    expect(g.equity.exemption).toBe(RATES.equityLongTermExemption);
  });
});

describe('the capital gains file for filing', () => {
  it('lists each sale with its ISIN, dates and plain numbers', () => {
    const f = db.insert(positions).values({ name: '=Evil Fund', isin: 'INF000A00001', assetClass: 'equity' }).returning().get().id;
    trade(f, '2025-01-01', 'purchase', 1_00_000, 100);
    trade(f, '2026-06-01', 'redemption', 1_30_000, 100);
    const lines = capitalGainsCsv(db, '2026-27').trim().split('\r\n');
    expect(lines[0]).toMatch(/^Fund,ISIN,Fund type,Bought on,Sold on,Units,Cost/);
    expect(lines[1]).toBe("'=Evil Fund,INF000A00001,equity,2025-01-01,2026-06-01,100.000,100000.00,130000.00,30000.00,516,Long term");
  });
});

describe('deductions', () => {
  it('adds up the categories you assign to each section, and tax-saving fund purchases, against the limits', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 10_00_000_00, openingDate: '2026-01-01' }).id;
    const ins = listAccounts(db).find((a) => a.name === 'Insurance')!.id;
    const edu = listAccounts(db).find((a) => a.name === 'Education')!.id;
    const pay = (date: string, counter: number, amount: number) =>
      createSimpleTransaction(db, { date, description: 'x', kind: 'expense', accountId: bank, counterAccountId: counter, amount } as never);
    pay('2026-05-01', ins, 60_000_00);
    pay('2026-06-01', edu, 40_000_00);
    pay('2026-03-01', ins, 99_000_00); // last financial year
    const elss = fund('Axis ELSS Tax Saver Fund');
    trade(elss, '2026-08-01', 'sip', 30_000, 100);
    setSectionMap(db, { [String(ins)]: '80C', [String(edu)]: '80C' });

    const c80 = deductions(db, '2026-27').find((d) => d.section === '80C')!;
    expect(c80.total).toBe(60_000_00 + 40_000_00 + 30_000_00);
    expect(c80).toMatchObject({ limit: 150_000_00, counted: 130_000_00, room: 20_000_00 });
    expect(c80.parts.map((p) => p.source).sort()).toEqual(['Education', 'Insurance', 'Tax-saving (ELSS) fund purchases']);
    expect(deductions(db, '2025-26').find((d) => d.section === '80C')!.total).toBe(99_000_00);

    // Over the limit counts only up to it.
    pay('2026-07-01', ins, 80_000_00);
    expect(deductions(db, '2026-27').find((d) => d.section === '80C')).toMatchObject({ counted: 150_000_00, room: 0 });
  });

  it('rejects an unknown section and returns a full summary', () => {
    expect(() => setSectionMap(db, { '1': '80Z' as never })).toThrow(/Unknown section/);
    expect(taxSummary(db, '2026-27')).toMatchObject({ fy: '2026-27', gains: { complete: true }, categories: expect.any(Array) });
  });
});
