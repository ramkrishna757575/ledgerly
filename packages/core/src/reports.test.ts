import { accounts, openDb, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  categoryTrend,
  createAccount,
  createSimpleTransaction,
  createTransaction,
  ensureStarterCategories,
  getNetWorth,
  listAccounts,
  netWorthHistory,
  overview,
  periodSummary,
  seedDefaults,
  spendingByCategory,
  topPayees,
  uncategorizedSummary,
} from './index.ts';

let db: Db;
let bank: number;
let card: number;

const category = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).get()!.id;

function spend(date: string, name: string, amount: number, description = name, payee?: string) {
  return createSimpleTransaction(db, {
    kind: 'expense',
    date,
    description,
    payee,
    accountId: bank,
    counterAccountId: category(name),
    amount,
  });
}

function earn(date: string, amount: number) {
  createSimpleTransaction(db, {
    kind: 'income',
    date,
    description: 'Salary',
    accountId: bank,
    counterAccountId: category('Salary'),
    amount,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset' }).id;
  card = createAccount(db, { name: 'Card', type: 'liability', subtype: 'credit_card' }).id;
});

const range = { from: '2025-01-01', to: '2026-12-31' };

describe('spending by category', () => {
  it('totals each category, biggest first', () => {
    spend('2026-03-01', 'Groceries', 1000);
    spend('2026-03-09', 'Groceries', 500);
    spend('2026-03-10', 'Rent', 20000);
    spend('2026-03-11', 'Fuel', 700);
    const rows = spendingByCategory(db, range);
    expect(rows.map((row) => [row.name, row.total, row.transactions])).toEqual([
      ['Rent', 20000, 1],
      ['Groceries', 1500, 2],
      ['Fuel', 700, 1],
    ]);
  });

  it('nets refunds against the category and leaves transfers out', () => {
    spend('2026-03-01', 'Shopping', 5000);
    // A refund is money back from the shop, so it reduces what the category cost.
    createTransaction(db, {
      date: '2026-03-05',
      description: 'Refund',
      postings: [
        { accountId: bank, amount: 1200 },
        { accountId: category('Shopping'), amount: -1200 },
      ],
    });
    // Paying the card is a transfer, so it is not spending.
    createSimpleTransaction(db, { kind: 'transfer', date: '2026-03-06', description: 'Card bill', accountId: bank, counterAccountId: card, amount: 9999 });
    expect(spendingByCategory(db, range)).toEqual([{ categoryId: category('Shopping'), name: 'Shopping', total: 3800, transactions: 2 }]);
  });

  it('only counts the chosen dates', () => {
    spend('2026-02-28', 'Rent', 100);
    spend('2026-03-01', 'Rent', 200);
    spend('2026-03-31', 'Rent', 300);
    spend('2026-04-01', 'Rent', 400);
    expect(spendingByCategory(db, { from: '2026-03-01', to: '2026-03-31' })[0]?.total).toBe(500);
  });
});

describe('spending over time', () => {
  beforeEach(() => {
    earn('2025-12-01', 100000);
    spend('2025-12-20', 'Rent', 30000);
    earn('2026-01-01', 100000);
    spend('2026-01-15', 'Rent', 30000);
    spend('2026-03-31', 'Groceries', 4000);
    earn('2026-04-01', 120000);
    spend('2026-04-02', 'Groceries', 5000);
  });

  it('lists every month in the range, including quiet ones', () => {
    const months = periodSummary(db, { from: '2025-12-01', to: '2026-04-30', period: 'month' });
    expect(months.map((m) => m.label)).toEqual(['Dec 2025', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026']);
    expect(months[2]).toMatchObject({ income: 0, expenses: 0, net: 0 });
    expect(months[0]).toMatchObject({ income: 100000, expenses: 30000, net: 70000 });
  });

  it('groups into calendar years', () => {
    const years = periodSummary(db, { from: '2025-12-01', to: '2026-04-30', period: 'year' });
    expect(years).toEqual([
      { key: '2025', label: '2025', income: 100000, expenses: 30000, net: 70000 },
      { key: '2026', label: '2026', income: 220000, expenses: 39000, net: 181000 },
    ]);
  });

  it('groups into financial years that start in April', () => {
    const years = periodSummary(db, { from: '2025-12-01', to: '2026-04-30', period: 'fy' });
    expect(years.map((y) => y.label)).toEqual(['FY 2025-26', 'FY 2026-27']);
    // 31 March belongs to the year that ends with it, 1 April starts the next.
    expect(years[0]).toMatchObject({ income: 200000, expenses: 64000 });
    expect(years[1]).toMatchObject({ income: 120000, expenses: 5000 });
  });

  it('summarises a range with the savings rate', () => {
    const summary = overview(db, { from: '2026-01-01', to: '2026-03-31' });
    expect(summary).toMatchObject({ income: 100000, expenses: 34000, net: 66000 });
    expect(summary.savingsRate).toBeCloseTo(0.66);
    expect(overview(db, { from: '2026-02-01', to: '2026-02-28' }).savingsRate).toBeNull();
  });
});

describe('category trend', () => {
  it('keeps the biggest categories and folds the rest into other', () => {
    spend('2026-01-05', 'Rent', 10000);
    spend('2026-02-05', 'Rent', 10000);
    spend('2026-01-06', 'Groceries', 3000);
    spend('2026-02-06', 'Fuel', 2000);
    spend('2026-02-07', 'Health', 500);
    spend('2026-01-08', 'Travel', 100);

    const trend = categoryTrend(db, { from: '2026-01-01', to: '2026-02-28', period: 'month', top: 2 });
    expect(trend.periods.map((p) => p.label)).toEqual(['Jan 2026', 'Feb 2026']);
    expect(trend.series.map((s) => [s.name, s.values])).toEqual([
      ['Rent', [10000, 10000]],
      ['Groceries', [3000, 0]],
    ]);
    expect(trend.other).toEqual([100, 2500]);
  });

  it('adds up to the total spending', () => {
    spend('2026-01-05', 'Rent', 10000);
    spend('2026-02-06', 'Fuel', 2000);
    spend('2026-02-07', 'Health', 500);
    const trend = categoryTrend(db, { from: '2026-01-01', to: '2026-02-28', top: 1 });
    const sum = [...trend.series.flatMap((s) => s.values), ...trend.other].reduce((a, b) => a + b, 0);
    expect(sum).toBe(12500);
  });
});

describe('top payees', () => {
  it('groups the same payee regardless of case and falls back to the description', () => {
    spend('2026-01-05', 'Food & Dining', 300, 'UPI/1', 'Swiggy');
    spend('2026-01-06', 'Food & Dining', 200, 'UPI/2', 'SWIGGY');
    spend('2026-01-07', 'Shopping', 900, 'Bookshop');
    const rows = topPayees(db, range);
    expect(rows.map((r) => [r.name.toLowerCase(), r.total, r.transactions])).toEqual([
      ['bookshop', 900, 1],
      ['swiggy', 500, 2],
    ]);
    expect(topPayees(db, { ...range, limit: 1 })).toHaveLength(1);
  });
});

describe('uncategorised spending', () => {
  it('counts what is still in the fallback category', () => {
    spend('2026-01-05', 'Uncategorized', 700);
    spend('2026-01-06', 'Uncategorized', 300);
    spend('2026-01-07', 'Rent', 5000);
    expect(uncategorizedSummary(db, range)).toEqual({ categoryId: category('Uncategorized'), count: 2, total: 1000 });
    expect(uncategorizedSummary(db, { from: '2020-01-01', to: '2020-12-31' }).count).toBe(0);
  });
});

describe('net worth over time', () => {
  it('reports each month end, ending today', () => {
    const asset = createAccount(db, { name: 'Savings', type: 'asset', openingBalance: 1000, openingDate: '2026-01-10' });
    createSimpleTransaction(db, { kind: 'income', date: '2026-03-15', description: 'x', accountId: asset.id, counterAccountId: category('Salary'), amount: 500 });
    const history = netWorthHistory(db, { months: 4, today: '2026-04-20' });
    expect(history.map((h) => [h.label, h.date, h.netWorth])).toEqual([
      ['Jan 2026', '2026-01-31', 1000],
      ['Feb 2026', '2026-02-28', 1000],
      ['Mar 2026', '2026-03-31', 1500],
      ['Apr 2026', '2026-04-20', 1500],
    ]);
  });
});

describe('net worth history agrees with the balance on each date', () => {
  it('matches getNetWorth at every point, including future-dated entries left out', () => {
    const db = openDb(':memory:');
    seedDefaults(db);
    ensureStarterCategories(db);
    const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 1_00_000_00, openingDate: '2026-02-10' }).id;
    const card = createAccount(db, { name: 'Card', type: 'liability', subtype: 'credit_card' }).id;
    const food = listAccounts(db).find((a) => a.name === 'Food & Dining')!.id;
    const spend = (date: string, from: number, amount: number) =>
      createSimpleTransaction(db, { date, description: 'x', kind: 'expense', accountId: from, counterAccountId: food, amount } as never);
    spend('2026-03-05', bank, 5_000_00);
    spend('2026-05-20', card, 2_000_00);
    spend('2026-11-30', bank, 9_999_00); // after "today"
    const history = netWorthHistory(db, { months: 10, today: '2026-11-10' });
    expect(history).toHaveLength(10);
    for (const point of history) {
      const { assets, liabilities, netWorth } = getNetWorth(db, { asOf: point.date });
      expect(point).toMatchObject({ assets, liabilities, netWorth });
    }
  });
});
