import { importBatches, openDb } from '@ledgerly/db';
import { describe, expect, it } from 'vitest';
import { createAccount } from '../accounts.ts';
import { seedDefaults } from '../seed.ts';
import { csvBank, csvDate } from './adapters/csv-bank.ts';
import { commitBatch, stageStatement } from './batches.ts';
import { commitReadyImports, stageAnyStatement } from './bulk.ts';
import { detectAdapter } from './registry.ts';

// Made-up statements in the layouts banks commonly download.
const WITHDRAWAL_DEPOSIT = `Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/10/26,UPI-SWIGGY-1234-ORDER,0000123,01/10/26,450.00,,99550.00
03/10/26,NEFT-EMPLOYER-SALARY,N123,03/10/26,,80000.00,179550.00
05/10/26,"ATM WDL, MG ROAD",0000555,05/10/26,"10,000.00",,169550.00
`;

const DEBIT_CREDIT_PREAMBLE = `Account Name: DEMO CUSTOMER
Account Number: XXXXXX0000
Statement from 01-Oct-2026 to 31-Oct-2026

Txn Date;Value Date;Description;Ref No./Cheque No.;Debit;Credit;Balance
01-Oct-2026;01-Oct-2026;TO TRANSFER-UPI/DR/1/RENT;123;22000.00;;78000.00
04-Oct-2026;04-Oct-2026;BY TRANSFER-INTEREST;456;;120.50;78120.50
`;

// Newest first, one amount column with Dr/Cr.
const AMOUNT_TYPE = `Transaction Date,Transaction Remarks,Amount (INR),Dr/Cr,Balance (INR)
2026-10-09,POS COFFEE SHOP,250.00,DR,9750.00
2026-10-08,SALARY CREDIT,10000.00,CR,10000.00
`;

describe('bank CSV downloads', () => {
  it('reads withdrawal and deposit columns, quoted commas, Indian amounts and two-digit years', () => {
    const parsed = csvBank.parse(WITHDRAWAL_DEPOSIT);
    expect(parsed.rows).toMatchObject([
      { date: '2026-10-01', description: 'UPI-SWIGGY-1234-ORDER', amount: -450_00, balance: 99_550_00 },
      { date: '2026-10-03', amount: 80_000_00 },
      { date: '2026-10-05', description: 'ATM WDL, MG ROAD', amount: -10_000_00 },
    ]);
    expect(parsed).toMatchObject({ accountKind: 'bank', periodStart: '2026-10-01', periodEnd: '2026-10-05', openingBalance: 1_00_000_00, closingBalance: 1_69_550_00, statedNet: 69_550_00 });
    expect(parsed.warnings).toEqual([]);
  });

  it('skips a preamble and reads semicolons and month names', () => {
    const parsed = csvBank.parse(DEBIT_CREDIT_PREAMBLE);
    expect(parsed.rows.map((r) => [r.date, r.amount])).toEqual([['2026-10-01', -22_000_00], ['2026-10-04', 120_50]]);
    expect(parsed.closingBalance).toBe(78_120_50);
  });

  it('puts a newest-first download in order and reads a Dr/Cr column', () => {
    const parsed = csvBank.parse(AMOUNT_TYPE);
    expect(parsed.rows.map((r) => [r.date, r.amount])).toEqual([['2026-10-08', 10_000_00], ['2026-10-09', -250_00]]);
    expect(parsed).toMatchObject({ openingBalance: 0, closingBalance: 9_750_00, statedNet: 9_750_00 });
  });

  it('is recognised only when it looks like a statement, and parses dates in common forms', () => {
    expect(detectAdapter(WITHDRAWAL_DEPOSIT)?.id).toBe('csv-bank');
    expect(detectAdapter('Instrument,Qty.,Avg. cost,LTP,Cur. val\nA,1,2,3,4')).toBeUndefined();
    expect(detectAdapter('just some text')).toBeUndefined();
    expect(csvDate('5/3/26')).toBe('2026-03-05');
    expect(csvDate('05 Mar 2026')).toBe('2026-03-05');
    expect(csvDate('2026-03-05 10:11:12')).toBe('2026-03-05');
    expect(csvDate('hello')).toBeUndefined();
  });

  it('flags a running balance that does not follow from the amounts, so the import is checked', () => {
    const broken = WITHDRAWAL_DEPOSIT.replace('179550.00', '170000.00');
    const db = openDb(':memory:');
    seedDefaults(db);
    const account = createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank' }).id;
    const batch = stageStatement(db, { text: broken, accountId: account, file: { sha256: 'a', filename: 'b.csv', mimeType: 'text/csv', size: 1, storedName: 'a.csv' } });
    expect(batch.reconciliation).toBe('mismatch');
    expect(batch.warnings.join(' ')).toMatch(/running balance/);
    expect(() => commitBatch(db, batch.id)).toThrow(/don't match/);
  });

  it('imports into an account you choose, and in bulk waits for you to choose one', () => {
    const db = openDb(':memory:');
    seedDefaults(db);
    const account = createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank' }).id;
    const first = stageStatement(db, { text: WITHDRAWAL_DEPOSIT, accountId: account, file: { sha256: 'a', filename: 'a.csv', mimeType: 'text/csv', size: 1, storedName: 'a.csv' } });
    expect(first.reconciliation).toBe('ok');
    commitBatch(db, first.id);
    expect(db.select().from(importBatches).all()[0]!.status).toBe('committed');

    stageAnyStatement(db, { text: DEBIT_CREDIT_PREAMBLE, file: { sha256: 'b', filename: 'b.csv', mimeType: 'text/csv', size: 1, storedName: 'b.csv' } });
    const result = commitReadyImports(db);
    expect(result.held[0]!.reason).toMatch(/No account matched/);
  });
});
