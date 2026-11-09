import { investmentImports, investmentTransactions, openDb, positions } from '@ledgerly/db';
import { createAccount, createSimpleTransaction, ensureStarterCategories, listAccounts, seedDefaults } from '@ledgerly/core';
import { beforeEach, describe, expect, it } from 'vitest';
import readXlsxFile from 'read-excel-file/node';
import { taxPackWorkbook } from './taxpack.ts';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
});

describe('the tax pack workbook', () => {
  it('has a sheet for each part, with the sales and the interest lines behind the totals', async () => {
    const importId = db.insert(investmentImports).values({ source: 'cdsl', asOf: '2026-11-01', payload: {} as never, warnings: [] }).returning().get().id;
    const fund = db.insert(positions).values({ name: 'Index Fund', isin: 'INF000A00001', assetClass: 'equity' }).returning().get().id;
    const trade = (date: string, kind: 'purchase' | 'redemption', rupees: number, units: number) =>
      db.insert(investmentTransactions).values({ importId, positionId: fund, date, kind, amount: rupees * 100, units: Math.round(units * 1_000_000) * (kind === 'redemption' ? -1 : 1), description: kind, fingerprint: `${date}${kind}` }).run();
    trade('2025-01-01', 'purchase', 100_000, 100);
    trade('2026-06-01', 'redemption', 130_000, 100);

    const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' });
    const interest = listAccounts(db).find((a) => a.type === 'income' && a.name === 'Interest')!;
    createSimpleTransaction(db, { date: '2026-07-01', description: 'Savings interest', kind: 'income', accountId: bank.id, counterAccountId: interest.id, amount: 1_234_50 } as never);

    const buffer = await taxPackWorkbook(db, '2026-27');
    const sheets = await readXlsxFile(buffer);
    const rowsOf = (name: string) => sheets.find((s) => s.sheet === name)!.data;
    expect(sheets.map((s) => s.sheet)).toEqual(['Summary', 'Mutual fund sales', 'Deposit interest', 'Interest received', 'Deductions', 'Salary', 'Tax paid']);

    const sales = rowsOf('Mutual fund sales');
    expect(sales[0]).toEqual(expect.arrayContaining(['Fund', 'ISIN', 'Gain (INR)']));
    expect(sales[1]).toEqual(expect.arrayContaining(['Index Fund', 'INF000A00001', 30000, 'Long term']));

    const received = rowsOf('Interest received');
    expect(received[1]).toEqual(expect.arrayContaining(['Savings interest', 1234.5]));
    expect(JSON.stringify(rowsOf('Summary'))).toContain('Tax pack for 2026-27');
  });
});
