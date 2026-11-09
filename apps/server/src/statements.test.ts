import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const local = { host: 'localhost:4310' };
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => close?.());

async function start(demo = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-bulk-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, DEMO_MODE: String(demo) }), webDir: '/nonexistent' };
  const db = openDb(config.dbPath);
  seedDefaults(db);
  const app = await buildApp(db, config);
  close = () => app.close();
  return app;
}

function upload(name: string, content: string) {
  const boundary = 'b';
  return {
    method: 'POST' as const,
    url: '/api/statements',
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    headers: { ...local, 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('bulk statement routes', () => {
  it('turns away files that are not PDFs and a PDF it cannot read', async () => {
    const app = await start();
    expect((await app.inject(upload('notes.bin', 'hello\u0000world'))).json().error).toMatch(/PDF statement, or a CSV/);
    expect((await app.inject(upload('notes.txt', 'hello'))).statusCode).toBe(400);
    const broken = await app.inject(upload('s.pdf', '%PDF-1.4 not really a pdf'));
    expect(broken.statusCode).toBe(400);
  });

  it('reads a CSV export of holdings, and keeps the file', async () => {
    const app = await start();
    const csv = 'Instrument,Qty.,Avg. cost,LTP,Cur. val\nSample Corp Ltd,10,1500.00,1650.50,16505.00\n';
    const res = await app.inject(upload('holdings.csv', csv));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'investment', filename: 'holdings.csv' });
    const ready = (await app.inject({ method: 'POST', url: '/api/statements/commit-ready', headers: local })).json();
    expect(ready.imported).toMatchObject([{ kind: 'investment' }]);
    expect((await app.inject({ url: '/api/investments', headers: local })).json().holdings[0].name).toBe('Sample Corp Ltd');
    expect((await app.inject(upload('holdings.csv', csv))).statusCode).toBe(409);
  });

  it('has nothing to import when nothing is waiting', async () => {
    const app = await start();
    const res = await app.inject({ method: 'POST', url: '/api/statements/commit-ready', headers: local });
    expect(res.json()).toEqual({ imported: [], held: [] });
  });

  it('is off in demo mode', async () => {
    const app = await start(true);
    expect((await app.inject(upload('s.pdf', '%PDF-1.4'))).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/statements/commit-ready', headers: local })).statusCode).toBe(400);
  });
});

describe('previewing an import', () => {
  it('works out what would happen without importing', async () => {
    const app = await start();
    const csv = 'Instrument,Qty.,Avg. cost,LTP,Cur. val\nSample Corp Ltd,10,1500.00,1650.50,16505.00\n';
    await app.inject(upload('holdings.csv', csv));
    const preview = (await app.inject({ method: 'POST', url: '/api/statements/preview-ready', headers: local })).json();
    expect(preview.imported).toMatchObject([{ kind: 'investment', holdings: 1 }]);
    expect((await app.inject({ url: '/api/investments', headers: local })).json().holdings).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/statements/commit-ready', headers: local })).json().imported).toHaveLength(1);
  });
});

describe('security headers', () => {
  it('are on every response, with the page allowed to run only its own scripts', async () => {
    const { createHash } = await import('node:crypto');
    const { writeFileSync } = await import('node:fs');
    const webDir = mkdtempSync(join(tmpdir(), 'ledgerly-web-'));
    const inline = "try { localStorage.getItem('x'); } catch (e) {}";
    writeFileSync(join(webDir, 'index.html'), `<!doctype html><title>app</title><script>${inline}</script><script type="module" src="/app.js"></script>`);
    const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-hdr-'));
    const config = { ...loadConfig({ DATA_DIR: dataDir, COOKIE_SECURE: 'true' }), webDir };
    const db = openDb(config.dbPath);
    seedDefaults(db);
    const app = await buildApp(db, config);
    close = () => app.close();

    const page = await app.inject({ url: '/', headers: local });
    const policy = String(page.headers['content-security-policy']);
    expect(policy).toContain(`'sha256-${createHash('sha256').update(inline).digest('base64')}'`);
    expect(policy).toMatch(/default-src 'self'/);
    expect(policy).toMatch(/frame-ancestors 'none'/);
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['strict-transport-security']).toMatch(/max-age=31536000/);

    const api = await app.inject({ url: '/api/health', headers: local });
    expect(api.headers['x-frame-options']).toBe('DENY');
  });
});
