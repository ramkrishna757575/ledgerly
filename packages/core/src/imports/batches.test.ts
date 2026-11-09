import { readFileSync } from 'node:fs';
import { accounts, openDb, stagedTransactions, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAccount,
  createTransaction,
  getBalances,
  listTransactions,
  seedDefaults,
  setTransactionCategory,
} from '../index.ts';
import {
  assignAccount,
  commitBatch,
  discardBatch,
  getImportBatch,
  listImportBatches,
  refreshSuggestions,
  stageStatement,
  undoBatch,
  updateStagedRow,
} from './batches.ts';
import { createRule, listRules } from './rules.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const file = (sha256: string) => ({
  sha256,
  filename: `${sha256}.pdf`,
  mimeType: 'application/pdf',
  size: 1000,
  storedName: `${sha256}.pdf`,
});

let db: Db;
let savings: number;
let card: number;

const categoryId = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).get()!.id;
const balanceOf = (id: number) => getBalances(db).find((b) => b.id === id)!.balance;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  savings = createAccount(db, { name: 'Axis Savings', type: 'asset', subtype: 'bank', numberLast4: '2345' }).id;
  card = createAccount(db, { name: 'Axis Card', type: 'liability', subtype: 'credit_card', numberLast4: '9876' }).id;
});

describe('staging a statement', () => {
  it('finds the account from the last four digits and suggests categories', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });

    expect(batch).toMatchObject({
      status: 'staged',
      accountId: savings,
      accountName: 'Axis Savings',
      reconciliation: 'ok',
      periodStart: '2026-10-01',
    });
    expect(batch.items).toHaveLength(7);

    const byPayee = (payee: string) => batch.items.find((item) => item.payee === payee)!;
    expect(byPayee('Swiggy')).toMatchObject({ categoryId: categoryId('Food & Dining'), categorySource: 'builtin' });
    expect(batch.items.find((item) => item.channel === 'interest')?.categoryId).toBe(categoryId('Interest'));
    expect(batch.items.find((item) => item.channel === 'card_payment')?.categoryId).toBe(card);
    expect(byPayee('Rahul Sharma').categoryId).toBeNull();
  });

  it('leaves the account open when nothing matches', () => {
    db.update(accounts).set({ numberLast4: null }).run();
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(batch.accountId).toBeNull();
    expect(() => commitBatch(db, batch.id)).toThrow(/Choose the account/);
  });

  it('refuses text it cannot read and leaves nothing behind', () => {
    expect(() => stageStatement(db, { text: 'not a statement', file: file('x') })).toThrow(/not supported/);
    expect(listImportBatches(db)).toEqual([]);
  });

  it('matches the right kind of account', () => {
    db.update(accounts).set({ numberLast4: null }).run();
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(() => assignAccount(db, batch.id, card)).toThrow(/bank account/);
    expect(assignAccount(db, batch.id, savings).accountId).toBe(savings);
  });
});

