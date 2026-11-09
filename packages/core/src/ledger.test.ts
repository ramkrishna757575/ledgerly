import { accounts, openDb, postings, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  archiveAccount,
  deleteAccount,
  unarchiveAccount,
  updateAccount,
  createAccount,
  createSimpleTransaction,
  createTransaction,
  deleteTransaction,
  formatAmount,
  getBalances,
  getCashFlow,
  getNetWorth,
  listTransactions,
  parseAmount,
  seedDefaults,
  updateTransaction,
} from './index.ts';

let db: Db;

function category(name: string) {
  const row = db.select().from(accounts).where(eq(accounts.name, name)).get();
  if (!row) throw new Error(`No category ${name}`);
  return row.id;
}

function balanceOf(id: number, asOf?: string) {
  return getBalances(db, { asOf }).find((b) => b.id === id)?.balance;
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
});

describe('money', () => {
  it('parses Indian formatted amounts exactly', () => {
    expect(parseAmount('1,23,456.78')).toBe(12345678);
    expect(parseAmount('₹ 0.07')).toBe(7);
    expect(parseAmount('19.9')).toBe(1990);
    expect(parseAmount('-250')).toBe(-25000);
  });

  it('rejects text that is not an amount', () => {
    expect(() => parseAmount('12.345')).toThrow();
    expect(() => parseAmount('abc')).toThrow();
  });

  it('formats with lakh grouping', () => {
    expect(formatAmount(12345678)).toBe('₹1,23,456.78');
  });
});

