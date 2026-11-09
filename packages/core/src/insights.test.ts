import { readFileSync } from 'node:fs';
import { accounts, openDb, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeInsights,
  createAccount,
  createSimpleTransaction,
  dismissInsight,
  fixInsight,
  getBalances,
  listAccounts,
  listRules,
  listTransactions,
  proposeTransactionCategories,
  seedDefaults,
  setAutoRuleMode,
  spendingByCategory,
  stageStatement,
} from './index.ts';

let db: Db;
let bank: number;

const category = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).get()!.id;
const range = { from: '2000-01-01', to: '2100-01-01' };

function spend(description: string, payee: string | null, rupees: number, name = 'Uncategorized') {
  return createSimpleTransaction(db, {
    kind: 'expense',
    date: '2026-10-01',
    description,
    payee: payee ?? undefined,
    accountId: bank,
    counterAccountId: category(name),
    amount: rupees * 100,
  });
}

// The forecast depends on today's date, which these tests are not about.
const insightKeys = () => computeInsights(db).filter((i) => i.kind !== 'forecast').map((i) => i.key);
const accountsOf = (id: number) => listTransactions(db, { limit: 200 }).items.find((t) => t.id === id)!.postings.map((p) => p.accountName).sort();

const sip = () => [1, 2, 3].map(() => spend('ACH-DR-DE ACH INDIAN CLEARING CORP- 1234567890-REF', 'Indian Clearing Corp', 10000));
const ppf = () => spend('PPF/22497841/0040106404003/171026/09:35', null, 8500);

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 10000000 }).id;
});

describe('an empty or tidy ledger', () => {
  it('has nothing to say', () => {
    expect(computeInsights(db)).toEqual([]);
    spend('Lunch', 'Cafe', 300, 'Food & Dining');
    expect(computeInsights(db)).toEqual([]);
  });
});

describe('investments counted as spending', () => {
  it('spots them, biggest first, and explains why', () => {
    sip();
    ppf();
    const found = computeInsights(db);
    expect(found.map((i) => i.key)).toEqual(['investments:Mutual funds', 'investments:PPF']);
    expect(found[0]).toMatchObject({ severity: 'attention', amount: 3000000, action: { type: 'fix', label: 'Move to Mutual funds' } });
    expect(found[0]!.title).toMatch(/₹30,000\.00 that looks like mutual funds/);
    expect(found[0]!.detail).toMatch(/3 transactions, such as Indian Clearing Corp/);
  });

  it('moves them to an investment account as transfers, and adds a rule for next time', () => {
    const txs = sip();
    const result = fixInsight(db, 'investments:Mutual funds');
    expect(result.message).toBe('Moved 3 transactions to Mutual funds, and added 1 rule for future imports.');

    const funds = listAccounts(db).find((a) => a.name === 'Mutual funds')!;
    expect(funds).toMatchObject({ type: 'asset', subtype: 'investment' });
    expect(accountsOf(txs[0]!.id)).toEqual(['Bank', 'Mutual funds']);
    expect(getBalances(db).find((b) => b.id === funds.id)?.balance).toBe(3000000);
    expect(spendingByCategory(db, range)).toEqual([]);
    expect(listRules(db).map((r) => [r.pattern, r.categoryName])).toEqual([['Indian Clearing Corp', 'Mutual funds']]);
    expect(insightKeys()).toEqual([]);
  });

  it('handles PPF on its own and keeps going once fixed', () => {
    sip();
    const tx = ppf();
    fixInsight(db, 'investments:PPF');
    expect(accountsOf(tx.id)).toEqual(['Bank', 'PPF']);
    expect(insightKeys()).toEqual(['investments:Mutual funds']);
  });

  it('uses an account you already have instead of making another', () => {
    createAccount(db, { name: 'My PPF Account', type: 'asset', subtype: 'investment' });
    const tx = ppf();
    fixInsight(db, 'investments:PPF');
    expect(accountsOf(tx.id)).toEqual(['Bank', 'My PPF Account']);
    expect(listAccounts(db).filter((a) => a.name.includes('PPF'))).toHaveLength(1);
  });

  it('puts fund purchases in your only investment account, whatever it is called', () => {
    createAccount(db, { name: 'Zerodha Coin', type: 'asset', subtype: 'investment' });
    const txs = sip();
    fixInsight(db, 'investments:Mutual funds');
    expect(accountsOf(txs[0]!.id)).toEqual(['Bank', 'Zerodha Coin']);
  });

  it('leaves alone what you have already sorted', () => {
    spend('PPF/1/2/3', null, 8500, 'Insurance');
    expect(insightKeys()).toEqual([]);
  });
});