describe('committing and undoing', () => {
  it('adds transactions to the ledger and removes them again', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    const done = commitBatch(db, batch.id);

    expect(done.status).toBe('committed');
    expect(done.items.every((item) => item.status === 'committed')).toBe(true);
    expect(balanceOf(savings)).toBe(4164950);
    // The card payment was a transfer, so it reduced what is owed instead of counting as spending.
    expect(balanceOf(card)).toBe(-1200000);

    const swiggy = listTransactions(db, { search: 'swiggy' }).items[0]!;
    expect(swiggy).toMatchObject({ description: 'Swiggy', payee: 'Swiggy', source: `import:${batch.id}` });
    expect(swiggy.notes).toMatch(/^UPI\/P2M/);

    const undone = undoBatch(db, batch.id);
    expect(undone.status).toBe('undone');
    expect(balanceOf(savings)).toBe(0);
    expect(listTransactions(db).total).toBe(0);
  });

  it('puts uncategorised rows under the fallback categories', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    commitBatch(db, batch.id);
    const salary = listTransactions(db, { search: 'acme' }).items[0]!;
    expect(salary.postings.map((p) => p.accountName).sort()).toEqual(['Axis Savings', 'Other Income']);
    const rahul = listTransactions(db, { search: 'rahul' }).items[0]!;
    expect(rahul.postings.map((p) => p.accountName).sort()).toEqual(['Axis Savings', 'Uncategorized']);
  });

  it('does not import skipped rows', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    const rahul = batch.items.find((item) => item.payee === 'Rahul Sharma')!;
    updateStagedRow(db, rahul.id, { status: 'skipped' });
    commitBatch(db, batch.id);
    expect(listTransactions(db).total).toBe(6);
    expect(balanceOf(savings)).toBe(4164950 + 50000);
  });

  it('cannot be committed twice or undone before it is committed', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(() => undoBatch(db, batch.id)).toThrow(/finished import/);
    commitBatch(db, batch.id);
    expect(() => commitBatch(db, batch.id)).toThrow(/already finished/);
  });

  it('blocks a statement that does not add up unless confirmed', () => {
    const broken = fixture('axis-consolidated.txt').replace(/^05-10-2026 ACH.*\n/m, '');
    const batch = stageStatement(db, { text: broken, file: file('a') });
    expect(batch.reconciliation).toBe('mismatch');
    expect(batch.warnings.join(' ')).toMatch(/add up/);
    expect(() => commitBatch(db, batch.id)).toThrow(/Confirm/);
    expect(commitBatch(db, batch.id, { acceptMismatch: true }).status).toBe('committed');
  });
});

describe('duplicates', () => {
  it('recognises rows from an earlier import, including identical payments on one day', () => {
    const first = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(first.items.filter((item) => item.status === 'duplicate')).toHaveLength(0);
    commitBatch(db, first.id);

    const again = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('b') });
    expect(again.items.every((item) => item.status === 'duplicate')).toBe(true);
    expect(() => commitBatch(db, again.id)).toThrow(/nothing left|no transactions left/i);
    expect(listTransactions(db).total).toBe(7);
  });

  it('only imports the new rows of an overlapping statement', () => {
    const first = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    commitBatch(db, first.id);

    const newRow =
      '31-10-2026 UPI/P2A/100000000009/Late Payment/UPI/Demo Bank                                 100.00                  1,41,549.50';
    const extended = fixture('axis-consolidated.txt').replace(/^( +Page 1 of 1)$/m, `${newRow}\n$1`);
    const overlapping = stageStatement(db, { text: extended, file: file('c') });
    expect(overlapping.warnings).toEqual([]);
    expect(overlapping.items.filter((item) => item.status === 'pending')).toHaveLength(1);
    expect(overlapping.items.filter((item) => item.status === 'duplicate')).toHaveLength(7);
    expect(commitBatch(db, overlapping.id).status).toBe('committed');
    expect(listTransactions(db).total).toBe(8);
  });

  it('does not treat two separate payments as duplicates of each other', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    const ach = batch.items.filter((item) => item.channel === 'ach');
    expect(ach).toHaveLength(2);
    expect(ach.every((item) => item.status === 'pending')).toBe(true);
  });

  it('rejects the same file twice, but allows it again after an undo', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(() => stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') })).toThrow(
      /already imported/,
    );
    commitBatch(db, batch.id);
    undoBatch(db, batch.id);
    const second = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(second.items.every((item) => item.status === 'pending')).toBe(true);
  });
});

