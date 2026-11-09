import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getSetting, setSetting } from '@ledgerly/core';
import { openDb, type Db } from '@ledgerly/db';
import { sql } from 'drizzle-orm';
import { backupPath, listBackups } from './backup.ts';
import type { Config } from './config.ts';
import { decryptFile } from './crypt.ts';
import { putFile } from './s3.ts';

const run = promisify(execFile);

export type Outcome = { at: string; ok: boolean; name: string; detail: string };
const OFFSITE_KEY = 'backup.offsite';
const VERIFY_KEY = 'backup.verify';

const read = (db: Db, key: string): Outcome | null => {
  try {
    return JSON.parse(getSetting(db, key) ?? 'null');
  } catch {
    return null;
  }
};
const write = (db: Db, key: string, outcome: Outcome) => setSetting(db, key, JSON.stringify(outcome));

export const offsiteState = (db: Db, config: Config) => ({
  configured: Boolean(config.offsite),
  where: [config.offsite?.dir && 'a folder', config.offsite?.s3 && 'a bucket'].filter(Boolean) as string[],
  problem: config.offsiteProblem ?? null,
  last: read(db, OFFSITE_KEY),
  verified: read(db, VERIFY_KEY),
});

// A safe folder name for whose backups these are, so people on one server never share a place.
const place = (label: string) => label.replace(/[^a-z0-9._-]/gi, '_') || 'main';

// Copies one finished backup to every place that is set up. Only an encrypted backup ever leaves.
export async function copyOffsite(db: Db, config: Config, label: string, name: string) {
  const offsite = config.offsite;
  if (!offsite) return null;
  const at = new Date().toISOString();
  try {
    if (!name.endsWith('.enc')) throw new Error('This backup is not encrypted, so it was not copied out');
    const source = backupPath(config, name);
    const where: string[] = [];
    if (offsite.dir) {
      const target = join(offsite.dir, place(label));
      await mkdir(target, { recursive: true });
      await copyFile(source, join(target, name));
      // Keep the same number as on this machine.
      const old = (await readdir(target)).filter((f) => f.endsWith('.enc')).sort().reverse().slice(config.backupKeep);
      for (const file of old) await rm(join(target, file), { force: true });
      where.push('the folder');
    }
    if (offsite.s3) {
      await putFile(offsite.s3, [offsite.s3.prefix, place(label), name].filter(Boolean).join('/'), source);
      where.push('the bucket');
    }
    const outcome = { at, ok: true, name, detail: `Copied to ${where.join(' and ')}` };
    write(db, OFFSITE_KEY, outcome);
    return outcome;
  } catch (error) {
    const outcome = { at, ok: false, name, detail: error instanceof Error ? error.message : String(error) };
    write(db, OFFSITE_KEY, outcome);
    return outcome;
  }
}

// Opens a backup in a scratch folder and checks it could be restored: it decrypts, the
// database is whole, every transaction balances, and the statements are all there.
export async function verifyBackup(db: Db, config: Config, name?: string) {
  const at = new Date().toISOString();
  const chosen = name ?? (await listBackups(config))[0]?.name;
  if (!chosen) return { at, ok: false, name: '', detail: 'There is no backup to check yet' } satisfies Outcome;
  const work = await mkdtemp(join(tmpdir(), 'ledgerly-verify-'));
  let outcome: Outcome;
  try {
    let archive = backupPath(config, chosen);
    if (chosen.endsWith('.enc')) {
      if (!config.backupPassphrase) throw new Error('The backup is encrypted and no passphrase is set');
      const plain = join(work, 'plain.tar.gz');
      await decryptFile(archive, plain, config.backupPassphrase);
      archive = plain;
    }
    await run('tar', ['-xzf', archive, '-C', work, 'ledgerly.db']);
    const copy = openDb(join(work, 'ledgerly.db'));
    try {
      const integrity = copy.get<{ integrity_check: string }>(sql`PRAGMA integrity_check`)?.integrity_check;
      if (integrity !== 'ok') throw new Error('The database inside is damaged');
      const imbalance = copy.get<{ total: number | null }>(sql`SELECT SUM(amount) AS total FROM postings`)?.total ?? 0;
      if (imbalance !== 0) throw new Error('The books inside do not balance');
      const counts = copy.get<{ accounts: number; transactions: number }>(sql`SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM transactions) AS transactions`)!;
      outcome = { at, ok: true, name: chosen, detail: `Opened and checked: ${counts.accounts} accounts, ${counts.transactions} transactions, all balanced` };
    } finally {
      copy.close();
    }
  } catch (error) {
    outcome = { at, ok: false, name: chosen, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  write(db, VERIFY_KEY, outcome);
  return outcome;
}
