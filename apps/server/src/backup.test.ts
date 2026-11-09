import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimpleTransaction, createAccount, listAccounts, listTransactions, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { createBackup, listBackups, pruneBackups } from './backup.ts';
import { loadConfig } from './config.ts';
import { restoreBackup } from './restore.ts';

const monthsAgo = (months: number) => {
  const d = new Date(Date.now() + 10 * 86_400_000);
  d.setUTCDate(Math.min(d.getUTCDate(), 28));
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};
const local = { host: 'localhost:4310' };
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => close?.());

function setup(demoMode = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-backup-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, DEMO_MODE: String(demoMode) }), webDir: '/nonexistent' };
  const db = openDb(config.dbPath);
  seedDefaults(db);
  return { dataDir, config, db };
}

function addSpend(db: ReturnType<typeof openDb>, description: string, amount = 12_345) {
  const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' });
  const food = listAccounts(db).find((a) => a.type === 'expense')!;
  createSimpleTransaction(db, { date: '2026-10-01', description, kind: 'expense', accountId: bank.id, counterAccountId: food.id, amount } as never);
}

describe('backups', () => {
  it('writes a restorable archive with the database and documents', async () => {
    const { dataDir, config, db } = setup();
    mkdirSync(join(dataDir, 'documents'));
    writeFileSync(join(dataDir, 'documents', 'a.pdf'), 'pdf-bytes');
    addSpend(db, 'Lunch');

    const made = await createBackup(db, config);
    expect(made.name).toMatch(/^ledgerly-\d{8}-\d{6}\.tar\.gz$/);
    expect(await listBackups(config)).toHaveLength(1);
    db.close();

    // Restore into a fresh data directory, as on a new machine.
    const fresh = mkdtempSync(join(tmpdir(), 'ledgerly-fresh-'));
    await restoreBackup(join(dataDir, 'backups', made.name), fresh);
    const restored = openDb(join(fresh, 'ledgerly.db'));
    expect(listTransactions(restored).items.map((t) => t.description)).toEqual(['Lunch']);
    restored.close();
    expect(readFileSync(join(fresh, 'documents', 'a.pdf'), 'utf8')).toBe('pdf-bytes');
  });

  it('keeps what it replaces when restoring over live data', async () => {
    const { dataDir, config, db } = setup();
    addSpend(db, 'Before');
    const made = await createBackup(db, config);
    createSimpleTransaction(db, { date: '2026-10-02', description: 'After', kind: 'expense', accountId: listAccounts(db).find((a) => a.type === 'asset')!.id, counterAccountId: listAccounts(db).find((a) => a.type === 'expense')!.id, amount: 100 } as never);
    db.close();

    const { kept } = await restoreBackup(join(dataDir, 'backups', made.name), dataDir);
    expect(kept).toHaveLength(1);
    const live = openDb(config.dbPath);
    expect(listTransactions(live).items.map((t) => t.description)).toEqual(['Before']);
    live.close();
    const old = openDb(kept[0]!);
    expect(listTransactions(old).total).toBe(2);
    old.close();
  });

  it('rejects a file that is not a backup', async () => {
    const { dataDir } = setup();
    const junk = join(dataDir, 'junk.tar.gz');
    writeFileSync(junk, 'not a tar');
    await expect(restoreBackup(junk, dataDir)).rejects.toThrow();
  });

  it('keeps only the newest backups', async () => {
    const { dataDir, config } = setup();
    mkdirSync(join(dataDir, 'backups'));
    for (let i = 1; i <= 5; i++) writeFileSync(join(dataDir, 'backups', `ledgerly-2026010${i}-000000.tar.gz`), 'x');
    await pruneBackups(config, 2);
    expect((await listBackups(config)).map((b) => b.name)).toEqual([
      'ledgerly-20260105-000000.tar.gz',
      'ledgerly-20260104-000000.tar.gz',
    ]);
  });
});