describe('categories and rules', () => {
  it('remembers a choice and applies it to similar rows', () => {
    const funds = createAccount(db, { name: 'Mutual Funds', type: 'asset', subtype: 'investment' }).id;
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    const [firstAch, secondAch] = batch.items.filter((item) => item.channel === 'ach');

    updateStagedRow(db, firstAch!.id, { categoryId: funds, createRule: true });

    const updated = getImportBatch(db, batch.id);
    expect(updated.items.find((item) => item.id === secondAch!.id)).toMatchObject({
      categoryId: funds,
      categorySource: 'rule',
    });
    expect(listRules(db)).toHaveLength(1);

    commitBatch(db, batch.id);
    expect(balanceOf(funds)).toBe(3000000);
  });

  it('applies saved rules to the next statement', () => {
    const funds = createAccount(db, { name: 'Mutual Funds', type: 'asset' }).id;
    createRule(db, { pattern: 'indian clearing', categoryId: funds });
    const batch = stageStatement(db, { text: fixture('axis-statement.txt'), file: file('s') });
    const ach = batch.items.filter((item) => item.channel === 'ach');
    expect(ach.map((item) => item.categoryId)).toEqual([funds, funds]);
    expect(ach.every((item) => item.categorySource === 'rule')).toBe(true);
  });

  it('keeps a manual choice when a rule is added later', () => {
    const funds = createAccount(db, { name: 'Mutual Funds', type: 'asset' }).id;
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    const [first, second] = batch.items.filter((item) => item.channel === 'ach');
    updateStagedRow(db, second!.id, { categoryId: categoryId('Insurance') });
    updateStagedRow(db, first!.id, { categoryId: funds, createRule: true });
    expect(getImportBatch(db, batch.id).items.find((item) => item.id === second!.id)?.categoryId).toBe(
      categoryId('Insurance'),
    );
  });

  it('rejects a bad pattern and an unusable category', () => {
    expect(() => createRule(db, { pattern: '(abc', matchType: 'regex', categoryId: categoryId('Rent') })).toThrow(/valid pattern/);
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(() => updateStagedRow(db, batch.items[0]!.id, { categoryId: categoryId('Opening Balances') })).toThrow(
      /Choose a category/,
    );
  });
});

describe('learning from your choices', () => {
  const rahulAgain =
    '31-10-2026 UPI/P2A/100000000010/Rahul Sharma /UPI/Demo Bank                                 100.00                  1,41,549.50';
  const withRahulAgain = () =>
    fixture('axis-consolidated.txt').replace(/^( +Page 1 of 1)$/m, `${rahulAgain}\n$1`);

  it('suggests the category you gave the same payee before', () => {
    const first = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    const rahul = first.items.find((item) => item.payee === 'Rahul Sharma')!;
    expect(rahul.categoryId).toBeNull();
    updateStagedRow(db, rahul.id, { categoryId: categoryId('Gifts & Donations') });
    commitBatch(db, first.id);

    const next = stageStatement(db, { text: withRahulAgain(), file: file('b') });
    const fresh = next.items.find((item) => item.status === 'pending')!;
    expect(fresh).toMatchObject({
      payee: 'Rahul Sharma',
      categoryId: categoryId('Gifts & Donations'),
      categorySource: 'history',
    });
  });

  it('learns from a change made on the Transactions page too', () => {
    const first = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    commitBatch(db, first.id);
    const tx = listTransactions(db, { search: 'rahul' }).items[0]!;
    setTransactionCategory(db, tx.id, categoryId('Health'));

    const next = stageStatement(db, { text: withRahulAgain(), file: file('b') });
    expect(next.items.find((item) => item.status === 'pending')?.categoryId).toBe(categoryId('Health'));
  });

  it('stays quiet when earlier choices disagree', () => {
    const first = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    commitBatch(db, first.id);
    const tx = listTransactions(db, { search: 'rahul' }).items[0]!;
    setTransactionCategory(db, tx.id, categoryId('Health'));
    createTransaction(db, {
      date: '2026-09-01',
      description: 'Rahul Sharma',
      payee: 'Rahul Sharma',
      postings: [
        { accountId: savings, amount: -100 },
        { accountId: categoryId('Travel'), amount: 100 },
      ],
    });

    const next = stageStatement(db, { text: withRahulAgain(), file: file('b') });
    expect(next.items.find((item) => item.status === 'pending')?.categoryId).toBeNull();
  });

  it('prefers your rules over what it learned', () => {
    const first = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    updateStagedRow(db, first.items.find((item) => item.payee === 'Rahul Sharma')!.id, { categoryId: categoryId('Health') });
    commitBatch(db, first.id);
    createRule(db, { pattern: 'rahul', categoryId: categoryId('Rent') });

    const next = stageStatement(db, { text: withRahulAgain(), file: file('b') });
    expect(next.items.find((item) => item.status === 'pending')).toMatchObject({
      categoryId: categoryId('Rent'),
      categorySource: 'rule',
    });
  });
});

