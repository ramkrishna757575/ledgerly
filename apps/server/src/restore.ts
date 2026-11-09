import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openDb } from '@ledgerly/db';
import { decryptFile } from './crypt.ts';
import { sql } from 'drizzle-orm';

const run = promisify(execFile);

// Puts a backup back in place of the live data. The server must be stopped:
// swapping a database file under a running process would corrupt it. What was
// there is kept beside it, so a wrong restore can itself be reversed.
export async function restoreBackup(archive: string, dataDir: string, dbName = 'ledgerly.db', passphrase?: string) {
  if (!existsSync(archive)) throw new Error(`No such file: ${archive}`);
  await mkdir(dataDir, { recursive: true });
  const work = await mkdtemp(join(dataDir, '.restore-'));
  try {
    if (archive.endsWith('.enc')) {
      if (!passphrase) throw new Error('This backup is encrypted. Set BACKUP_PASSPHRASE to open it.');
      const plain = join(work, 'plain.tar.gz');
      await decryptFile(archive, plain, passphrase);
      archive = plain;
    }
    await run('tar', ['-xzf', archive, '-C', work, 'ledgerly.db']);
    try {
      await run('tar', ['-xzf', archive, '-C', work, 'documents']);
    } catch {
      // A backup taken before any statement was uploaded has no documents.
    }
    if (!existsSync(join(work, 'ledgerly.db'))) throw new Error('This is not a Ledgerly backup');

    const check = openDb(join(work, 'ledgerly.db'));
    const result = check.get<{ integrity_check: string }>(sql`PRAGMA integrity_check`);
    check.close();
    if (result?.integrity_check !== 'ok') throw new Error('The backup database is damaged');

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const live = join(dataDir, dbName);
    const kept: string[] = [];
    if (existsSync(live)) {
      await rename(live, `${live}.before-restore-${stamp}`);
      kept.push(`${live}.before-restore-${stamp}`);
    }
    for (const suffix of ['-wal', '-shm']) await rm(live + suffix, { force: true });
    await rename(join(work, 'ledgerly.db'), live);

    const docs = join(dataDir, 'documents');
    if (existsSync(join(work, 'documents'))) {
      if (existsSync(docs)) {
        await rename(docs, `${docs}.before-restore-${stamp}`);
        kept.push(`${docs}.before-restore-${stamp}`);
      }
      await cp(join(work, 'documents'), docs, { recursive: true });
    }
    return { restored: live, kept };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
