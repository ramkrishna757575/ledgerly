import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, getBalances, listAccounts } from './accounts.ts';
import { createGoal, deleteGoal, listGoals, updateGoal } from './goals.ts';
import { spendingByCategory } from './reports.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';
import { createSimpleTransaction, getTransaction, splitTransaction } from './transactions.ts';

let db: ReturnType<typeof openDb>;
let bank: number;
const cat = (name: string, type = 'expense') => listAccounts(db).find((a) => a.name === name && a.type === type)!.id;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 10_00_000_00, openingDate: '2026-01-01' }).id;
});

const spend = (amount: number) =>
  (createSimpleTransaction(db, { date: '2026-10-05', description: 'Supermarket', kind: 'expense', accountId: bank, counterAccountId: cat('Groceries'), amount } as never) as { id: number }).id;

describe('splitting a transaction', () => {
  it('spreads it across categories without changing any balance', () => {
    const id = spend(5_000_00);
    const before = getBalances(db).find((b) => b.id === bank)!.balance;
    const split = splitTransaction(db, id, [{ categoryId: cat('Groceries'), amount: 3_500_00 }, { categoryId: cat('Shopping'), amount: 1_500_00 }]);
    expect(split.postings).toHaveLength(3);
    expect(getBalances(db).find((b) => b.id === bank)!.balance).toBe(before);
    const spent = Object.fromEntries(spendingByCategory(db, { from: '2026-10-01', to: '2026-10-31' }).map((r) => [r.name, r.total]));
    expect(spent).toEqual({ Groceries: 3_500_00, Shopping: 1_500_00 });
    expect(split.postings.reduce((s, p) => s + p.amount, 0)).toBe(0);
  });

  it('can be split again, or put back into one category', () => {
    const id = spend(1_000_00);
    splitTransaction(db, id, [{ categoryId: cat('Groceries'), amount: 400_00 }, { categoryId: cat('Health'), amount: 600_00 }]);
    splitTransaction(db, id, [{ categoryId: cat('Health'), amount: 600_00 }, { categoryId: cat('Health'), amount: 400_00 }]);
    expect(getTransaction(db, id).postings.map((p) => `${p.accountName}:${p.amount}`).sort()).toEqual(['Bank:-100000', 'Health:100000']);
  });

  it('splits income too', () => {
    const id = (createSimpleTransaction(db, { date: '2026-10-01', description: 'Pay', kind: 'income', accountId: bank, counterAccountId: cat('Salary', 'income'), amount: 1_000_00 } as never) as { id: number }).id;
    splitTransaction(db, id, [{ categoryId: cat('Salary', 'income'), amount: 800_00 }, { categoryId: cat('Other Income', 'income'), amount: 200_00 }]);
    expect(getTransaction(db, id).postings.filter((p) => p.accountType === 'income').map((p) => p.amount).sort((a, b) => a - b)).toEqual([-80000, -20000]);
  });

  it('refuses parts that do not add up, wrong kinds of category, and transfers', () => {
    const id = spend(1_000_00);
    expect(() => splitTransaction(db, id, [{ categoryId: cat('Groceries'), amount: 900_00 }])).toThrow(/add up/);
    expect(() => splitTransaction(db, id, [{ categoryId: cat('Salary', 'income'), amount: 1_000_00 }])).toThrow(/spending categories/);
    expect(() => splitTransaction(db, id, [{ categoryId: cat('Groceries'), amount: 0 }])).toThrow();
    const other = createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank' }).id;
    const transfer = (createSimpleTransaction(db, { date: '2026-10-06', description: 'Move', kind: 'transfer', accountId: bank, counterAccountId: other, amount: 100_00 } as never) as { id: number }).id;
    expect(() => splitTransaction(db, transfer, [{ categoryId: cat('Groceries'), amount: 100_00 }])).toThrow(/Only a purchase/);
  });
});

describe('goals', () => {
  it('measures progress from linked accounts and savings by hand', () => {
    const fund = createAccount(db, { name: 'Holiday fund', type: 'asset', subtype: 'bank', openingBalance: 40_000_00, openingDate: '2026-01-01' }).id;
    const id = createGoal(db, { name: 'Holiday', targetAmount: 1_00_000_00, targetDate: '2027-05-10', accountIds: [fund], savedByHand: 10_000_00 });
    const [goal] = listGoals(db, { today: '2026-11-10' });
    expect(goal).toMatchObject({ id, current: 50_000_00, remaining: 50_000_00, share: 0.5, done: false });
    // About six months to go: 50,000 / 6 months.
    expect(goal!.neededPerMonth).toBeGreaterThan(8_000_00);
    expect(goal!.neededPerMonth).toBeLessThan(8_600_00);
    expect(goal!.monthsLeft).toBeCloseTo(6, 0);
  });

  it('says when it would be reached at your usual saving, and when it is done', () => {
    for (const m of ['08', '09', '10']) {
      createSimpleTransaction(db, { date: `2026-${m}-01`, description: 'Pay', kind: 'income', accountId: bank, counterAccountId: cat('Salary', 'income'), amount: 1_00_000_00 } as never);
      createSimpleTransaction(db, { date: `2026-${m}-05`, description: 'Rent', kind: 'expense', accountId: bank, counterAccountId: cat('Rent'), amount: 60_000_00 } as never);
    }
    const id = createGoal(db, { name: 'Car', targetAmount: 4_00_000_00, accountIds: [], savedByHand: 1_00_000_00 });
    const [goal] = listGoals(db, { today: '2026-11-10' });
    expect(goal).toMatchObject({ usualSaving: 40_000_00, neededPerMonth: null });
    // 3,00,000 left at 40,000 a month is 8 months: July 2027.
    expect(goal!.reachedBy).toBe('2027-07-01');

    updateGoal(db, id, { name: 'Car', targetAmount: 1_00_000_00, accountIds: [], savedByHand: 1_00_000_00 });
    expect(listGoals(db)[0]).toMatchObject({ done: true, remaining: 0, reachedBy: null });
    deleteGoal(db, id);
    expect(listGoals(db)).toEqual([]);
    expect(() => deleteGoal(db, id)).toThrow(/No such goal/);
  });

  it('validates input', () => {
    expect(() => createGoal(db, { name: '', targetAmount: 1 })).toThrow();
    expect(() => createGoal(db, { name: 'x', targetAmount: 0 })).toThrow();
  });
});