describe('discarding', () => {
  it('removes a staged import and reports the file to delete', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(discardBatch(db, batch.id)).toBe('a.pdf');
    expect(listImportBatches(db)).toEqual([]);
    expect(db.select().from(stagedTransactions).all()).toEqual([]);
  });

  it('cannot discard an import that is already in the ledger', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    commitBatch(db, batch.id);
    expect(() => discardBatch(db, batch.id)).toThrow(/already finished/);
  });
});

describe('a credit card statement', () => {
  it('charges the card, reconciles, and leaves the payment to the bank statement', () => {
    const batch = stageStatement(db, { text: fixture('axis-card.txt'), file: file('c') });
    expect(batch).toMatchObject({ accountId: card, accountKind: 'credit_card', reconciliation: 'ok' });

    const payment = batch.items.find((item) => item.channel === 'card_payment')!;
    expect(payment).toMatchObject({ status: 'skipped', amount: 500000 });

    commitBatch(db, batch.id);
    // 7,500 of charges, with the 5,000 payment recorded from the bank side instead.
    expect(balanceOf(card)).toBe(750000);
  });

  it('can take the payment from an account that is not imported', () => {
    const batch = stageStatement(db, { text: fixture('axis-card.txt'), file: file('c') });
    const payment = batch.items.find((item) => item.channel === 'card_payment')!;

    updateStagedRow(db, payment.id, { status: 'pending' });
    expect(() => commitBatch(db, batch.id)).toThrow(/each card payment/);

    updateStagedRow(db, payment.id, { categoryId: savings });
    commitBatch(db, batch.id);
    expect(balanceOf(card)).toBe(250000);
    expect(balanceOf(savings)).toBe(-500000);
  });

  it('does not count a payment twice when both statements are imported', () => {
    commitBatch(db, stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') }).id);
    commitBatch(db, stageStatement(db, { text: fixture('axis-card.txt'), file: file('c') }).id);
    // The bank paid 12,000 and the card was charged 7,500: 4,500 more than owed.
    expect(balanceOf(card)).toBe(750000 - 1200000);
  });
});

describe('card payments from the bank', () => {
  it('finds a card that was added after the statement was read', () => {
    db.delete(accounts).where(eq(accounts.id, card)).run();
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(batch.items.find((item) => item.channel === 'card_payment')?.categoryId).toBeNull();

    const added = createAccount(db, { name: 'New Card', type: 'liability', subtype: 'credit_card', numberLast4: '1234' }).id;
    const refreshed = refreshSuggestions(db, batch.id);
    expect(refreshed.items.find((item) => item.channel === 'card_payment')?.categoryId).toBe(added);
    expect(commitBatch(db, batch.id).status).toBe('committed');
  });

  it('never overwrites a choice made by hand', () => {
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    const swiggy = batch.items.find((item) => item.payee === 'Swiggy')!;
    updateStagedRow(db, swiggy.id, { categoryId: categoryId('Groceries') });
    refreshSuggestions(db, batch.id);
    expect(getImportBatch(db, batch.id).items.find((item) => item.id === swiggy.id)?.categoryId).toBe(
      categoryId('Groceries'),
    );
  });

  it('picks the card named in the narration when there are several', () => {
    const other = createAccount(db, { name: 'Other Card', type: 'liability', subtype: 'credit_card', numberLast4: '1234' }).id;
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(batch.items.find((item) => item.channel === 'card_payment')?.categoryId).toBe(other);
  });

  it('asks instead of guessing when it cannot tell', () => {
    createAccount(db, { name: 'Other Card', type: 'liability', subtype: 'credit_card', numberLast4: '5555' });
    const batch = stageStatement(db, { text: fixture('axis-consolidated.txt'), file: file('a') });
    expect(batch.items.find((item) => item.channel === 'card_payment')?.categoryId).toBeNull();
    expect(() => commitBatch(db, batch.id)).toThrow(/each card payment/);
  });
});
