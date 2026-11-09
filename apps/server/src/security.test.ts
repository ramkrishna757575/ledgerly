import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimpleTransaction, createAccount, ensureStarterCategories, listAccounts, listActivity, listTransactions, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { createBackup } from './backup.ts';
import { loadConfig } from './config.ts';
import { decryptFile, encryptFile, WrongPassphrase } from './crypt.ts';
import { restoreBackup } from './restore.ts';

const local = { host: 'localhost:4310' };
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => close?.());

function cookieOf(res: { headers: Record<string, unknown> }) {
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]!;
}

async function start(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-sec-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, ...env }), webDir: '/nonexistent' };
  const db = openDb(config.dbPath);
  seedDefaults(db);
  ensureStarterCategories(db);
  const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' });
  createSimpleTransaction(db, { date: '2026-10-01', description: 'Lunch', kind: 'expense', accountId: bank.id, counterAccountId: listAccounts(db).find((a) => a.name === 'Food & Dining')!.id, amount: 500_00 } as never);
  const app = await buildApp(db, config);
  close = () => app.close();
  return { app, db, config, dataDir };
}

const login = (app: Awaited<ReturnType<typeof start>>['app'], password: string) =>
  app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { password } });

describe('read-only login', () => {
  it('needs the owner password to be set, and a different one', () => {
    expect(() => loadConfig({ VIEWER_PASSWORD: 'v' })).toThrow(/AUTH_PASSWORD/);
    expect(() => loadConfig({ AUTH_PASSWORD: 'same', VIEWER_PASSWORD: 'same' })).toThrow(/differ/);
  });

  it('lets a viewer look at everything and change nothing', async () => {
    const { app } = await start({ AUTH_PASSWORD: 'owner-pass', VIEWER_PASSWORD: 'viewer-pass' });
    expect((await login(app, 'wrong')).statusCode).toBe(401);

    const viewer = await login(app, 'viewer-pass');
    expect(viewer.json()).toMatchObject({ authenticated: true, role: 'viewer' });
    const cookie = { ...local, cookie: cookieOf(viewer) };

    expect((await app.inject({ url: '/api/auth/status', headers: cookie })).json().role).toBe('viewer');
    expect((await app.inject({ url: '/api/transactions', headers: cookie })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/reports/net-worth', headers: cookie })).statusCode).toBe(200);

    const write = await app.inject({ method: 'POST', url: '/api/accounts', headers: cookie, payload: { name: 'X', type: 'asset' } });
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toMatch(/read-only/);
    expect((await app.inject({ method: 'DELETE', url: '/api/transactions/1', headers: cookie })).statusCode).toBe(403);
    // Not the database copies or the agent tokens.
    expect((await app.inject({ url: '/api/backups', headers: cookie })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/agents/tokens', headers: cookie })).statusCode).toBe(403);
  });

  it('gives the owner full access, and a viewer cannot become one', async () => {
    const { app } = await start({ AUTH_PASSWORD: 'owner-pass', VIEWER_PASSWORD: 'viewer-pass' });
    const owner = await login(app, 'owner-pass');
    expect(owner.json().role).toBe('owner');
    const cookie = { ...local, cookie: cookieOf(owner) };
    expect((await app.inject({ method: 'POST', url: '/api/accounts', headers: cookie, payload: { name: 'Cash', type: 'asset', subtype: 'cash' } })).statusCode).toBe(201);
    expect((await app.inject({ url: '/api/backups', headers: cookie })).statusCode).toBe(200);
  });
});

describe('change log', () => {
  it('records who changed what, and never what was typed', async () => {
    const { app, db } = await start({ AUTH_PASSWORD: 'owner-pass', VIEWER_PASSWORD: 'viewer-pass' });
    const owner = cookieOf(await login(app, 'owner-pass'));
    await app.inject({ method: 'POST', url: '/api/accounts', headers: { ...local, cookie: owner }, payload: { name: 'Secret savings 99', type: 'asset', subtype: 'bank' } });
    await app.inject({ method: 'DELETE', url: '/api/transactions/1', headers: { ...local, cookie: owner } });
    await login(app, 'bad-guess');
    const viewer = cookieOf(await login(app, 'viewer-pass'));
    await app.inject({ method: 'DELETE', url: '/api/transactions/2', headers: { ...local, cookie: viewer } });

    const rows = listActivity(db);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/Secret savings|owner-pass|bad-guess|viewer-pass/);
    const brief = rows.map((r) => `${r.actor} ${r.tool} ${r.outcome}`);
    expect(brief).toContain('user:owner POST /api/accounts ok');
    expect(brief).toContain('user:owner DELETE /api/transactions/:id ok');
    expect(brief).toContain('user:anonymous POST /api/auth/login denied');
    expect(brief).toContain('user:viewer DELETE /api/transactions/:id denied');
    expect(rows.find((r) => r.tool === 'DELETE /api/transactions/:id')!.detail).toMatch(/id=/);
    expect((await app.inject({ url: '/api/activity', headers: { ...local, cookie: owner } })).json().length).toBeGreaterThan(3);
    // Agents see their own audit trail, not this one.
    expect((await app.inject({ url: '/api/agents/activity', headers: { ...local, cookie: owner } })).json()).toEqual([]);
  });
});

describe('encrypted backups', () => {
  it('encrypts and decrypts a file, and refuses a wrong passphrase or a changed file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledgerly-crypt-'));
    writeFileSync(join(dir, 'plain'), 'my finances '.repeat(5000));
    await encryptFile(join(dir, 'plain'), join(dir, 'enc'), 'correct horse');
    const encrypted = readFileSync(join(dir, 'enc'));
    expect(encrypted.toString('latin1')).not.toContain('my finances');
    expect(encrypted.subarray(0, 5).toString()).toBe('LGBK1');

    await decryptFile(join(dir, 'enc'), join(dir, 'out'), 'correct horse');
    expect(readFileSync(join(dir, 'out'), 'utf8')).toBe('my finances '.repeat(5000));
    await expect(decryptFile(join(dir, 'enc'), join(dir, 'bad'), 'wrong')).rejects.toBeInstanceOf(WrongPassphrase);
    encrypted[200] = encrypted[200]! ^ 1;
    writeFileSync(join(dir, 'tampered'), encrypted);
    await expect(decryptFile(join(dir, 'tampered'), join(dir, 'bad2'), 'correct horse')).rejects.toBeInstanceOf(WrongPassphrase);
    writeFileSync(join(dir, 'junk'), 'not a backup at all, just text');
    await expect(decryptFile(join(dir, 'junk'), join(dir, 'bad3'), 'x')).rejects.toThrow(/Not an encrypted/);
  });

  it('makes encrypted backups when a passphrase is set, that restore with it and not without', async () => {
    const { db, config, dataDir } = await start({ BACKUP_PASSPHRASE: 'backup secret' });
    mkdirSync(join(dataDir, 'documents'), { recursive: true });
    const made = await createBackup(db, config);
    expect(made).toMatchObject({ encrypted: true });
    expect(made.name).toMatch(/\.tar\.gz\.enc$/);
    expect(readFileSync(join(dataDir, 'backups', made.name)).includes('Lunch')).toBe(false);
    db.close();

    const fresh = mkdtempSync(join(tmpdir(), 'ledgerly-fresh-'));
    await expect(restoreBackup(join(dataDir, 'backups', made.name), fresh)).rejects.toThrow(/BACKUP_PASSPHRASE/);
    await expect(restoreBackup(join(dataDir, 'backups', made.name), fresh, 'ledgerly.db', 'wrong')).rejects.toThrow(/Wrong passphrase/);
    await restoreBackup(join(dataDir, 'backups', made.name), fresh, 'ledgerly.db', 'backup secret');
    expect(listTransactions(openDb(join(fresh, 'ledgerly.db'))).items.map((t) => t.description)).toEqual(['Lunch']);
  });
});
