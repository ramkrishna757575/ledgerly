import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from '../accounts.ts';
import { commitInvestmentImport, getInvestmentSample, stageInvestmentStatement } from '../investments/index.ts';
import { ensureStarterCategories, seedDefaults } from '../seed.ts';
import { setSetting } from '../settings.ts';
import { createSimpleTransaction } from '../transactions.ts';
import { portfolioReview, setTarget } from './review.ts';
import { BUFFER_KEY, getBufferMonths, monthlyPattern, surplusCash } from './surplus.ts';

let db: ReturnType<typeof openDb>;
let bank: number;
const cat = (name: string) => listAccounts(db).find((a) => a.name === name && a.type === 'expense')!.id;
const salary = () => listAccounts(db).find((a) => a.name === 'Salary')!.id;
const TODAY = '2026-11-10';

function spend(date: string, amount: number, name = 'Rent') {
  createSimpleTransaction(db, { date, description: name, kind: 'expense', accountId: bank, counterAccountId: cat(name), amount } as never);
}
function earn(date: string, amount: number) {
  createSimpleTransaction(db, { date, description: 'Salary', kind: 'income', accountId: bank, counterAccountId: salary(), amount } as never);
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 10_00_000_00, openingDate: '2026-01-01' }).id;
});

describe('surplus cash', () => {
  it('is unknown until there is a full month of history', () => {
    spend('2026-11-02', 20_000_00);
    expect(surplusCash(db, { today: TODAY })).toMatchObject({ status: 'unknown', surplus: null, liquid: 10_00_000_00 - 20_000_00 });
  });

  it('keeps a buffer of months of spending and reports what is left over', () => {
    for (const m of ['08', '09', '10']) {
      spend(`2026-${m}-05`, 30_000_00);
      earn(`2026-${m}-01`, 1_00_000_00);
    }
    const result = surplusCash(db, { today: TODAY });
    // 10,00,000 + 3 x 70,000 saved = 12,10,000. Spending averages 30,000, so a 6 month buffer is
    // 1,80,000. The rent due on 5 Nov has not been seen yet, so it is held back too.
    expect(result).toMatchObject({ status: 'surplus', bufferMonths: 6, buffer: 1_80_000_00, billsDue: 30_000_00, pattern: { monthsOfData: 3, spending: 30_000_00, income: 1_00_000_00 } });
    expect(result.surplus).toBe(12_10_000_00 - 30_000_00 - 1_80_000_00);
    expect(result.monthsCovered).toBeCloseTo((12_10_000 - 30_000) / 30_000, 0);
    expect(result.pattern.savingsRate).toBeCloseTo(0.7, 5);
  });

  it('reports a shortfall when the buffer is not yet full, and honours the setting', () => {
    const small = createAccount(db, { name: 'Small', type: 'asset', subtype: 'bank', openingBalance: 50_000_00, openingDate: '2026-01-01' }).id;
    void small;
    for (const m of ['09', '10']) spend(`2026-${m}-05`, 1_00_000_00);
    expect(surplusCash(db, { today: TODAY })).toMatchObject({ status: 'surplus' }); // 10 lakh opening dominates
    setSetting(db, BUFFER_KEY, '12');
    expect(getBufferMonths(db)).toBe(12);
    const twelve = surplusCash(db, { today: TODAY });
    expect(twelve.buffer).toBe(12 * 1_00_000_00);
    expect(twelve.status).toBe('short');
    expect(twelve.surplus).toBeLessThan(0);
  });

  it('deducts card balances owed and bills due soon, and ignores months with no data', () => {
    const card = createAccount(db, { name: 'Card', type: 'liability', subtype: 'credit_card', openingBalance: 40_000_00, openingDate: '2026-01-01' }).id;
    void card;
    for (const m of ['08', '09', '10']) spend(`2026-${m}-12`, 10_000_00, 'Utilities');
    const result = surplusCash(db, { today: TODAY });
    expect(result.cardsOwed).toBe(40_000_00);
    expect(result.billsDue).toBe(10_000_00); // next utilities payment is due 12 Nov
    expect(result.surplus).toBe(10_00_000_00 - 30_000_00 - 40_000_00 - 10_000_00 - 6 * 10_000_00);
    expect(monthlyPattern(db, TODAY).monthsOfData).toBe(3);
  });
});

describe('portfolio review', () => {
  it('has nothing to say without holdings', () => {
    expect(portfolioReview(db)).toEqual({ hasPortfolio: false });
  });

  it('shows allocation, drift from a target and facts worth knowing', () => {
    commitInvestmentImport(db, stageInvestmentStatement(db, getInvestmentSample('cdsl')!).id);
    const review = portfolioReview(db, { today: '2026-11-10' });
    if (!review.hasPortfolio) throw new Error('expected a portfolio');
    expect(review.allocation.map((a) => a.assetClass).sort()).toEqual(['debt', 'equity']);
    expect(review.drift).toBeNull();

    setTarget(db, { equity: 60, debt: 30, gold: 10 });
    const withTarget = portfolioReview(db, { today: '2026-12-10' });
    if (!withTarget.hasPortfolio) throw new Error('expected a portfolio');
    const by = Object.fromEntries(withTarget.drift!.map((d) => [d.assetClass, d]));
    expect(by.gold).toMatchObject({ actual: 0, target: 0.1 });
    expect(by.equity!.difference).toBeCloseTo(0.0876, 2);
    expect(by.gold!.amount).toBeLessThan(0);
    // The sample statement is from September, so values look stale by December.
    expect(withTarget.observations.some((o) => o.key === 'stale')).toBe(true);
  });

  it('validates a target', () => {
    expect(() => setTarget(db, { equity: 60, debt: 30 })).toThrow(/add up to 100/);
    expect(() => setTarget(db, { equity: 150, debt: -50 })).toThrow(/between 0 and 100/);
    expect(() => setTarget(db, { crypto: 100 } as never)).toThrow(/Unknown asset class/);
    setTarget(db, { equity: 100 });
    setTarget(db, null);
  });
});