describe('credit card payments counted as spending', () => {
  const payments = () => [
    spend('CreditCard Payment XX 7788 Ref#K3MQ9X2T7AB', null, 15649),
    spend('CreditCard Payment XX 7788 Ref#P8WZ4N6C1DE0', null, 20662),
  ];

  it('asks you to add the card when there is none, with its digits filled in', () => {
    payments();
    expect(computeInsights(db)[0]).toMatchObject({
      key: 'card_payments',
      severity: 'attention',
      amount: 3631100,
      action: { type: 'link', to: '/accounts', search: { add: 'credit_card', last4: '7788' } },
    });
  });

  it('fixes it with one click when the card is known', () => {
    const card = createAccount(db, { name: 'Axis Card', type: 'liability', subtype: 'credit_card', numberLast4: '7788' }).id;
    const txs = payments();
    expect(computeInsights(db)[0]!.action).toMatchObject({ type: 'fix' });

    expect(fixInsight(db, 'card_payments').message).toMatch(/Treated 2 payments/);
    expect(accountsOf(txs[0]!.id)).toEqual(['Axis Card', 'Bank']);
    expect(getBalances(db).find((b) => b.id === card)?.balance).toBe(-3631100);
    expect(spendingByCategory(db, range)).toEqual([]);
    expect(listRules(db)[0]).toMatchObject({ pattern: 'CreditCard Payment XX 7788', categoryName: 'Axis Card' });
  });

  it('picks the card by its digits when there are several', () => {
    createAccount(db, { name: 'Other Card', type: 'liability', subtype: 'credit_card', numberLast4: '1111' });
    createAccount(db, { name: 'Axis Card', type: 'liability', subtype: 'credit_card', numberLast4: '7788' });
    const txs = payments();
    fixInsight(db, 'card_payments');
    expect(accountsOf(txs[0]!.id)).toEqual(['Axis Card', 'Bank']);
  });

  it('does not guess between cards when the digits match none', () => {
    createAccount(db, { name: 'Card A', type: 'liability', subtype: 'credit_card', numberLast4: '1111' });
    createAccount(db, { name: 'Card B', type: 'liability', subtype: 'credit_card', numberLast4: '2222' });
    payments();
    const insight = computeInsights(db)[0]!;
    expect(insight.action).toMatchObject({ type: 'link', to: '/transactions' });
    expect(() => fixInsight(db, 'card_payments')).toThrow(/no longer something to fix/);
  });
});

describe('uncategorised spending', () => {
  it('points out a large share, and how serious it is', () => {
    spend('Mystery shop', 'Mystery', 5000);
    spend('Lunch', 'Cafe', 5000, 'Food & Dining');
    const insight = computeInsights(db)[0]!;
    expect(insight).toMatchObject({ key: 'uncategorized', severity: 'attention', amount: 500000 });
    expect(insight.title).toMatch(/₹5,000\.00 of your spending \(50%\)/);
    expect(insight.action).toMatchObject({ type: 'link', to: '/transactions', search: { account: category('Uncategorized') } });
  });

  it('is calmer about a smaller share, and silent about a small one', () => {
    spend('Mystery shop', 'Mystery', 3000);
    spend('Lunch', 'Cafe', 7000, 'Food & Dining');
    expect(computeInsights(db)[0]).toMatchObject({ key: 'uncategorized', severity: 'info' });
    spend('Lunch', 'Cafe', 70000, 'Food & Dining');
    expect(insightKeys()).toEqual([]);
  });

  it('does not count what a more specific finding already explains', () => {
    ppf();
    spend('Mystery shop', 'Mystery', 500);
    spend('Lunch', 'Cafe', 9000, 'Food & Dining');
    expect(insightKeys()).toEqual(['investments:PPF']);
  });
});

describe('odd balances', () => {
  it('notes an account below zero', () => {
    const empty = createAccount(db, { name: 'Wallet', type: 'asset', subtype: 'wallet' }).id;
    createSimpleTransaction(db, { kind: 'expense', date: '2026-10-01', description: 'Snack', accountId: empty, counterAccountId: category('Food & Dining'), amount: 5000 });
    expect(computeInsights(db)[0]).toMatchObject({ kind: 'balance', severity: 'info', action: { to: '/accounts' } });
    expect(computeInsights(db)[0]!.title).toBe('Wallet is ₹50.00 below zero');
  });

  it('notes a card that has been paid more than it was charged', () => {
    const card = createAccount(db, { name: 'Axis Card', type: 'liability', subtype: 'credit_card' }).id;
    createSimpleTransaction(db, { kind: 'transfer', date: '2026-10-01', description: 'Bill', accountId: bank, counterAccountId: card, amount: 800000 });
    expect(computeInsights(db)[0]).toMatchObject({ kind: 'balance', action: { to: '/transactions', search: { account: card } } });
    expect(computeInsights(db)[0]!.title).toMatch(/Axis Card shows a credit of ₹8,000\.00/);
  });
});

describe('things waiting on you', () => {
  it('mentions imports, rule suggestions and agent suggestions', () => {
    const text = readFileSync(new URL('./imports/fixtures/axis-consolidated.txt', import.meta.url), 'utf8');
    stageStatement(db, { text, file: { sha256: 'x', filename: 'x.pdf', mimeType: 'application/pdf', size: 1, storedName: 'x.pdf' } });
    [1, 2, 3].forEach(() => spend('Lunch', 'Swiggy', 300, 'Food & Dining'));
    const tx = spend('Odd thing', 'Odd', 1);
    proposeTransactionCategories(db, 'Claude', { items: [{ transactionId: tx.id, categoryId: category('Health') }] });

    expect(insightKeys().sort()).toEqual(['agents', 'imports', 'rules']);
  });

  it('stops suggesting rules once they are made automatically', () => {
    [1, 2, 3].forEach(() => spend('Lunch', 'Swiggy', 300, 'Food & Dining'));
    expect(insightKeys()).toEqual(['rules']);
    setAutoRuleMode(db, 'create');
    expect(insightKeys()).toEqual([]);
  });
});

describe('dismissing', () => {
  it('hides a finding for good', () => {
    sip();
    dismissInsight(db, 'investments:Mutual funds');
    expect(insightKeys()).toEqual([]);
    ppf();
    expect(insightKeys()).toEqual(['investments:PPF']);
  });

  it('cannot fix something that is not there, or that has no fix', () => {
    expect(() => fixInsight(db, 'investments:PPF')).toThrow(/no longer something to fix/);
    spend('Mystery shop', 'Mystery', 5000);
    expect(() => fixInsight(db, 'uncategorized')).toThrow(/no longer something to fix/);
  });
});
