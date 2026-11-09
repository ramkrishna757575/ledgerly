import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeInsights } from './insights.ts';
import { budgetStatus, deleteBudget, setBudget, suggestBudgets } from './budgets.ts';
import { createAccount, listAccounts } from './accounts.ts';
import { seedDefaults, ensureStarterCategories } from './seed.ts';
import { createSimpleTransaction } from './transactions.ts';

let db: ReturnType<typeof openDb>;
let bank: number;
const category = (name: string) => listAccounts(db).find((a) => a.name === name && a.type === 'expense')!.id;

function spend(date: string, name: string, amount: number) {
  createSimpleTransaction(db, { date, description: name, kind: 'expense', accountId: bank, counterAccountId: category(name), amount } as never);
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' }).id;
});

describe('budgets', () => {
  it('measures spending against the limit and flags the state', () => {
    setBudget(db, { categoryId: category('Groceries'), amount: 10_000_00 });
    setBudget(db, { categoryId: category('Transport'), amount: 2_000_00 });
    setBudget(db, { categoryId: category('Travel'), amount: 5_000_00 });
    spend('2026-10-03', 'Groceries', 4_000_00);
    spend('2026-10-05', 'Transport', 1_700_00);
    spend('2026-10-06', 'Health', 900_00);

    const status = budgetStatus(db, { month: '2026-10', today: '2026-10-10' });
    const by = Object.fromEntries(status.items.map((i) => [i.name, i]));
    expect(by.Groceries).toMatchObject({ spent: 4_000_00, remaining: 6_000_00, state: 'ok' });
    // 85% used by day 10 of 31.
    expect(by.Transport!.state).toBe('watch');
    expect(by.Travel).toMatchObject({ spent: 0, state: 'ok' });
    expect(status.totals).toEqual({ budgeted: 17_000_00, spent: 5_700_00, unbudgeted: 900_00 });
    expect(status.unbudgeted.map((u) => u.name)).toEqual(['Health']);
  });

  it('marks a budget over once it is exceeded, and judges past months on the final figure', () => {
    setBudget(db, { categoryId: category('Groceries'), amount: 1_000_00 });
    spend('2026-09-12', 'Groceries', 1_200_00);
    expect(budgetStatus(db, { month: '2026-09', today: '2026-10-10' }).items[0]).toMatchObject({ state: 'over', remaining: -200_00 });
    expect(budgetStatus(db, { month: '2026-09', today: '2026-10-10' }).elapsed).toBe(1);
    expect(budgetStatus(db, { month: '2026-11', today: '2026-10-10' }).items[0]).toMatchObject({ spent: 0, state: 'ok' });
  });

  it('does not flag an early, small purchase as running ahead', () => {
    setBudget(db, { categoryId: category('Groceries'), amount: 10_000_00 });
    spend('2026-10-01', 'Groceries', 1_000_00);
    expect(budgetStatus(db, { month: '2026-10', today: '2026-10-02' }).items[0]!.state).toBe('ok');
  });

  it('replaces an existing budget and removes one', () => {
    const id = category('Groceries');
    setBudget(db, { categoryId: id, amount: 100 });
    setBudget(db, { categoryId: id, amount: 200 });
    expect(budgetStatus(db, { month: '2026-10' }).items).toMatchObject([{ amount: 200 }]);
    deleteBudget(db, id);
    expect(budgetStatus(db, { month: '2026-10' }).items).toEqual([]);
    expect(() => deleteBudget(db, id)).toThrow(/No budget/);
  });

  it('only allows budgets on spending categories and positive amounts', () => {
    expect(() => setBudget(db, { categoryId: bank, amount: 100 })).toThrow(/spending category/);
    expect(() => setBudget(db, { categoryId: category('Groceries'), amount: 0 })).toThrow();
    expect(() => budgetStatus(db, { month: '2026-13' })).toThrow();
  });

  it('suggests a limit from the last three full months, rounded up', () => {
    spend('2026-06-10', 'Groceries', 9_000_00); // too old
    spend('2026-08-10', 'Groceries', 3_000_00);
    spend('2026-09-10', 'Groceries', 4_050_00);
    spend('2026-10-10', 'Groceries', 9_999_00); // current month, ignored
    spend('2026-09-11', 'Travel', 8_000_00); // one month only
    spend('2026-08-11', 'Health', 500_00);
    spend('2026-09-11', 'Health', 500_00);
    setBudget(db, { categoryId: category('Health'), amount: 1_000_00 });

    const result = suggestBudgets(db, { today: '2026-10-15' });
    expect(result).toEqual([{ categoryId: category('Groceries'), name: 'Groceries', average: 2_350_00, amount: 2_400_00 }]);
  });

  it('raises an insight only while a budget is over or close', () => {
    const month = new Date().toISOString().slice(0, 7);
    setBudget(db, { categoryId: category('Groceries'), amount: 1_000_00 });
    expect(computeInsights(db).some((i) => i.kind === 'budgets')).toBe(false);

    spend(`${month}-01`, 'Groceries', 1_500_00);
    const insight = computeInsights(db).find((i) => i.kind === 'budgets')!;
    expect(insight).toMatchObject({ severity: 'attention', amount: 500_00, key: `budgets:${month}` });
    expect(insight.title).toMatch(/1 budget is over/);
  });
});
