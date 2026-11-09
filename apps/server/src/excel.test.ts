import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import writeExcelFile from 'write-excel-file/node';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { readExport } from './uploads.ts';

const local = { host: 'localhost:4310' };
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => close?.());

async function workbook(rows: unknown[][]) {
  return Buffer.from(await (writeExcelFile as unknown as (d: unknown) => { toBuffer(): Promise<Buffer> })(rows).toBuffer());
}

function upload(name: string, content: Buffer) {
  const boundary = 'b';
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { method: 'POST' as const, url: '/api/statements', payload, headers: { ...local, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('Excel files', () => {
  it('are read as the table they hold, with dates, quoted commas and the biggest sheet', async () => {
    const buffer = await workbook([
      ['Date', 'Narration', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      [{ value: new Date('2026-10-01T00:00:00Z'), type: Date, format: 'dd/mm/yyyy' }, 'ATM, MG ROAD', 10000, null, 90000],
      [{ value: new Date('2026-10-03T00:00:00Z'), type: Date, format: 'dd/mm/yyyy' }, 'SALARY', null, 50000, 140000],
    ]);
    const read = (await readExport(buffer))!;
    expect(read.ext).toBe('xlsx');
    expect(read.text.split('\n')).toEqual([
      'Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance',
      '2026-10-01,"ATM, MG ROAD",10000,,90000',
      '2026-10-03,SALARY,,50000,140000',
    ]);
  });

  it('still reads plain text, and refuses what is neither', async () => {
    expect((await readExport(Buffer.from('a,b,c\n1,2,3')))!).toMatchObject({ ext: 'csv', text: 'a,b,c\n1,2,3' });
    expect(await readExport(Buffer.from([0, 1, 2, 3]))).toBeNull();
    expect(await readExport(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBeNull(); // a zip that is not a workbook
  });

  it('import as a bank statement and as a holdings export', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-xlsx-'));
    const config = { ...loadConfig({ DATA_DIR: dataDir }), webDir: '/nonexistent' };
    const db = openDb(config.dbPath);
    seedDefaults(db);
    const app = await buildApp(db, config);
    close = () => app.close();

    const bank = await workbook([
      ['Date', 'Narration', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      [{ value: new Date('2026-10-01T00:00:00Z'), type: Date, format: 'dd/mm/yyyy' }, 'UPI SWIGGY', 450, null, 99550],
      [{ value: new Date('2026-10-03T00:00:00Z'), type: Date, format: 'dd/mm/yyyy' }, 'SALARY', null, 80000, 179550],
    ]);
    const staged = await app.inject(upload('statement.xlsx', bank));
    expect(staged.statusCode).toBe(201);
    expect(staged.json()).toMatchObject({ kind: 'bank', filename: 'statement.xlsx' });
    const batch = (await app.inject({ url: `/api/imports/${staged.json().id}`, headers: local })).json();
    expect(batch).toMatchObject({ reconciliation: 'ok', periodStart: '2026-10-01', periodEnd: '2026-10-03' });
    expect(batch.items.map((i: { amount: number }) => i.amount)).toEqual([-450_00, 80_000_00]);

    const funds = await workbook([['Instrument', 'Qty.', 'Avg. cost', 'LTP', 'Cur. val'], ['Sample Corp Ltd', 10, 1500, 1650.5, 16505]]);
    expect((await app.inject(upload('holdings.xlsx', funds))).json()).toMatchObject({ kind: 'investment' });
    expect((await app.inject(upload('holdings.xlsx', funds))).statusCode).toBe(409);
  });
});
