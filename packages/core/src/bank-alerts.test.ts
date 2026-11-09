import { accounts, alertEntries, documents, importBatches, openDb, stagedTransactions, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { addAlert, commitBatch, createAccount, dismissAlert, ensureStarterCategories, getAutoAdd, listAccounts, listAlertEntries, listTransactions, parseAlertEmail, recordAlert, seedDefaults, setAutoAdd } from './index.ts';

describe('reading a bank alert', () => {
  it('reads a card spend: how much, which card, where, and when', () => {
    const alert = parseAlertEmail('Transaction alert', 'INR 1,250.00 spent on your Axis Bank Credit Card no. XX7788 at SWIGGY BANGALORE on 05-11-26 14:32:11. Available limit INR 80,000.00.')!;
    expect(alert).toMatchObject({ amount: 125_000, direction: 'out', kind: 'card', last4: '7788', date: '2026-11-05' });
    expect(alert.description).toMatch(/SWIGGY/);
  });

  it('reads a bank debit with its UPI details, and a credit', () => {
    const debit = parseAlertEmail('Debit alert', 'Dear Customer, INR 500.00 was debited from your A/c no. XX1234 on 05-Nov-26. Info- UPI/P2M/123456789012/ZOMATO. Avl Bal INR 10,000.00')!;
    expect(debit).toMatchObject({ amount: 50_000, direction: 'out', kind: 'account', last4: '1234', date: '2026-11-05', reference: '123456789012' });
    expect(debit.description).toBe('UPI/P2M/123456789012/ZOMATO');
    const credit = parseAlertEmail('Credit alert', 'Rs. 85,398.00 has been credited to your account ending 1234 on 01/11/2026. Info: NEFT-ACME LTD SALARY.')!;
    expect(credit).toMatchObject({ amount: 8_539_800, direction: 'in', last4: '1234', date: '2026-11-01' });
  });

  it('leaves alone anything it cannot be sure of', () => {
    expect(parseAlertEmail('OTP', 'Your OTP for INR 500 payment on card XX7788 is 123456')).toBeNull();
    expect(parseAlertEmail('Offer', 'Get INR 500 off on your next order')).toBeNull();
    expect(parseAlertEmail('Transfer', 'INR 500 debited from A/c XX1234 and credited to A/c XX5678')).toBeNull(); // both ways
    expect(parseAlertEmail('Spent', 'INR 500 spent at a shop')).toBeNull(); // no account
    expect(parseAlertEmail('x', 'Your statement is ready')).toBeNull();
  });

  it('uses the day the mail arrived when it names no date', () => {
    expect(parseAlertEmail('Alert', 'INR 99 spent on card XX7788 at UBER', '2026-11-07')!.date).toBe('2026-11-07');
  });
});

let db: Db;
let card: number;
beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  card = createAccount(db, { name: 'Axis Card', type: 'liability', subtype: 'credit_card', numberLast4: '7788' } as never).id;
});
const swiggy = () => parseAlertEmail('Transaction alert', 'INR 1,250.00 spent on your Axis Bank Credit Card no. XX7788 at SWIGGY on 05-11-26.')!;

describe('keeping alerts', () => {
  it('finds the account by its last four digits, shows it, and adds it on request, filed by what it looks like', () => {
    const { entry } = recordAlert(db, swiggy(), 'axisbank.com');
    expect(entry).toMatchObject({ accountId: card, status: 'new', amount: -125_000 });
    expect(listAlertEntries(db)).toHaveLength(1);
    expect(listTransactions(db, {}).items).toHaveLength(0); // nothing in the books yet
    addAlert(db, entry!.id);
    const [tx] = listTransactions(db, {}).items;
    expect(tx!.postings.map((p) => p.accountName).sort()).toEqual(['Axis Card', 'Food & Dining']);
    expect(tx!.source).toBe(`alert:${entry!.id}`);
    expect(() => addAlert(db, entry!.id)).toThrow(/already been dealt with/);
  });

  it('does not add the same alert twice, and can be told to add them automatically', () => {
    expect(recordAlert(db, swiggy(), 'axisbank.com').entry).not.toBeNull();
    expect(recordAlert(db, swiggy(), 'axisbank.com').entry).toBeNull();
    setAutoAdd(db, true);
    expect(getAutoAdd(db)).toBe(true);
    const other = parseAlertEmail('Alert', 'INR 99.00 spent on card XX7788 at UBER INDIA on 06-11-26')!;
    expect(recordAlert(db, other, 'axisbank.com')).toMatchObject({ added: true });
    expect(listTransactions(db, {}).items).toHaveLength(1);
  });

  it('asks which account when two could be meant, and can be dismissed', () => {
    createAccount(db, { name: 'Other Card', type: 'liability', subtype: 'credit_card', numberLast4: '7788' } as never);
    const { entry } = recordAlert(db, swiggy(), 'axisbank.com');
    expect(entry!.accountId).toBeNull();
    expect(() => addAlert(db, entry!.id)).toThrow(/Choose which account/);
    dismissAlert(db, entry!.id);
    expect(listAlertEntries(db)).toHaveLength(0);
  });
});