describe('transactions', () => {
  it('rejects postings that do not balance', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    expect(() =>
      createTransaction(db, {
        date: '2026-10-01',
        description: 'Bad',
        postings: [
          { accountId: bank.id, amount: -100 },
          { accountId: category('Groceries'), amount: 99 },
        ],
      }),
    ).toThrow(/sum to zero/);
    expect(listTransactions(db).total).toBe(0);
  });

  it('rejects single postings, fractional paise and impossible dates', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    const groceries = category('Groceries');
    const entry = { date: '2026-10-01', description: 'Bad' };

    expect(() =>
      createTransaction(db, { ...entry, postings: [{ accountId: bank.id, amount: 1 }] }),
    ).toThrow();
    expect(() =>
      createTransaction(db, {
        ...entry,
        postings: [
          { accountId: bank.id, amount: -1.5 },
          { accountId: groceries, amount: 1.5 },
        ],
      }),
    ).toThrow();
    expect(() =>
      createTransaction(db, {
        ...entry,
        date: '2026-02-30',
        postings: [
          { accountId: bank.id, amount: -1 },
          { accountId: groceries, amount: 1 },
        ],
      }),
    ).toThrow();
  });

  it('enforces non-zero integer amounts in the database too', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    const tx = createSimpleTransaction(db, {
      kind: 'expense',
      date: '2026-10-01',
      description: 'Lunch',
      accountId: bank.id,
      counterAccountId: category('Food & Dining'),
      amount: 100,
    });
    expect(() =>
      db.insert(postings).values({ transactionId: tx.id, accountId: bank.id, amount: 0 }).run(),
    ).toThrow();
  });

  it('splits one payment across several categories', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 100000 });
    createTransaction(db, {
      date: '2026-10-02',
      description: 'Supermarket',
      postings: [
        { accountId: bank.id, amount: -3000 },
        { accountId: category('Groceries'), amount: 2000 },
        { accountId: category('Health'), amount: 1000 },
      ],
    });
    expect(balanceOf(bank.id)).toBe(97000);
    expect(balanceOf(category('Health'))).toBe(1000);
  });

  it('replaces postings on update and removes them on delete', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    const groceries = category('Groceries');
    const tx = createSimpleTransaction(db, {
      kind: 'expense',
      date: '2026-10-01',
      description: 'Shop',
      accountId: bank.id,
      counterAccountId: groceries,
      amount: 500,
      tags: ['home'],
    });
    expect(tx.tags).toEqual(['home']);

    const updated = updateTransaction(db, tx.id, {
      date: '2026-10-01',
      description: 'Shop',
      postings: [
        { accountId: bank.id, amount: -700 },
        { accountId: groceries, amount: 700 },
      ],
    });
    expect(updated.postings).toHaveLength(2);
    expect(updated.tags).toEqual([]);
    expect(balanceOf(bank.id)).toBe(-700);

    deleteTransaction(db, tx.id);
    expect(balanceOf(bank.id)).toBe(0);
    expect(() => deleteTransaction(db, tx.id)).toThrow(/not found/);
  });

  it('keeps a failed update from changing anything', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    const groceries = category('Groceries');
    const tx = createSimpleTransaction(db, {
      kind: 'expense',
      date: '2026-10-01',
      description: 'Shop',
      accountId: bank.id,
      counterAccountId: groceries,
      amount: 500,
    });
    expect(() =>
      updateTransaction(db, tx.id, {
        date: '2026-10-01',
        description: 'Shop',
        postings: [
          { accountId: bank.id, amount: -700 },
          { accountId: groceries, amount: 1 },
        ],
      }),
    ).toThrow();
    expect(balanceOf(bank.id)).toBe(-500);
  });

  it('refuses mismatched simple transactions', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    const base = { date: '2026-10-01', description: 'x', accountId: bank.id, amount: 100 };
    expect(() =>
      createSimpleTransaction(db, {
        ...base,
        kind: 'expense',
        counterAccountId: category('Salary'),
      }),
    ).toThrow(/cannot be used/);
    expect(() =>
      createSimpleTransaction(db, { ...base, kind: 'transfer', counterAccountId: bank.id }),
    ).toThrow(/different accounts/);
  });

  it('rejects mixed currencies and archived accounts', () => {
    const inr = createAccount(db, { name: 'INR', type: 'asset' });
    const usd = createAccount(db, { name: 'USD', type: 'asset', currency: 'USD' });
    const old = createAccount(db, { name: 'Old', type: 'asset' });
    archiveAccount(db, old.id);
    const entry = { date: '2026-10-01', description: 'x' };
    expect(() =>
      createTransaction(db, {
        ...entry,
        postings: [
          { accountId: inr.id, amount: -1 },
          { accountId: usd.id, amount: 1 },
        ],
      }),
    ).toThrow(/currency/);
    expect(() =>
      createTransaction(db, {
        ...entry,
        postings: [
          { accountId: inr.id, amount: -1 },
          { accountId: old.id, amount: 1 },
        ],
      }),
    ).toThrow(/archived/);
  });

  it('filters by account, date and search text', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    const cash = createAccount(db, { name: 'Cash', type: 'asset' });
    const groceries = category('Groceries');
    const spend = (accountId: number, date: string, description: string) =>
      createSimpleTransaction(db, {
        kind: 'expense',
        date,
        description,
        accountId,
        counterAccountId: groceries,
        amount: 100,
      });
    spend(bank.id, '2026-09-30', 'Sept shop');
    spend(bank.id, '2026-10-01', '100%_real SHOP');
    spend(cash.id, '2026-10-02', 'Market');

    expect(listTransactions(db, { accountId: cash.id }).total).toBe(1);
    expect(listTransactions(db, { from: '2026-10-01', to: '2026-10-31' }).total).toBe(2);
    expect(listTransactions(db, { search: 'shop' }).total).toBe(2);
    expect(listTransactions(db, { search: '%_' }).total).toBe(1);
    expect(listTransactions(db).items[0]?.description).toBe('Market');
    expect(listTransactions(db, { limit: 1, offset: 1 }).items).toHaveLength(1);
  });
});

