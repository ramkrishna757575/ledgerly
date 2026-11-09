import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '@ledgerly/core';
import type { Config } from './config.ts';

async function sizeOf(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await sizeOf(full);
    else if (entry.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

const cache = new Map<string, { at: number; bytes: number }>();
const TTL_MS = 20_000;

// What this person's books take on disk: the database, statements, receipts and backups.
export async function storageUsed(config: Pick<Config, 'dataDir'>, fresh = false) {
  const hit = cache.get(config.dataDir);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.bytes;
  const bytes = await sizeOf(config.dataDir);
  cache.set(config.dataDir, { at: Date.now(), bytes });
  return bytes;
}

export const forgetUsage = (dataDir: string) => cache.delete(dataDir);

const mb = (bytes: number) => (bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0);

// Refuses what would not fit. On a site open to the public, each person has a
// fixed amount of space; the person running the server has none.
export async function assertRoom(config: Pick<Config, 'dataDir' | 'quotaBytes'>, incoming: number) {
  if (!config.quotaBytes) return;
  let used = await storageUsed(config);
  // A cached figure can be out of date after something was deleted, so measure again before refusing.
  if (used + incoming > config.quotaBytes) used = await storageUsed(config, true);
  if (used + incoming > config.quotaBytes) {
    throw new DomainError('invalid', `Your storage is full (${mb(used)} of ${mb(config.quotaBytes)} MB used). Delete old statements, receipts or backups, or close the account.`);
  }
  forgetUsage(config.dataDir);
}