function stage(accountId: number, rows: { date: string; amount: number; description: string; categoryId?: number }[]) {
  const doc = db.insert(documents).values({ sha256: String(Math.random()), filename: 's.pdf', mimeType: 'application/pdf', size: 1, storedName: `${Math.random()}.pdf` }).returning().get();
  const batch = db.insert(importBatches).values({ documentId: doc.id, accountId, adapterId: 'x', accountKind: 'credit_card', reconciliation: 'ok' }).returning().get();
  rows.forEach((row, position) => db.insert(stagedTransactions).values({ batchId: batch.id, position, date: row.date, description: row.description, amount: row.amount, channel: 'other', fingerprint: `f${position}${Math.random()}`, categoryId: row.categoryId ?? null, status: 'pending' }).run());
  return batch.id;
}

describe('when the statement arrives', () => {
  it('takes over the transaction the alert already added, keeping what you did to it, instead of adding it twice', () => {
    const { entry } = recordAlert(db, swiggy(), 'axisbank.com');
    addAlert(db, entry!.id);
    const [added] = listTransactions(db, {}).items;
    const shopping = listAccounts(db).find((a) => a.type === 'expense' && a.name === 'Shopping')!;

    // The statement shows it a day later, with the bank's own wording.
    commitBatch(db, stage(card, [{ date: '2026-11-06', amount: -125_000, description: 'SWIGGY BANGALORE IN', categoryId: shopping.id }, { date: '2026-11-07', amount: -30_000, description: 'UBER INDIA' }]));
    const all = listTransactions(db, {}).items;
    expect(all).toHaveLength(2); // not 3
    const taken = all.find((t) => t.id === added!.id)!;
    expect(taken.date).toBe('2026-11-06');
    expect(taken.source).toMatch(/^import:/);
    // It was filed by the alert's guess (Food & Dining), which is kept.
    expect(taken.postings.map((p) => p.accountName)).toContain('Food & Dining');
  });

  it('files an adopted transaction by the statement\'s category when the alert could only guess', () => {
    const odd = parseAlertEmail('Alert', 'INR 777.00 spent on card XX7788 at QWERTYSHOP on 05-11-26')!;
    const { entry } = recordAlert(db, odd, 'axisbank.com');
    addAlert(db, entry!.id);
    const shopping = listAccounts(db).find((a) => a.type === 'expense' && a.name === 'Shopping')!;
    commitBatch(db, stage(card, [{ date: '2026-11-05', amount: -77_700, description: 'QWERTYSHOP', categoryId: shopping.id }]));
    expect(listTransactions(db, {}).items[0]!.postings.map((p) => p.accountName)).toContain('Shopping');
  });

  it('marks an alert nobody added as covered, and leaves unrelated ones alone', () => {
    const { entry } = recordAlert(db, swiggy(), 'axisbank.com');
    const far = parseAlertEmail('Alert', 'INR 500.00 spent on card XX7788 at SOMEWHERE on 25-10-26')!;
    const { entry: other } = recordAlert(db, far, 'axisbank.com');
    commitBatch(db, stage(card, [{ date: '2026-11-05', amount: -125_000, description: 'SWIGGY' }]));
    expect(db.select().from(alertEntries).where(eq(alertEntries.id, entry!.id)).get()!.status).toBe('dismissed');
    expect(db.select().from(alertEntries).where(eq(alertEntries.id, other!.id)).get()!.status).toBe('new');
    expect(db.select().from(accounts).all().length).toBeGreaterThan(0);
  });
});