describe('managing accounts', () => {
  it('renames an account and edits its details', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    const updated = updateAccount(db, bank.id, { name: 'Axis Savings', institution: 'Axis Bank', numberLast4: '2345' });
    expect(updated).toMatchObject({ name: 'Axis Savings', institution: 'Axis Bank', numberLast4: '2345' });
    expect(updateAccount(db, bank.id, { institution: null }).institution).toBeNull();
    createAccount(db, { name: 'Cash', type: 'asset' });
    expect(() => updateAccount(db, bank.id, { name: 'Cash' })).toThrow(/exists/);
  });

  it('archives an empty account and brings it back', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    expect(archiveAccount(db, bank.id).isArchived).toBe(true);
    expect(unarchiveAccount(db, bank.id).isArchived).toBe(false);
  });

  it('deletes an account that nothing uses', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    deleteAccount(db, bank.id);
    expect(getBalances(db).find((b) => b.id === bank.id)).toBeUndefined();
    expect(() => deleteAccount(db, bank.id)).toThrow(/not found/);
  });

  it('will not delete an account with transactions, and says how many', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 5000 });
    expect(() => deleteAccount(db, bank.id)).toThrow(/1 entry/);
    createSimpleTransaction(db, {
      kind: 'expense',
      date: '2026-10-01',
      description: 'Lunch',
      accountId: bank.id,
      counterAccountId: category('Food & Dining'),
      amount: 100,
    });
    expect(() => deleteAccount(db, bank.id)).toThrow(/2 entries/);
    expect(balanceOf(bank.id)).toBe(4900);
  });

  it('lets the account go once its transactions are gone', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset' });
    const tx = createSimpleTransaction(db, {
      kind: 'expense',
      date: '2026-10-01',
      description: 'Lunch',
      accountId: bank.id,
      counterAccountId: category('Food & Dining'),
      amount: 100,
    });
    expect(() => deleteAccount(db, bank.id)).toThrow();
    deleteTransaction(db, tx.id);
    deleteAccount(db, bank.id);
  });

  it('protects the opening balances account', () => {
    createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 1 });
    const equity = db.select().from(accounts).where(eq(accounts.name, 'Opening Balances')).get()!;
    expect(() => deleteAccount(db, equity.id)).toThrow(/used by the app/);
  });
});

describe('accounts and reports', () => {
  it('treats a credit card payment as a transfer, not spending', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 500000 });
    const card = createAccount(db, {
      name: 'Card',
      type: 'liability',
      subtype: 'credit_card',
      openingBalance: 20000,
    });
    createSimpleTransaction(db, {
      kind: 'expense',
      date: '2026-10-05',
      description: 'Dinner',
      accountId: card.id,
      counterAccountId: category('Food & Dining'),
      amount: 30000,
    });
    createSimpleTransaction(db, {
      kind: 'transfer',
      date: '2026-10-20',
      description: 'Card payment',
      accountId: bank.id,
      counterAccountId: card.id,
      amount: 50000,
    });

    expect(balanceOf(card.id)).toBe(0);
    expect(balanceOf(bank.id)).toBe(450000);
    expect(getNetWorth(db)).toEqual({ assets: 450000, liabilities: 0, netWorth: 450000 });
    expect(getCashFlow(db, { from: '2026-10-01', to: '2026-10-31' })).toEqual({
      income: 0,
      expenses: 30000,
      net: -30000,
    });
  });

  it('reports balances as of a date', () => {
    const bank = createAccount(db, {
      name: 'Bank',
      type: 'asset',
      openingBalance: 1000,
      openingDate: '2026-01-01',
    });
    createSimpleTransaction(db, {
      kind: 'income',
      date: '2026-06-01',
      description: 'Pay',
      accountId: bank.id,
      counterAccountId: category('Salary'),
      amount: 500,
    });
    expect(balanceOf(bank.id, '2025-12-31')).toBe(0);
    expect(balanceOf(bank.id, '2026-05-31')).toBe(1000);
    expect(balanceOf(bank.id)).toBe(1500);
  });

  it('always balances to zero across the whole ledger', () => {
    createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 1000 });
    createAccount(db, { name: 'Loan', type: 'liability', openingBalance: 400 });
    const rows = db.select().from(postings).all();
    expect(rows.reduce((sum, p) => sum + p.amount, 0)).toBe(0);
  });

  it('refuses duplicate names and archiving a funded account', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 1000 });
    expect(() => createAccount(db, { name: 'Bank', type: 'asset' })).toThrow(/exists/);
    expect(() => archiveAccount(db, bank.id)).toThrow(/zero balance/);
  });

  it('refuses an opening balance on a category', () => {
    expect(() =>
      createAccount(db, { name: 'Salary fund', type: 'income', openingBalance: 100 }),
    ).toThrow(/opening balance/);
    expect(listTransactions(db).total).toBe(0);
  });

  it('seeds defaults only once', () => {
    const before = db.select().from(accounts).all().length;
    seedDefaults(db);
    expect(db.select().from(accounts).all()).toHaveLength(before);
  });
});