describe('backup and export routes', () => {
  it('creates, downloads and deletes a backup, and refuses odd names', async () => {
    const { config, db } = setup();
    const app = await buildApp(db, config);
    close = () => app.close();

    const created = await app.inject({ method: 'POST', url: '/api/backups', headers: local });
    expect(created.statusCode).toBe(201);
    const { name } = created.json();

    const file = await app.inject({ method: 'GET', url: `/api/backups/${name}`, headers: local });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toContain(name);
    expect(file.rawPayload.length).toBeGreaterThan(100);

    for (const bad of ['..%2Fledgerly.db', 'ledgerly.db', 'ledgerly-20260101-000000.tar.gz']) {
      const res = await app.inject({ method: 'GET', url: `/api/backups/${bad}`, headers: local });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }

    expect((await app.inject({ method: 'DELETE', url: `/api/backups/${name}`, headers: local })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/backups', headers: local })).json().items).toEqual([]);
  });

  it('is off in demo mode', async () => {
    const { config, db } = setup(true);
    const app = await buildApp(db, config);
    close = () => app.close();
    expect((await app.inject({ method: 'POST', url: '/api/backups', headers: local })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/backups', headers: local })).json().enabled).toBe(false);
  });

  it('exports transactions as CSV with formulas defused', async () => {
    const { config, db } = setup();
    addSpend(db, '=HYPERLINK("x"), lunch');
    const app = await buildApp(db, config);
    close = () => app.close();

    const res = await app.inject({ method: 'GET', url: '/api/export/transactions.csv?from=2026-10-01&to=2026-10-31', headers: local });
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe('Date,Description,Payee,Account,Account type,Amount (INR),Tags');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(`"'=HYPERLINK(""x""), lunch"`);
    expect(res.body).toContain('-123.45');
    expect(res.body).toContain(',123.45,');
  });
});

describe('budget routes', () => {
  it('sets, lists and removes a budget', async () => {
    const { config, db } = setup();
    const app = await buildApp(db, config);
    close = () => app.close();
    const category = listAccounts(db).find((a) => a.type === 'expense')!;

    const put = await app.inject({ method: 'PUT', url: `/api/budgets/${category.id}`, headers: local, payload: { amount: 250_000 } });
    expect(put.statusCode).toBe(200);
    const status = (await app.inject({ method: 'GET', url: '/api/budgets?month=2026-10', headers: local })).json();
    expect(status.items).toMatchObject([{ name: category.name, amount: 250_000, spent: 0 }]);

    expect((await app.inject({ method: 'PUT', url: `/api/budgets/${category.id}`, headers: local, payload: { amount: -5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/budgets?month=bad', headers: local })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/budgets/${category.id}`, headers: local })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/budgets/${category.id}`, headers: local })).statusCode).toBe(404);
  });
});

describe('recurring routes', () => {
  it('lists detected payments, and hides and restores one', async () => {
    const { config, db } = setup();
    const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' });
    const cat = listAccounts(db).find((a) => a.type === 'expense')!;
    for (const date of [3, 2, 1].map(monthsAgo)) {
      createSimpleTransaction(db, { date, description: 'Spotify', kind: 'expense', accountId: bank.id, counterAccountId: cat.id, amount: 11_900 } as never);
    }
    const app = await buildApp(db, config);
    close = () => app.close();

    const first = (await app.inject({ method: 'GET', url: '/api/recurring', headers: local })).json();
    expect(first.items).toHaveLength(1);
    const { key } = first.items[0];
    await app.inject({ method: 'POST', url: '/api/recurring/hide', headers: local, payload: { key } });
    const hidden = (await app.inject({ method: 'GET', url: '/api/recurring', headers: local })).json();
    expect(hidden.items[0].hidden).toBe(true);
    expect(hidden.monthly).toBe(0);
    await app.inject({ method: 'POST', url: '/api/recurring/show', headers: local, payload: { key } });
    expect((await app.inject({ method: 'GET', url: '/api/recurring', headers: local })).json().items[0].hidden).toBe(false);
  });
});

describe('category routes', () => {
  it('creates, merges and lists categories', async () => {
    const { config, db } = setup();
    const app = await buildApp(db, config);
    close = () => app.close();
    const created = await app.inject({ method: 'POST', url: '/api/categories', headers: local, payload: { name: 'Pets', type: 'expense' } });
    expect(created.statusCode).toBe(201);
    const fuel = listAccounts(db).find((a) => a.name === 'Fuel')!;

    const merged = await app.inject({ method: 'POST', url: `/api/categories/${fuel.id}/merge`, headers: local, payload: { intoId: created.json().id } });
    expect(merged.json()).toEqual({ into: 'Pets', transactions: 0, rules: 0 });
    const names = (await app.inject({ method: 'GET', url: '/api/categories', headers: local })).json().map((c: { name: string }) => c.name);
    expect(names).toContain('Pets');
    expect(names).not.toContain('Fuel');

    const bad = await app.inject({ method: 'POST', url: `/api/categories/${created.json().id}/merge`, headers: local, payload: { intoId: created.json().id } });
    expect(bad.statusCode).toBe(400);
    const dup = await app.inject({ method: 'POST', url: '/api/categories', headers: local, payload: { name: 'Pets', type: 'expense' } });
    expect(dup.statusCode).toBe(409);
  });
});

const hasQpdf = spawnSync('qpdf', ['--version']).error === undefined && spawnSync('pdftotext', ['-v']).error === undefined;

describe.skipIf(!hasQpdf)('locked statements', () => {
  function lockedPdf(password: string) {
    const dir = mkdtempSync(join(tmpdir(), 'ledgerly-locked-'));
    const plain = join(dir, 'plain.pdf');
    writeFileSync(plain, ['%PDF-1.4', '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj', '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj', '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj', 'trailer << /Root 1 0 R /Size 4 >>', '%%EOF'].join('\n'));
    const out = join(dir, 'locked.pdf');
    spawnSync('qpdf', [plain, '--encrypt', password, `${password}-owner`, '256', '--', out]);
    return readFileSync(out);
  }

  function upload(url: string, pdf: Buffer, password?: string) {
    const boundary = 'testboundary';
    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`, 'latin1'),
      pdf,
      Buffer.from('\r\n', 'latin1'),
      ...(password ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${password}\r\n`, 'utf8')] : []),
      Buffer.from(`--${boundary}--\r\n`, 'latin1'),
    ];
    return { method: 'POST' as const, url, payload: Buffer.concat(parts), headers: { ...local, 'content-type': `multipart/form-data; boundary=${boundary}` } };
  }

  it.each(['/api/imports', '/api/investments/imports'])('asks for the password on %s, and keeps nothing when it is wrong', async (url) => {
    const { config, db, dataDir } = setup();
    const app = await buildApp(db, config);
    close = () => app.close();
    const pdf = lockedPdf('s3cret!');

    const none = await app.inject(upload(url, pdf));
    expect(none.statusCode).toBe(422);
    expect(none.json().code).toBe('password_required');

    const wrong = await app.inject(upload(url, pdf, 'nope'));
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().code).toBe('wrong_password');
    expect(wrong.body).not.toContain('nope');

    // The right password gets past the lock; this blank page is then simply not a statement.
    const right = await app.inject(upload(url, pdf, 's3cret!'));
    expect(right.statusCode).toBe(400);
    expect(right.json().code).toBe('invalid');
    expect(right.body).not.toMatch(/password/i);
    expect(existsSync(join(dataDir, 'documents')) ? readdirSync(join(dataDir, 'documents')) : []).toEqual([]);
  });
});
