import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccount, listAccounts, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const local = { host: 'localhost:4310' };
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => close?.());
const hasTools = ['qpdf', 'pdftotext'].every((tool) => spawnSync(tool, ['--version']).error === undefined);

function pdf(lines: string[], password?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerly-slip-'));
  const stream = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const raw = ['%PDF-1.4', '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj', '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj', '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj', `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`, '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj', 'trailer << /Root 1 0 R /Size 6 >>', '%%EOF'].join('\n');
  const source = join(dir, 'source.pdf');
  const out = join(dir, 'slip.pdf');
  writeFileSync(source, raw);
  spawnSync('qpdf', [source, ...(password ? ['--encrypt', password, `${password}-o`, '256', '--'] : []), out]);
  return out;
}

function upload(path: string, password?: string) {
  const boundary = 'b';
  const parts = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slip.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), readFileSync(path), Buffer.from('\r\n')];
  if (password) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${password}\r\n`));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { method: 'POST' as const, url: '/api/payslips/read', payload: Buffer.concat(parts), headers: { ...local, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function start(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-slips-'));
  const db = openDb(':memory:');
  seedDefaults(db);
  const app = await buildApp(db, { ...loadConfig({ DATA_DIR: dataDir, ...env }), webDir: '/nonexistent' });
  close = () => app.close();
  return { app, dataDir, db };
}

const LINES = ['Pay Slip for the month of October 2026', 'Gross Salary 1,20,000.00', 'Income Tax (TDS) 12,500.00', 'Provident Fund 7,200.00', 'Total Deductions 19,700.00', 'Net Pay 1,00,300.00'];

describe.skipIf(!hasTools)('payslip routes', () => {
  it('reads a payslip into a draft to confirm, and does not keep the file', async () => {
    const { app, dataDir } = await start();
    const res = await app.inject(upload(pdf(LINES)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ month: '2026-10', gross: 12_000_000, net: 10_030_000 });
    expect(readdirSync(dataDir).filter((f) => f === 'documents')).toEqual([]);
  });

  it('opens a locked payslip with the password given, or one saved for statements', async () => {
    const { app } = await start({ WATCH_PASSWORDS: 'abcd1234' });
    const locked = pdf(LINES, 'abcd1234');
    expect((await app.inject(upload(locked))).json()).toMatchObject({ month: '2026-10' });
    expect((await app.inject(upload(locked, 'wrong-one'))).statusCode).toBe(422);
    const { app: bare } = await start();
    expect((await bare.inject(upload(locked))).json().error).toMatch(/password/i);
  });

  it('records it once confirmed, lists it, and removes it with its entry', async () => {
    const { app, db } = await start();
    const bank = createAccount(db, { name: 'Axis Savings', type: 'asset', subtype: 'bank' });
    const body = { month: '2026-10', employer: 'Acme', accountId: bank.id, gross: 12_000_000, deductions: [{ label: 'Income tax', kind: 'tax', amount: 1_250_000 }] };
    const made = await app.inject({ method: 'POST', url: '/api/payslips', headers: local, payload: body });
    expect(made.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/payslips', headers: local })).json()).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/payslips', headers: local, payload: body })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/payslips/${made.json().id}`, headers: local })).statusCode).toBe(204);
    expect(listAccounts(db).length).toBeGreaterThan(0);
    expect((await app.inject({ url: '/api/payslips', headers: local })).json()).toEqual([]);
  });
});
