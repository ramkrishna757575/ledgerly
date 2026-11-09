import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { getBalances, getNetWorth } from './accounts.ts';
import { accrueDeposits, createAsset, deleteAsset, depositValue, listAssets, updateAssetValue } from './assets.ts';
import { computeInsights } from './insights.ts';
import { getCashFlow } from './accounts.ts';
import { seedDefaults } from './seed.ts';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
});

describe('other assets', () => {
  it('adds an asset worth more than was put in, and counts it in net worth without calling the gain income', () => {
    const id = createAsset(db, { name: 'Flat', kind: 'property', value: 80_00_000_00, invested: 60_00_000_00, startDate: '2020-01-01', asOf: '2026-11-01' });
    expect(listAssets(db).items).toMatchObject([{ accountId: id, name: 'Flat', value: 80_00_000_00, invested: 60_00_000_00, gain: 20_00_000_00 }]);
    expect(getNetWorth(db).netWorth).toBe(80_00_000_00);
    expect(getCashFlow(db, { from: '2000-01-01', to: '2100-01-01' })).toMatchObject({ income: 0, expenses: 0 });
  });

  it('revalues by hand, replacing the previous valuation rather than stacking them', () => {
    const id = createAsset(db, { name: 'PPF', kind: 'ppf', value: 5_00_000_00, asOf: '2026-01-01' });
    updateAssetValue(db, id, { value: 5_50_000_00, asOf: '2026-06-01' });
    expect(getBalances(db).find((b) => b.id === id)!.balance).toBe(5_50_000_00);
    updateAssetValue(db, id, { value: 5_70_000_00, asOf: '2026-11-01' });
    expect(getBalances(db).find((b) => b.id === id)!.balance).toBe(5_70_000_00);
    expect(listAssets(db).items[0]!.value).toBe(5_70_000_00);
  });

  it('grows a fixed deposit from its rate, compounding quarterly, and stops at maturity', () => {
    expect(depositValue(1_00_000_00, 700, '2025-01-01', '2026-01-01')).toBe(Math.round(1_00_000_00 * (1 + 0.07 / 4) ** 4));
    const id = createAsset(db, { name: 'SBI FD', kind: 'fd', value: 0, invested: 1_00_000_00, rateBps: 700, startDate: '2025-01-01', maturityDate: '2026-01-01', asOf: '2025-07-01' });
    const half = listAssets(db).items[0]!.value;
    expect(half).toBeGreaterThan(1_03_000_00);
    accrueDeposits(db, '2027-06-01');
    expect(listAssets(db).items[0]!.value).toBe(depositValue(1_00_000_00, 700, '2025-01-01', '2026-01-01'));
    accrueDeposits(db, '2027-06-01');
    expect(listAssets(db).items[0]!.value).toBe(depositValue(1_00_000_00, 700, '2025-01-01', '2026-01-01'));
    expect(() => updateAssetValue(db, id, { value: 1 })).toThrow(/grows by itself/);
  });

  it('validates input and refuses a duplicate name', () => {
    createAsset(db, { name: 'Gold', kind: 'gold', value: 1_00_000_00 });
    expect(() => createAsset(db, { name: 'Gold', kind: 'gold', value: 1 })).toThrow(/exists/);
    expect(() => createAsset(db, { name: 'FD', kind: 'fd', value: 0, rateBps: 700 })).toThrow(/start date/);
    expect(() => createAsset(db, { name: 'X', kind: 'bonds' as never, value: 1 })).toThrow();
  });

  it('warns about a deposit maturing soon, and can delete an asset it created', () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const id = createAsset(db, { name: 'Bank FD', kind: 'fd', value: 0, invested: 50_000_00, rateBps: 700, startDate: '2025-01-01', maturityDate: soon });
    expect(computeInsights(db).some((i) => i.kind === 'assets')).toBe(true);
    deleteAsset(db, id);
    expect(listAssets(db).items).toEqual([]);
    expect(getBalances(db).some((b) => b.name === 'Bank FD')).toBe(false);
    expect(() => deleteAsset(db, id)).toThrow(/No such/);
  });
});
