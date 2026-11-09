import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { archiveAccount, createAccount, deleteAccount, listAccounts, updateAccount } from './accounts.ts';
import { budgetStatus, setBudget } from './budgets.ts';
import { createCategory, listCategories, mergeCategory } from './categories.ts';
import { createRule, listRules } from './imports/rules.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';
import { createSimpleTransaction, listTransactions } from './transactions.ts';

let db: ReturnType<typeof openDb>;
let bank: number;
const id = (name: string, type = 'expense') => listAccounts(db).find((a) => a.name === name && a.type === type)!.id;
const spend = (name: string, amount: number, date = '2026-10-05') =>
  createSimpleTransaction(db, { date, description: name, kind: 'expense', accountId: bank, counterAccountId: id(name), amount } as never);

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' }).id;
});

describe('categories', () => {
  it('lists each category with what depends on it', () => {
    spend('Groceries', 500_00);
    spend('Groceries', 250_00);
    createRule(db, { pattern: 'bigbasket', matchType: 'contains', categoryId: id('Groceries') });
    setBudget(db, { categoryId: id('Groceries'), amount: 5_000_00 });
    const groceries = listCategories(db).find((c) => c.name === 'Groceries')!;
    expect(groceries).toMatchObject({ transactions: 2, total: 750_00, rules: 1, budget: 5_000_00, isArchived: false, isProtected: false });
    expect(listCategories(db).find((c) => c.name === 'Uncategorized')!.isProtected).toBe(true);
    expect(listCategories(db).some((c) => c.type === 'income')).toBe(true);
  });

  it('merges a category into another, moving transactions, rules and the budget', () => {
    spend('Fuel', 300_00);
    spend('Transport', 100_00);
    createRule(db, { pattern: 'iocl', matchType: 'contains', categoryId: id('Fuel') });
    setBudget(db, { categoryId: id('Fuel'), amount: 2_000_00 });

    expect(mergeCategory(db, id('Fuel'), id('Transport'))).toEqual({ into: 'Transport', transactions: 1, rules: 1 });

    expect(listAccounts(db).some((a) => a.name === 'Fuel')).toBe(false);
    expect(listTransactions(db).items.map((t) => t.postings.find((p) => p.accountType === 'expense')!.accountName)).toEqual(['Transport', 'Transport']);
    expect(listRules(db).map((r) => r.categoryName)).toEqual(['Transport']);
    expect(budgetStatus(db, { month: '2026-10' }).items).toMatchObject([{ name: 'Transport', amount: 2_000_00, spent: 400_00 }]);
  });

  it("keeps the target's own budget when both have one", () => {
    setBudget(db, { categoryId: id('Fuel'), amount: 2_000_00 });
    setBudget(db, { categoryId: id('Transport'), amount: 3_000_00 });
    mergeCategory(db, id('Fuel'), id('Transport'));
    expect(budgetStatus(db, { month: '2026-10' }).items).toMatchObject([{ name: 'Transport', amount: 3_000_00 }]);
  });

  it('refuses merges that would corrupt the books', () => {
    expect(() => mergeCategory(db, id('Fuel'), id('Fuel'))).toThrow(/different/);
    expect(() => mergeCategory(db, id('Fuel'), id('Salary', 'income'))).toThrow(/Income can only/);
    expect(() => mergeCategory(db, id('Fuel'), bank)).toThrow(/not a spending or income/);
    expect(() => mergeCategory(db, id('Uncategorized'), id('Fuel'))).toThrow(/cannot be merged/);
    archiveAccount(db, id('Transport'));
    expect(() => mergeCategory(db, id('Fuel'), id('Transport'))).toThrow(/archived/);
  });

  it('merges into Uncategorized, and keeps that category from being renamed or removed', () => {
    spend('Fuel', 100_00);
    mergeCategory(db, id('Fuel'), id('Uncategorized'));
    expect(listCategories(db).find((c) => c.name === 'Uncategorized')!.transactions).toBe(1);
    expect(() => updateAccount(db, id('Uncategorized'), { name: 'Misc' })).toThrow(/cannot be renamed/);
    expect(() => archiveAccount(db, id('Uncategorized'))).toThrow(/cannot be archived/);
    expect(() => deleteAccount(db, id('Uncategorized'))).toThrow(/cannot be deleted/);
  });

  it('creates and renames categories, rejecting duplicates', () => {
    const pets = createCategory(db, { name: 'Pets', type: 'expense' });
    expect(updateAccount(db, pets.id, { name: 'Pet care' }).name).toBe('Pet care');
    expect(() => createCategory(db, { name: 'Groceries', type: 'expense' })).toThrow(/exists/);
    expect(() => createCategory(db, { name: 'Bank 2', type: 'asset' as never })).toThrow();
    expect(() => updateAccount(db, id('Fuel'), { name: 'Groceries' })).toThrow(/exists/);
  });
});
