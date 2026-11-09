import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from './accounts.ts';
import { portfolioReview, setTarget } from './analysis/review.ts';
import { buildSnapshot } from './analysis/run.ts';
import { createAsset, depositValue, maturityValue } from './assets.ts';
import { forecast } from './forecast.ts';
import { seedDefaults } from './seed.ts';
import { fdInterest, taxSummary } from './tax.ts';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
});

describe('deposit maturities in the forecast', () => {
  it('pays the maturity value into the bank on the day, and ignores one outside the window', () => {
    createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 1_00_000_00, openingDate: '2026-01-01' });
    const id = createAsset(db, { name: 'SBI FD', kind: 'fd', value: 0, invested: 2_00_000_00, rateBps: 700, startDate: '2025-12-01', maturityDate: '2026-12-01', asOf: '2026-11-10' });
    createAsset(db, { name: 'Far FD', kind: 'fd', value: 0, invested: 1_00_000_00, rateBps: 700, startDate: '2026-01-01', maturityDate: '2027-09-01', asOf: '2026-11-10' });
    const expected = depositValue(2_00_000_00, 700, '2025-12-01', '2026-12-01');
    expect(maturityValue(db, id)).toBe(expected);

    const f = forecast(db, { today: '2026-11-10', days: 60 });
    const maturities = f.events.filter((e) => e.label.startsWith('Matures:'));
    expect(maturities).toEqual([{ date: '2026-12-01', label: 'Matures: SBI FD', amount: expected, kind: 'income' }]);
    expect(f.end).toBe(f.start + expected);
  });
});

describe('the mix across all investments', () => {
  it('counts deposits, PPF, NPS, stocks and gold, and leaves property out', () => {
    createAsset(db, { name: 'Bank FD', kind: 'fd', value: 2_00_000_00 });
    createAsset(db, { name: 'PPF', kind: 'ppf', value: 2_00_000_00 });
    createAsset(db, { name: 'NPS', kind: 'nps', value: 1_00_000_00 });
    createAsset(db, { name: 'Shares', kind: 'stocks', value: 4_00_000_00 });
    createAsset(db, { name: 'Gold coins', kind: 'gold', value: 1_00_000_00 });
    createAsset(db, { name: 'Flat', kind: 'property', value: 80_00_000_00 });

    const review = portfolioReview(db, { today: '2026-11-10' });
    if (!review.hasPortfolio) throw new Error('expected a portfolio');
    expect(review.totalValue).toBe(10_00_000_00);
    expect(review.otherAssetsValue).toBe(10_00_000_00);
    const share = Object.fromEntries(review.allocation.map((a) => [a.assetClass, a.share]));
    expect(share).toEqual({ debt: 0.4, hybrid: 0.1, equity: 0.4, gold: 0.1 });
    expect(review.holdings).toEqual([]);

    setTarget(db, { equity: 50, debt: 40, gold: 10 });
    const withTarget = portfolioReview(db, { today: '2026-11-10' });
    if (!withTarget.hasPortfolio) throw new Error('expected a portfolio');
    const by = Object.fromEntries(withTarget.drift!.map((d) => [d.assetClass, d]));
    expect(by.equity).toMatchObject({ actual: 0.4, target: 0.5 });
    expect(by.equity!.amount).toBe(-1_00_000_00);
    expect(by.hybrid!.target).toBe(0);

    const snapshot = buildSnapshot(db, { today: '2026-11-10' });
    expect(snapshot.portfolio?.otherAssetsInMixRupees).toBe(1_000_000);
    expect(JSON.stringify(snapshot)).not.toMatch(/Bank FD|Gold coins|Flat/);
  });

  it('is still nothing at all when there is nothing to count', () => {
    expect(portfolioReview(db)).toEqual({ hasPortfolio: false });
    createAsset(db, { name: 'Flat', kind: 'property', value: 80_00_000_00 });
    expect(portfolioReview(db)).toEqual({ hasPortfolio: false });
  });
});

describe('fixed deposit interest in the tax view', () => {
  it('counts the interest earned inside the year, from the later of start and April', () => {
    createAsset(db, { name: 'Old FD', kind: 'fd', value: 0, invested: 5_00_000_00, rateBps: 700, startDate: '2025-10-01', maturityDate: '2027-10-01', asOf: '2026-11-10' });
    createAsset(db, { name: 'Ended FD', kind: 'fd', value: 0, invested: 1_00_000_00, rateBps: 700, startDate: '2025-01-01', maturityDate: '2026-04-30', asOf: '2026-11-10' });
    createAsset(db, { name: 'Manual', kind: 'gold', value: 1_00_000_00 });

    const past = fdInterest(db, '2025-26', { today: '2026-11-10' });
    const old = past.items.find((i) => i.name === 'Old FD')!;
    expect(old).toMatchObject({ from: '2025-10-01', to: '2026-03-31' });
    expect(old.interest).toBe(depositValue(5_00_000_00, 700, '2025-10-01', '2026-03-31') - 5_00_000_00);

    const now = fdInterest(db, '2026-27', { today: '2026-11-10' });
    expect(now.items.map((i) => i.name).sort()).toEqual(['Ended FD', 'Old FD']);
    expect(now.items.find((i) => i.name === 'Ended FD')).toMatchObject({ from: '2026-04-01', to: '2026-04-30' });
    expect(now.items.find((i) => i.name === 'Old FD')!.to).toBe('2026-11-10');
    expect(now.upToToday).toBe(true);
    expect(now.overTdsLimit).toBe(now.total > 40_000_00);
    expect(fdInterest(db, '2023-24', { today: '2026-11-10' }).items).toEqual([]);
    expect(taxSummary(db, '2026-27').fdInterest.items.length).toBeGreaterThan(0);
  });
});
