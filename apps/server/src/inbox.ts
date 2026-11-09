import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { commitReadyImports, getSetting, setSetting } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { Config } from './config.ts';
import { allChannels, deliver } from './notify.ts';
import { ingestStatement } from './ingest.ts';

export type InboxResult = { at: string; file: string; outcome: 'staged' | 'already' | 'held'; note?: string };
export type InboxState = { enabled: boolean; folder: string | null; lastScan: string | null; results: InboxResult[]; lastImport: { imported: number; held: number } | null };

const LOG_KEY = 'inbox.log';
const SETTLE_MS = 10_000;

const readLog = (db: Db): { lastScan: string | null; results: InboxResult[]; lastImport: InboxState['lastImport'] } => {
  try {
    return JSON.parse(getSetting(db, LOG_KEY) ?? '') as ReturnType<typeof readLog>;
  } catch {
    return { lastScan: null, results: [], lastImport: null };
  }
};

export function inboxState(db: Db, config: Config): InboxState {
  const log = readLog(db);
  return { enabled: Boolean(config.watchDir), folder: config.watchDir ?? null, lastScan: log.lastScan, results: log.results, lastImport: log.lastImport };
}

// Takes each statement dropped in the folder, files it away, and imports what
// is safe to import. Files it could not use go to "held", with the reason in
// the log, so nothing is lost and nothing is retried forever.
export async function scanInbox(db: Db, config: Config, fetcher: typeof fetch = fetch) {
  const folder = config.watchDir;
  if (!folder || !existsSync(folder)) return null;
  const processed = join(folder, 'processed');
  const held = join(folder, 'held');
  await mkdir(processed, { recursive: true });
  await mkdir(held, { recursive: true });

  const results: InboxResult[] = [];
  const at = new Date().toISOString();
  const move = async (name: string, to: string) => {
    let target = join(to, name);
    if (existsSync(target)) target = join(to, `${Date.now()}-${name}`);
    await rename(join(folder, name), target);
  };

  for (const entry of (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile())) {
    const name = entry.name;
    const ext = extname(name).toLowerCase();
    if (!['.pdf', '.csv', '.tsv', '.xlsx'].includes(ext)) continue;
    const path = join(folder, name);
    if (Date.now() - (await stat(path)).mtimeMs < SETTLE_MS) continue;

    const result = await ingestStatement(db, config, { name, buffer: await readFile(path), passwords: config.watchPasswords });
    results.push({ at, file: name, outcome: result.outcome, note: result.note });
    await move(name, result.outcome === 'held' ? held : processed);
  }

  let lastImport = readLog(db).lastImport;
  const staged = results.filter((r) => r.outcome === 'staged').length;
  if (staged > 0) {
    const done = commitReadyImports(db);
    lastImport = { imported: done.imported.length, held: done.held.length };
    if (allChannels(db, config).length > 0) {
      const lines = [`${done.imported.length} imported`, ...(done.held.length > 0 ? [`${done.held.length} need your review`] : []), ...results.filter((r) => r.outcome === 'held').map((r) => `${r.file}: ${r.note}`)];
      await deliver(db, allChannels(db, config), 'Ledgerly: statements imported', lines.join('\n'), lines, fetcher);
    }
  } else if (results.some((r) => r.outcome === 'held') && allChannels(db, config).length > 0) {
    const lines = results.filter((r) => r.outcome === 'held').map((r) => `${r.file}: ${r.note}`);
    await deliver(db, allChannels(db, config), 'Ledgerly: statements could not be read', lines.join('\n'), lines, fetcher);
  }

  const log = readLog(db);
  setSetting(db, LOG_KEY, JSON.stringify({ lastScan: at, results: [...results, ...log.results].slice(0, 30), lastImport }));
  return { results, lastImport };
}

export async function tickInbox(db: Db, config: Config, log: (message: string) => void) {
  if (config.demoMode || !config.watchDir) return;
  await scanInbox(db, config).catch((error) => log(`Inbox scan failed: ${error instanceof Error ? error.message : String(error)}`));
}
