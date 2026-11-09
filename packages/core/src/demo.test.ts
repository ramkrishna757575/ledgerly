import { openDb, postings, transactions, type Db } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getBalances,
  getCashFlow,
  getNetWorth,
  resetDemoData,
  seedDefaults,
  seedDemoData,
} from './index.ts';

const TODAY = '2026-11-05';
let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('demo data', () => {
  it('builds a ledger that balances to zero', () => {
    resetDemoData(db, { today: TODAY });
    const rows = db.select().from(postings).all();
    expect(rows.length).toBeGreaterThan(200);
    expect(rows.reduce((sum, p) => sum + p.amount, 0)).toBe(0);
  });

  it('is identical every time', () => {
    resetDemoData(db, { today: TODAY });
    const first = getNetWorth(db);
    resetDemoData(db, { today: TODAY });
    expect(getNetWorth(db)).toEqual(first);
  });

  it('gives believable balances', () => {
    resetDemoData(db, { today: TODAY });
    const balances = getBalances(db);
    const byName = (name: string) => balances.find((b) => b.name === name)!;

    expect(byName('Demo Savings').balance).toBeGreaterThan(0);
    expect(byName('Cash').balance).toBeGreaterThanOrEqual(0);
    expect(byName('Demo Credit Card').balance).toBeGreaterThanOrEqual(0);
    expect(byName('Mutual Funds').balance).toBeGreaterThan(20000000);

    const { netWorth } = getNetWorth(db);
    expect(netWorth).toBeGreaterThan(30000000);
  });

  it('covers several months with income and spending', () => {
    resetDemoData(db, { today: TODAY });
    const dates = db.select({ date: transactions.date }).from(transactions).all();
    expect(dates.some((d) => d.date.startsWith('2026-08'))).toBe(true);
    expect(dates.some((d) => d.date.startsWith('2026-11'))).toBe(true);

    const october = getCashFlow(db, { from: '2026-10-01', to: '2026-10-31' });
    expect(october.income).toBeGreaterThan(8500000);
    expect(october.expenses).toBeGreaterThan(october.income / 5);
  });

  it('refuses to mix with existing data', () => {
    seedDefaults(db);
    seedDemoData(db, { today: TODAY });
    expect(() => seedDemoData(db, { today: TODAY })).toThrow(/empty ledger/);
  });
});
