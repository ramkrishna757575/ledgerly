import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHoldings, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { inboxState, scanInbox } from './inbox.ts';

const CSV = 'Instrument,Qty.,Avg. cost,LTP,Cur. val\nSample Corp Ltd,10,1500.00,1650.50,16505.00\n';

function setup(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ledgerly-inbox-'));
  const watch = join(root, 'inbox');
  const data = join(root, 'data');
  const config = loadConfig({ DATA_DIR: data, WATCH_DIR: watch, ...env });
  const db = openDb(config.dbPath);
  seedDefaults(db);
  return { config, db, watch };
}

function drop(dir: string, name: string, content: string | Buffer, ageSeconds = 60) {
  const path = join(dir, name);
  writeFileSync(path, content);
  const when = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(path, when, when);
}

const mkdir = (path: string) => spawnSync('mkdir', ['-p', path]);

describe('statement inbox folder', () => {
  it('imports what is dropped in, files it away, and leaves nothing to do the second time', async () => {
    const { config, db, watch } = setup();
    mkdir(watch);
    drop(watch, 'holdings.csv', CSV);
    const first = await scanInbox(db, config);
    expect(first!.results).toMatchObject([{ file: 'holdings.csv', outcome: 'staged' }]);
    expect(first!.lastImport).toEqual({ imported: 1, held: 0 });
    expect(getHoldings(db).holdings[0]!.name).toBe('Sample Corp Ltd');
    expect(readdirSync(watch).sort()).toEqual(['held', 'processed']);
    expect(readdirSync(join(watch, 'processed'))).toEqual(['holdings.csv']);

    // The same statement again, under another name, is recognised and not imported twice.
    drop(watch, 'copy-of-holdings.csv', CSV);
    expect((await scanInbox(db, config))!.results).toMatchObject([{ outcome: 'already' }]);
    expect(getHoldings(db).holdings).toHaveLength(1);
    expect((await scanInbox(db, config))!.results).toEqual([]);
  });

  it('holds back what it cannot read, with the reason, and ignores other files and unfinished ones', async () => {
    const { config, db, watch } = setup();
    mkdir(watch);
    drop(watch, 'broken.pdf', '%PDF-1.4 not really');
    drop(watch, 'notes.txt', 'hello');
    drop(watch, 'still-writing.csv', CSV, 1);
    const run = await scanInbox(db, config);
    expect(run!.results).toMatchObject([{ file: 'broken.pdf', outcome: 'held', note: expect.stringMatching(/could not be read/i) }]);
    expect(readdirSync(join(watch, 'held'))).toEqual(['broken.pdf']);
    expect(readdirSync(watch).sort()).toEqual(['held', 'notes.txt', 'processed', 'still-writing.csv']);
    // The file that did not become a statement is not kept in the data folder either.
    expect(existsSync(join(config.dataDir, 'documents')) ? readdirSync(join(config.dataDir, 'documents')) : []).toEqual([]);
    expect(inboxState(db, config)).toMatchObject({ enabled: true, results: [{ file: 'broken.pdf', outcome: 'held' }] });
  });

  const hasQpdf = spawnSync('qpdf', ['--version']).error === undefined;
  it.skipIf(!hasQpdf)('tries the configured passwords on a locked PDF, and says so when none work', async () => {
    const make = (dir: string, name: string, password: string) => {
      // qpdf here only opens files that end in .pdf.
      const src = join(dir, `${name}.plain.pdf`);
      writeFileSync(src, ['%PDF-1.4', '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj', '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj', '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj', 'trailer << /Root 1 0 R /Size 4 >>', '%%EOF'].join('\n'));
      spawnSync('qpdf', [src, '--encrypt', password, `${password}x`, '256', '--', join(dir, name)]);
      spawnSync('rm', [src]);
      const when = new Date(Date.now() - 60_000);
      utimesSync(join(dir, name), when, when);
    };
    const { config, db, watch } = setup({ WATCH_PASSWORDS: 'wrong,right-one' });
    mkdir(watch);
    make(watch, 'good.pdf', 'right-one');
    make(watch, 'bad.pdf', 'other-secret');
    const run = await scanInbox(db, config);
    const by = Object.fromEntries(run!.results.map((r) => [r.file, r]));
    // The right password opened it; a blank page is then just not a statement.
    expect(by['good.pdf']!.note).toMatch(/not supported/);
    expect(by['bad.pdf']!.note).toMatch(/None of the configured passwords/);
  });

  it('does nothing when no folder is set up', async () => {
    const { config, db } = setup({ WATCH_DIR: '' });
    expect(await scanInbox(db, config)).toBeNull();
    expect(inboxState(db, config).enabled).toBe(false);
  });
});
