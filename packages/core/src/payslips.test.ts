import { documents, importBatches, openDb, stagedTransactions, type Db } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { commitBatch, createAccount, createPayslip, deletePayslip, ensureStarterCategories, getBalances, getCashFlow, listPayslips, listTransactions, parsePayslipText, payslipTotals, seedDefaults } from './index.ts';

const SLIP = `
ACME TECHNOLOGIES PVT LTD
Pay Slip for the month of October 2026
Employee: A. Sharma          PAN: XXXXX1234X

Earnings                          Deductions
Basic              60,000.00      Provident Fund      7,200.00
HRA                30,000.00      Professional Tax      200.00
Special Allowance  30,000.00      Income Tax (TDS)   12,500.00
Gross Salary      1,20,000.00     Total Deductions   19,900.00
                                  Employer PF (not deducted)  7,200.00
Net Pay            1,00,100.00
`;

describe('reading a payslip', () => {
  it('finds the month, the gross, the net, and the deductions, and names what it found', () => {
    const draft = parsePayslipText(SLIP);
    expect(draft.month).toBe('2026-10');
    expect(draft.gross).toBe(12_000_000);
    expect(draft.net).toBe(10_010_000);
    expect(draft.notes).toEqual([]);
    const byKind = Object.fromEntries(draft.deductions.map((d) => [d.kind, d.amount]));
    expect(byKind).toMatchObject({ tax: 1_250_000, professional_tax: 20_000 });
    expect(byKind.pf).toBe(720_000); // the employee's share, not the employer's line
    expect(draft.deductions.reduce((s, d) => s + d.amount, 0)).toBe(1_990_000);
  });

  it('says what it could not find, so the person fills it in', () => {
    const draft = parsePayslipText('Some other layout\nBasic 50,000');
    expect(draft.notes).toEqual(expect.arrayContaining(['Could not find the month', 'Could not find the gross pay', 'Could not find the net pay']));
  });
});

let db: Db;
let bank: number;
beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Axis Savings', type: 'asset', subtype: 'bank' }).id;
});
const slip = (over = {}) => ({ month: '2026-10', employer: 'Acme', accountId: bank, gross: 12_000_000, deductions: [{ label: 'Provident fund', kind: 'pf' as const, amount: 720_000 }, { label: 'Income tax', kind: 'tax' as const, amount: 1_250_000 }, { label: 'Professional tax', kind: 'professional_tax' as const, amount: 20_000 }], ...over });

describe('recording a payslip', () => {
  it('books the full salary and splits out the deductions, so only the net reaches the bank', () => {
    const made = createPayslip(db, slip());
    expect(made.net).toBe(12_000_000 - 1_990_000);
    expect(getBalances(db).find((b) => b.id === bank)!.balance).toBe(made.net);
    const flow = getCashFlow(db, { from: '2026-10-01', to: '2026-10-31' });
    expect(flow.income).toBe(12_000_000); // the whole salary, not only what reached the bank
    expect(flow.expenses).toBe(1_250_000 + 20_000); // tax; PF is saved, not spent
    expect(getBalances(db).find((b) => b.name === 'Provident Fund')!.balance).toBe(720_000);
    expect(listPayslips(db)).toHaveLength(1);
  });

  it('refuses a month that is already there, deductions larger than the pay, and a non-bank account', () => {
    createPayslip(db, slip());
    expect(() => createPayslip(db, slip())).toThrow(/already recorded/);
    expect(() => createPayslip(db, slip({ month: '2026-11', deductions: [{ label: 'x', kind: 'other', amount: 13_000_000 }] }))).toThrow(/more than the gross/);
    expect(() => createPayslip(db, slip({ month: '2026-12', accountId: 99999 }))).toThrow(/bank account/);
  });

  it('is taken over by the bank statement that shows the credit, keeping the split', () => {
    const made = createPayslip(db, slip());
    const doc = db.insert(documents).values({ sha256: 'a', filename: 's.pdf', mimeType: 'application/pdf', size: 1, storedName: 'a.pdf' }).returning().get();
    const batch = db.insert(importBatches).values({ documentId: doc.id, accountId: bank, adapterId: 'x', accountKind: 'bank', reconciliation: 'ok' }).returning().get();
    db.insert(stagedTransactions).values({ batchId: batch.id, position: 0, date: '2026-11-01', description: 'NEFT-ACME TECHNOLOGIES SALARY', amount: made.net, channel: 'other', fingerprint: 'f', status: 'pending' }).run();
    commitBatch(db, batch.id);
    const all = listTransactions(db, {}).items;
    expect(all).toHaveLength(1); // not two salaries
    expect(all[0]!.postings.length).toBe(5);
    expect(all[0]!.description).toBe('Salary 2026-10'); // the split entry keeps its own wording
    expect(all[0]!.source).toMatch(/^import:/);
  });

  it('can be removed, taking its entry with it, and adds up for the tax pack', () => {
    const made = createPayslip(db, slip());
    createPayslip(db, slip({ month: '2026-11' }));
    expect(payslipTotals(db, '2026-04-01', '2027-03-31').rows).toHaveLength(2);
    expect(payslipTotals(db, '2026-04-01', '2027-03-31').rows[0]).toMatchObject({ month: '2026-10', gross: 12_000_000, tax: 1_250_000, pf: 720_000, professionalTax: 20_000 });
    deletePayslip(db, made.id);
    expect(listPayslips(db)).toHaveLength(1);
    expect(listTransactions(db, {}).items).toHaveLength(1);
  });
});
