import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { DomainError } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import { sql } from 'drizzle-orm';
import type { Config } from './config.ts';
import { encryptFile } from './crypt.ts';
import { assertRoom } from './quota.ts';
import { copyOffsite, verifyBackup } from './offsite.ts';

const run = promisify(execFile);
const NAME = /^ledgerly-\d{8}-\d{6}\.tar\.gz(\.enc)?$/;
export const BACKUP_KEEP = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export const backupsDir = (config: Config) => join(config.dataDir, 'backups');

function stamp(date = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export async function listBackups(config: Config) {
  const dir = backupsDir(config);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => NAME.test(f));
  const items = await Promise.all(
    files.map(async (name) => {
      const info = await stat(join(dir, name));
      return { name, size: info.size, createdAt: info.mtime.toISOString(), encrypted: name.endsWith('.enc') };
    }),
  );
  return items.sort((a, b) => b.name.localeCompare(a.name));
}

// The database is copied with VACUUM INTO, which gives one consistent file
// even while the app is writing. The uploaded statements travel with it, since
// the ledger refers to them.
export async function createBackup(db: Db, config: Config) {
  if (config.demoMode) throw new DomainError('invalid', 'Backups are turned off in demo mode.');
  await assertRoom(config, 0);
  const dir = backupsDir(config);
  await mkdir(dir, { recursive: true });

  const encrypt = Boolean(config.backupPassphrase);
  const name = `ledgerly-${stamp()}.tar.gz${encrypt ? '.enc' : ''}`;
  const work = join(dir, `.work-${process.pid}-${Date.now()}`);
  await mkdir(work);
  try {
    const snapshot = join(work, 'ledgerly.db');
    db.run(sql`VACUUM INTO ${snapshot}`);
    const docs = join(config.dataDir, 'documents');
    const plain = join(work, 'plain.tar.gz');
    const args = ['-czf', plain, '-C', work, 'ledgerly.db'];
    if (existsSync(docs)) {
      args.push('-C', config.dataDir, 'documents');
    }
    await run('tar', args);
    if (encrypt) await encryptFile(plain, join(work, name), config.backupPassphrase!);
    else await rename(plain, join(work, name));
    // Renamed only once complete, so a half-written file is never listed.
    await rename(join(work, name), join(dir, name));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  await pruneBackups(config);
  return (await listBackups(config)).find((b) => b.name === name)!;
}

export async function pruneBackups(config: Config, keep = config.backupKeep ?? BACKUP_KEEP) {
  for (const old of (await listBackups(config)).slice(keep)) {
    await rm(join(backupsDir(config), old.name), { force: true });
  }
}

export function backupPath(config: Config, name: string) {
  const safe = basename(name);
  if (safe !== name || !NAME.test(name)) throw new DomainError('invalid', 'Not a backup file');
  const path = join(backupsDir(config), name);
  if (!existsSync(path)) throw new DomainError('not_found', 'Backup not found');
  return path;
}

export async function deleteBackup(config: Config, name: string) {
  await rm(backupPath(config, name));
}

// Takes a backup at start-up and then daily, when the newest is over a day old.
export async function tickBackup(db: Db, config: Config, log: (message: string) => void, label = 'main') {
  if (config.demoMode) return;
  try {
    const [latest] = await listBackups(config);
    if (!latest || Date.now() - Date.parse(latest.createdAt) > DAY_MS) {
      const made = await createBackup(db, config);
      log(`Backup written: ${made.name}`);
      // Then the copy that leaves this machine, and a check that the backup could really be restored.
      const copied = await copyOffsite(db, config, label, made.name);
      if (copied && !copied.ok) log(`Backup copy failed: ${copied.detail}`);
      const checked = await verifyBackup(db, config, made.name);
      if (!checked.ok) log(`Backup check failed: ${checked.detail}`);
    }
  } catch (error) {
    log(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
