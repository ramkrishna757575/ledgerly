import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccount, createSimpleTransaction, listAccounts, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { describe, expect, it } from 'vitest';
import { createBackup, backupsDir, tickBackup } from './backup.ts';
import { loadConfig, loadOffsite } from './config.ts';
import { copyOffsite, offsiteState, verifyBackup } from './offsite.ts';

function setup(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-off-'));
  const copies = mkdtempSync(join(tmpdir(), 'ledgerly-copies-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, BACKUP_PASSPHRASE: 'a long backup passphrase', BACKUP_COPY_DIR: copies, ...env }), webDir: '/nonexistent' };
  const db = openDb(config.dbPath);
  seedDefaults(db);
  const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' });
  const food = listAccounts(db).find((a) => a.type === 'expense')!;
  createSimpleTransaction(db, { date: '2026-10-01', description: 'Lunch', kind: 'expense', accountId: bank.id, counterAccountId: food.id, amount: 12_345 } as never);
  return { dataDir, copies, config, db };
}

describe('where backups are copied', () => {
  it('needs a passphrase, so nothing readable ever leaves the machine', () => {
    expect(loadOffsite({ BACKUP_COPY_DIR: '/mnt/nas' }).offsiteProblem).toMatch(/BACKUP_PASSPHRASE/);
    expect(loadOffsite({ BACKUP_COPY_DIR: '/mnt/nas', BACKUP_PASSPHRASE: 'x' }).offsite).toEqual({ dir: '/mnt/nas' });
    expect(loadOffsite({ BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_PASSPHRASE: 'x' }).offsiteProblem).toMatch(/BACKUP_S3_BUCKET/);
    expect(loadOffsite({}).offsite).toBeUndefined();
  });
});

describe('copying a backup out', () => {
  it('copies the encrypted file into a folder of its own and remembers it did', async () => {
    const { config, db, copies } = setup();
    const made = await createBackup(db, config);
    const outcome = await copyOffsite(db, config, 'asha', made.name);
    expect(outcome).toMatchObject({ ok: true, name: made.name });
    expect(existsSync(join(copies, 'asha', made.name))).toBe(true);
    expect(offsiteState(db, config).last).toMatchObject({ ok: true });
  });

  it('keeps only as many copies as are kept here', async () => {
    const { config, db, copies } = setup();
    const small = { ...config, backupKeep: 2 };
    const dir = join(copies, 'asha');
    const made = await createBackup(db, small);
    mkdirSync(dir, { recursive: true });
    for (const stamp of ['20250101-000000', '20250102-000000', '20250103-000000']) writeFileSync(join(dir, `ledgerly-${stamp}.tar.gz.enc`), '');
    await copyOffsite(db, small, 'asha', made.name);
    expect(readdirSync(dir).filter((f) => f.endsWith('.enc'))).toHaveLength(2);
  });

  it('refuses to copy a backup that is not encrypted, and says so', async () => {
    const { config, db, copies } = setup();
    const plain = { ...config, backupPassphrase: undefined };
    const made = await createBackup(db, plain);
    const outcome = await copyOffsite(db, { ...config, backupPassphrase: undefined }, 'asha', made.name);
    expect(outcome).toMatchObject({ ok: false, detail: expect.stringMatching(/not encrypted/) });
    expect(existsSync(join(copies, 'asha'))).toBe(false);
  });

  it('is done after each daily backup, with a check that it could be restored', async () => {
    const { config, db, copies } = setup();
    const logs: string[] = [];
    await tickBackup(db, config, (m) => logs.push(m), 'asha');
    expect(logs.some((l) => /Backup written/.test(l))).toBe(true);
    expect(readdirSync(join(copies, 'asha'))).toHaveLength(1);
    expect(offsiteState(db, config).verified).toMatchObject({ ok: true, detail: expect.stringMatching(/2\d accounts|\d+ accounts/) });
  });
});

describe('checking that a backup could be restored', () => {
  it('opens it in a scratch copy and checks it is whole and balanced', async () => {
    const { config, db } = setup();
    await createBackup(db, config);
    const outcome = await verifyBackup(db, config);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toMatch(/1 transactions, all balanced/);
  });

  it('fails clearly for a damaged or unreadable backup, and when there is none', async () => {
    const { config, db } = setup();
    expect((await verifyBackup(db, config)).detail).toMatch(/no backup/);
    const made = await createBackup(db, config);
    writeFileSync(join(backupsDir(config), made.name), 'not really a backup at all, just some bytes that are far too short');
    const outcome = await verifyBackup(db, config, made.name);
    expect(outcome.ok).toBe(false);
    expect(offsiteState(db, config).verified).toMatchObject({ ok: false });
  });
});
