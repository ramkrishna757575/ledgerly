import { accounts, openDb, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyCategoryToSimilar,
  createAccount,
  createSimpleTransaction,
  getBalances,
  listTransactions,
  seedDefaults,
  setTransactionCategory,
  spendingByCategory,
} from './index.ts';

let db: Db;
let bank: number;

const category = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).get()!.id;

function spend(name: string, payee: string | undefined, amount = 1000, date = '2026-10-01') {
  return createSimpleTransaction(db, {
    kind: 'expense',
    date,
    description: payee ?? 'Something',
    payee,
    accountId: bank,
    counterAccountId: category(name),
    amount,
  });
}

const categoryOf = (id: number) =>
  listTransactions(db, { limit: 200 })
    .items.find((t) => t.id === id)!
    .postings.find((p) => p.accountType === 'expense' || p.accountType === 'income')!.accountName;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 100000 }).id;
});

describe('changing the category of a transaction', () => {
  it('moves the spending to the new category and leaves the bank balance alone', () => {
    const tx = spend('Uncategorized', 'Ravi', 2500);
    const { transaction } = setTransactionCategory(db, tx.id, category('Groceries'));

    expect(transaction.postings.map((p) => p.accountName).sort()).toEqual(['Bank', 'Groceries']);
    expect(getBalances(db).find((b) => b.id === bank)?.balance).toBe(97500);
    expect(spendingByCategory(db, { from: '2026-01-01', to: '2026-12-31' }).map((r) => r.name)).toEqual(['Groceries']);
  });

  it('can turn spending into a transfer to a card', () => {
    const card = createAccount(db, { name: 'Card', type: 'liability', subtype: 'credit_card' }).id;
    const tx = spend('Uncategorized', 'Axis card payment', 5000);
    setTransactionCategory(db, tx.id, card);
    expect(spendingByCategory(db, { from: '2026-01-01', to: '2026-12-31' })).toEqual([]);
    expect(getBalances(db).find((b) => b.id === card)?.balance).toBe(-5000);
  });

  it('refuses a transfer, the account it is paid from, and unusable categories', () => {
    const other = createAccount(db, { name: 'Other', type: 'asset' }).id;
    const transfer = createSimpleTransaction(db, { kind: 'transfer', date: '2026-10-01', description: 'Move', accountId: bank, counterAccountId: other, amount: 100 });
    expect(() => setTransactionCategory(db, transfer.id, category('Groceries'))).toThrow(/no single category/);

    const tx = spend('Rent', 'Landlord');
    expect(() => setTransactionCategory(db, tx.id, bank)).toThrow(/different category/);
    const equity = db.select().from(accounts).where(eq(accounts.type, 'equity')).get()!;
    expect(() => setTransactionCategory(db, tx.id, equity.id)).toThrow(/Choose a category/);
    expect(() => setTransactionCategory(db, 9999, category('Rent'))).toThrow(/not found/);
  });
});

describe('applying a category to similar transactions', () => {
  it('counts other unsorted transactions from the same payee', () => {
    const first = spend('Uncategorized', 'Ravi');
    spend('Uncategorized', 'ravi');
    spend('Uncategorized', 'Someone else');
    spend('Rent', 'Ravi');
    expect(setTransactionCategory(db, first.id, category('Gifts & Donations')).similar).toBe(1);
  });

  it('changes only the unsorted ones and never a decision you made', () => {
    const first = spend('Uncategorized', 'Ravi');
    const second = spend('Uncategorized', 'Ravi');
    const decided = spend('Rent', 'Ravi');
    const other = spend('Uncategorized', 'Someone else');

    setTransactionCategory(db, first.id, category('Gifts & Donations'));
    expect(applyCategoryToSimilar(db, first.id, category('Gifts & Donations'))).toEqual({ updated: 1 });

    expect(categoryOf(second.id)).toBe('Gifts & Donations');
    expect(categoryOf(decided.id)).toBe('Rent');
    expect(categoryOf(other.id)).toBe('Uncategorized');
  });

  it('keeps money in and money out apart', () => {
    const out = spend('Uncategorized', 'Ravi');
    createSimpleTransaction(db, { kind: 'income', date: '2026-10-02', description: 'Ravi paid back', payee: 'Ravi', accountId: bank, counterAccountId: category('Other Income'), amount: 700 });
    expect(setTransactionCategory(db, out.id, category('Gifts & Donations')).similar).toBe(0);
  });

  it('does nothing for a transaction with no payee', () => {
    const tx = spend('Uncategorized', undefined);
    spend('Uncategorized', undefined);
    expect(setTransactionCategory(db, tx.id, category('Groceries')).similar).toBe(0);
  });
});
