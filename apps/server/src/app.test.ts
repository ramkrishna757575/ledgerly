import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDemoData, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';

const base: Config = {
  ...loadConfig({}),
  webDir: '/nonexistent',
};

let app: FastifyInstance;

let db: ReturnType<typeof openDb>;

async function start(overrides: Partial<Config> = {}) {
  db = openDb(':memory:');
  seedDefaults(db);
  app = await buildApp(db, { ...base, ...overrides });
  return app;
}

const local = { host: 'localhost:4310' };

afterEach(() => app?.close());

describe('config', () => {
  it('refuses a network address without a password', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(/AUTH_PASSWORD/);
    expect(() => loadConfig({ HOST: '127.0.0.1', PUBLISH_ADDRESS: '0.0.0.0' })).toThrow();
  });

  it('allows a container that is only published on loopback', () => {
    expect(loadConfig({ HOST: '0.0.0.0', PUBLISH_ADDRESS: '127.0.0.1' }).host).toBe('0.0.0.0');
  });

  it('allows a network address with a password', () => {
    expect(loadConfig({ HOST: '0.0.0.0', AUTH_PASSWORD: 'secret' }).authPassword).toBe('secret');
  });
});

describe('api', () => {
  it('creates an account and reports net worth', async () => {
    await start();
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: local,
      payload: { name: 'Axis Savings', type: 'asset', subtype: 'bank', openingBalance: 150000 },
    });
    expect(created.statusCode).toBe(201);

    const report = await app.inject({ url: '/api/reports/net-worth', headers: local });
    expect(report.json()).toEqual({ assets: 150000, liabilities: 0, netWorth: 150000 });
  });

  it('wipes the books on request but only when the phrase is typed', async () => {
    await start();
    await app.inject({ method: 'POST', url: '/api/accounts', headers: local, payload: { name: 'Axis Savings', type: 'asset', subtype: 'bank', openingBalance: 150000 } });
    const refused = await app.inject({ method: 'POST', url: '/api/account/reset', headers: local, payload: { confirm: 'yes' } });
    expect(refused.statusCode).toBe(400);
    expect((await app.inject({ url: '/api/reports/net-worth', headers: local })).json().netWorth).toBe(150000);

    const done = await app.inject({ method: 'POST', url: '/api/account/reset', headers: local, payload: { confirm: 'DELETE EVERYTHING' } });
    expect(done.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/reports/net-worth', headers: local })).json().netWorth).toBe(0);
    const categories = (await app.inject({ url: '/api/accounts', headers: local })).json();
    expect(categories.some((a: { name: string }) => a.name === 'Groceries')).toBe(true);
    expect(categories.some((a: { name: string }) => a.name === 'Axis Savings')).toBe(false);
    // The record of which migrations ran must survive, or the next start cannot open the book.
    expect((db.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n).toBeGreaterThan(0);
  });

  it('downloads capital gains as a CSV, and refuses a year that is not one', async () => {
    await start();
    const ok = await app.inject({ url: '/api/export/capital-gains.csv?fy=2026-27', headers: local });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/csv/);
    expect(ok.body.split('\r\n')[0]).toMatch(/^Fund,ISIN/);
    expect((await app.inject({ url: '/api/export/capital-gains.csv?fy=soon', headers: local })).statusCode).toBe(400);
  });

  it('answers an unbalanced transaction with a 400', async () => {
    await start();
    const { id } = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: local,
        payload: { name: 'Bank', type: 'asset' },
      })
    ).json();
    const accounts = (await app.inject({ url: '/api/accounts', headers: local })).json();
    const rent = accounts.find((a: { name: string }) => a.name === 'Rent');

    const response = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: local,
      payload: {
        date: '2026-10-01',
        description: 'Rent',
        postings: [
          { accountId: id, amount: -100 },
          { accountId: rent.id, amount: 50 },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/sum to zero/);
  });

  it('returns validation and missing-record errors as JSON', async () => {
    await start();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: local,
      payload: { name: '' },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({ url: '/api/transactions/999', headers: local });
    expect(missing.statusCode).toBe(404);

    const unknown = await app.inject({ url: '/api/nope', headers: local });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('managing accounts', () => {
  it('edits, archives, restores and deletes through the API', async () => {
    await start();
    const created = (
      await app.inject({ method: 'POST', url: '/api/accounts', headers: local, payload: { name: 'Old name', type: 'asset' } })
    ).json();

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${created.id}`,
      headers: local,
      payload: { name: 'Axis Savings', numberLast4: '2345' },
    });
    expect(renamed.json()).toMatchObject({ name: 'Axis Savings', numberLast4: '2345' });

    const badDigits = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${created.id}`,
      headers: local,
      payload: { numberLast4: '12' },
    });
    expect(badDigits.statusCode).toBe(400);

    const archived = await app.inject({ method: 'POST', url: `/api/accounts/${created.id}/archive`, headers: local });
    expect(archived.json().isArchived).toBe(true);
    const restored = await app.inject({ method: 'POST', url: `/api/accounts/${created.id}/unarchive`, headers: local });
    expect(restored.json().isArchived).toBe(false);

    const removed = await app.inject({ method: 'DELETE', url: `/api/accounts/${created.id}`, headers: local });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/accounts/${created.id}`, headers: local })).statusCode).toBe(404);
  });

  it('refuses to delete an account with transactions', async () => {
    await start();
    const funded = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: local,
        payload: { name: 'Funded', type: 'asset', openingBalance: 1000 },
      })
    ).json();
    const response = await app.inject({ method: 'DELETE', url: `/api/accounts/${funded.id}`, headers: local });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Archive it/);
  });
});

describe('reports and categories', () => {
  const headers = { host: 'demo.example.com' };

  async function demo() {
    const db = openDb(':memory:');
    resetDemoData(db);
    app = await buildApp(db, { ...base, demoMode: true });
  }
  const get = async (url: string) => (await app.inject({ url, headers })).json();
  const range = 'from=2026-01-01&to=2026-12-31';

  it('answers every report for a date range', async () => {
    await demo();
    const summary = await get(`/api/reports/overview?${range}`);
    expect(summary.income).toBeGreaterThan(0);
    expect(summary.expenses).toBeGreaterThan(0);
    expect(summary.savingsRate).toBeGreaterThan(0);

    const categories = await get(`/api/reports/spending-by-category?${range}`);
    expect(categories[0].total).toBeGreaterThanOrEqual(categories.at(-1).total);

    const months = await get(`/api/reports/periods?${range}&period=month`);
    expect(months).toHaveLength(12);
    const years = await get(`/api/reports/periods?${range}&period=fy`);
    expect(years.map((y: { label: string }) => y.label)).toEqual(['FY 2025-26', 'FY 2026-27']);

    const trend = await get(`/api/reports/category-trend?${range}&period=month&top=3`);
    expect(trend.series).toHaveLength(3);
    expect(trend.periods).toHaveLength(12);

    expect((await get(`/api/reports/top-payees?${range}&limit=3`)).length).toBeLessThanOrEqual(3);

    const history = await get('/api/reports/net-worth-history?months=6');
    expect(history).toHaveLength(6);
    expect(history.at(-1).netWorth).toBeGreaterThan(0);
  });

  it('rejects a bad range or period', async () => {
    await demo();
    expect((await app.inject({ url: '/api/reports/overview?from=2026-02-30&to=2026-12-31', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/reports/overview', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/reports/periods?${range}&period=week`, headers })).statusCode).toBe(400);
  });

  it('changes the category of a transaction and offers to change similar ones', async () => {
    await demo();
    const accounts = await get('/api/accounts');
    const id = (name: string) => accounts.find((a: { name: string }) => a.name === name).id;
    const first = (await get('/api/transactions?search=BigBasket&limit=1')).items[0];

    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/transactions/${first.id}/category`,
      headers,
      payload: { categoryId: id('Health') },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().transaction.postings.map((p: { accountName: string }) => p.accountName)).toContain('Health');
    expect(typeof changed.json().similar).toBe('number');

    const similar = await app.inject({
      method: 'POST',
      url: `/api/transactions/${first.id}/category/similar`,
      headers,
      payload: { categoryId: id('Health') },
    });
    expect(similar.json()).toEqual({ updated: expect.any(Number) });

    const bad = await app.inject({ method: 'PATCH', url: `/api/transactions/${first.id}/category`, headers, payload: { categoryId: 0 } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('rules', () => {
  const headers = { host: 'demo.example.com' };

  it('previews, edits and applies a rule to what is already in the books', async () => {
    const db = openDb(':memory:');
    resetDemoData(db);
    app = await buildApp(db, { ...base, demoMode: true });
    const send = (method: 'POST' | 'PATCH', url: string, payload?: unknown) => app.inject({ method, url, headers, payload: payload as never });
    const accounts = (await app.inject({ url: '/api/accounts', headers })).json();
    const groceries = accounts.find((a: { name: string }) => a.name === 'Groceries').id;

    const preview = (await send('POST', '/api/rules/preview', { pattern: 'local vegetable' })).json();
    expect(preview.unsorted).toBeGreaterThan(0);
    expect((await send('POST', '/api/rules/preview', { pattern: '(abc', matchType: 'regex' })).statusCode).toBe(400);

    const rule = (await send('POST', '/api/rules', { pattern: 'local vegetable', categoryId: groceries })).json();
    const applied = (await send('POST', `/api/rules/${rule.id}/apply`)).json();
    expect(applied.updated).toBe(preview.unsorted);
    expect((await send('POST', `/api/rules/${rule.id}/apply`)).json()).toEqual({ updated: 0 });

    const edited = await send('PATCH', `/api/rules/${rule.id}`, { isActive: false, priority: 7 });
    expect(edited.json()).toMatchObject({ isActive: false, priority: 7 });
    expect((await send('POST', '/api/rules/apply')).json()).toEqual({ updated: 0 });
    expect((await send('PATCH', '/api/rules/9999', { priority: 1 })).statusCode).toBe(404);
  });
});

describe('insights and automatic rules', () => {
  const headers = { host: 'demo.example.com' };

  async function demo() {
    const db = openDb(':memory:');
    resetDemoData(db);
    app = await buildApp(db, { ...base, demoMode: true });
  }
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({ method, url, headers, payload: payload as never });

  it('finds a problem, fixes it on request, and lets you dismiss another', async () => {
    await demo();
    const accounts = (await call('GET', '/api/accounts')).json();
    const id = (name: string) => accounts.find((a: { name: string }) => a.name === name).id;
    const added = await call('POST', '/api/transactions/simple', {
      kind: 'expense', date: '2026-10-20', description: 'PPF/22497841/0040106404003', accountId: id('Demo Savings'), counterAccountId: id('Uncategorized'), amount: 850000,
    });
    expect(added.statusCode).toBe(201);

    const found = (await call('GET', '/api/insights')).json();
    const ppf = found.find((i: { key: string }) => i.key === 'investments:PPF');
    expect(ppf).toMatchObject({ severity: 'attention', action: { type: 'fix', label: 'Move to PPF' } });
    expect(found.some((i: { key: string }) => i.key === 'rules')).toBe(true);

    const fixed = await call('POST', '/api/insights/fix', { key: 'investments:PPF' });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().message).toMatch(/Moved 1 transaction to PPF/);
    expect((await call('GET', '/api/insights')).json().some((i: { key: string }) => i.key === 'investments:PPF')).toBe(false);
    expect((await call('POST', '/api/insights/fix', { key: 'investments:PPF' })).statusCode).toBe(404);

    expect((await call('POST', '/api/insights/dismiss', { key: 'rules' })).statusCode).toBe(204);
    expect((await call('GET', '/api/insights')).json().some((i: { key: string }) => i.key === 'rules')).toBe(false);
    expect((await call('POST', '/api/insights/fix', {})).statusCode).toBe(400);
  });

  it('keeps automatic rules off until asked, then creates them and says how many', async () => {
    await demo();
    expect((await call('GET', '/api/settings/auto-rules')).json()).toEqual({ mode: 'off' });
    expect((await call('PUT', '/api/settings/auto-rules', { mode: 'sometimes' })).statusCode).toBe(400);
    expect((await call('GET', '/api/rules')).json()).toEqual([]);

    const turnedOn = (await call('PUT', '/api/settings/auto-rules', { mode: 'create_and_apply' })).json();
    expect(turnedOn.mode).toBe('create_and_apply');
    expect(turnedOn.created).toBeGreaterThan(5);

    const rules = (await call('GET', '/api/rules')).json();
    expect(rules).toHaveLength(turnedOn.created);
    expect(rules.every((r: { createdBy: string }) => r.createdBy === 'auto')).toBe(true);
    expect((await call('GET', '/api/settings/auto-rules')).json()).toEqual({ mode: 'create_and_apply' });
  });

  it('reports what automatic rules did after you recategorise', async () => {
    await demo();
    await call('PUT', '/api/settings/auto-rules', { mode: 'create' });
    const first = (await call('GET', '/api/transactions?search=Local%20vegetable&limit=1')).json().items[0];
    const groceries = (await call('GET', '/api/accounts')).json().find((a: { name: string }) => a.name === 'Groceries').id;
    const changed = (await call('PATCH', `/api/transactions/${first.id}/category`, { categoryId: groceries })).json();
    expect(changed.autoRules).toEqual({ created: expect.any(Number), sorted: 0 });
  });
});

describe('investments', () => {
  const headers = { host: 'demo.example.com' };
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers, payload: payload as never });

  async function demo() {
    const db = openDb(':memory:');
    resetDemoData(db);
    app = await buildApp(db, { ...base, demoMode: true });
  }

  it('imports a sample statement in demo mode, shows the holdings, and can undo it', async () => {
    await demo();
    expect((await call('GET', '/api/demo/investment-samples')).json().map((s: { id: string }) => s.id)).toEqual(['cdsl', 'scripbox']);
    expect((await call('GET', '/api/investments')).json().holdings).toEqual([]);

    const staged = await call('POST', '/api/demo/investment-samples/cdsl');
    expect(staged.statusCode).toBe(201);
    expect(staged.json()).toMatchObject({ status: 'staged', total: 17733250, warnings: [] });
    expect((await call('POST', '/api/demo/investment-samples/cdsl')).statusCode).toBe(409);

    const before = (await call('GET', '/api/reports/net-worth')).json().netWorth;
    const committed = await call('POST', `/api/investments/imports/${staged.json().id}/commit`, {});
    expect(committed.json().status).toBe('committed');

    const { holdings, summary, allocation } = (await call('GET', '/api/investments')).json();
    expect(holdings).toHaveLength(3);
    expect(summary).toMatchObject({ value: 17733250, invested: 15600000, complete: true });
    expect(allocation.length).toBeGreaterThan(1);
    // The demo's own investment account sits at market value on the statement date.
    const onThatDate = (await call('GET', '/api/accounts?asOf=2026-09-30')).json().find((a: { name: string }) => a.name === 'Mutual Funds');
    expect(onThatDate.balance).toBe(17733250);
    expect((await call('GET', '/api/reports/net-worth')).json().netWorth).not.toBe(before);

    const undone = await call('POST', `/api/investments/imports/${staged.json().id}/undo`);
    expect(undone.json().status).toBe('undone');
    expect((await call('GET', '/api/investments')).json().holdings).toEqual([]);
    expect((await call('GET', '/api/reports/net-worth')).json().netWorth).toBe(before);
  });

  it('can throw away a statement it has not imported', async () => {
    await demo();
    const staged = (await call('POST', '/api/demo/investment-samples/scripbox')).json();
    expect((await call('DELETE', `/api/investments/imports/${staged.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/api/investments/imports')).json()).toEqual([]);
    expect((await call('GET', '/api/investments/imports/9999')).statusCode).toBe(404);
  });

  it('turns off uploads and live prices in demo mode', async () => {
    await demo();
    const upload = await app.inject({ method: 'POST', url: '/api/investments/imports', ...multipartBody('a.pdf', '%PDF-1.4'), headers: { ...multipartBody('a.pdf', '%PDF-1.4').headers, host: 'demo.example.com' } });
    expect(upload.statusCode).toBe(400);
    expect(upload.json().error).toMatch(/demo mode/);
    expect((await call('POST', '/api/investments/prices')).statusCode).toBe(400);
  });

  it('rejects an upload that is neither a statement nor a holdings export', async () => {
    await start();
    const response = await app.inject({ method: 'POST', url: '/api/investments/imports', ...multipartBody('notes.txt', 'hello') });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/not an investment statement/);
    const binary = await app.inject({ method: 'POST', url: '/api/investments/imports', ...multipartBody('notes.bin', 'a\u0000b') });
    expect(binary.json().error).toMatch(/PDF statement, or a CSV/);
  });

  it('updates prices from the daily file, and says so plainly when it cannot reach it', async () => {
    const { createServer } = await import('node:http');
    const { commitInvestmentImport, stageInvestmentStatement, getInvestmentSample } = await import('@ledgerly/core');
    const db = openDb(':memory:');
    seedDefaults(db);
    const sample = getInvestmentSample('cdsl')!;
    commitInvestmentImport(db, stageInvestmentStatement(db, sample).id);
    const config = { ...base, webDir: '/nonexistent' };
    app = await buildApp(db, config);

    const prices = createServer((_request, response) => {
      response.end('111111;INF000D01AA1;-;Demo Liquid Fund;Regular Plan;Growth Option;105.0000;10-Nov-2026\n');
    });
    await new Promise<void>((resolve) => prices.listen(0, '127.0.0.1', resolve));
    const address = prices.address();
    try {
      config.amfiUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
      const updated = await app.inject({ method: 'POST', url: '/api/investments/prices', headers: local });
      expect(updated.json()).toEqual({ updated: 1, skipped: 0, asOf: '2026-11-10' });
      const holding = (await app.inject({ url: '/api/investments', headers: local })).json().holdings.find((h: { name: string }) => h.name.includes('Liquid'));
      expect(holding).toMatchObject({ value: 1575000, source: 'amfi' });

      // Settings are worked out once per person, so the unreachable address is a fresh server.
      await app.close();
      app = await buildApp(db, { ...config, amfiUrl: 'http://127.0.0.1:1/' });
      const failed = await app.inject({ method: 'POST', url: '/api/investments/prices', headers: local });
      expect(failed.statusCode).toBe(400);
      expect(failed.json().error).toMatch(/reach AMFI/);
    } finally {
      await new Promise((resolve) => prices.close(resolve));
    }
  });
});

describe('serving the web app', () => {
  it('serves files added after start, falls back to the app for pages and 404s missing files', async () => {
    const webDir = mkdtempSync(join(tmpdir(), 'ledgerly-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>app</title>');
    await start({ webDir });

    // A rebuild while the server runs adds new hashed files.
    mkdirSync(join(webDir, 'assets'));
    writeFileSync(join(webDir, 'assets', 'index-new.js'), 'export {}');

    const script = await app.inject({ url: '/assets/index-new.js', headers: local });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);

    const page = await app.inject({ url: '/import', headers: local });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/html/);

    const missing = await app.inject({ url: '/assets/index-old.js', headers: local });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toMatch(/json/);
  });
});

describe('request guards', () => {
  it('blocks unknown hostnames when login is off', async () => {
    await start();
    const response = await app.inject({
      url: '/api/accounts',
      headers: { host: 'evil.example:4310' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('blocks cross-origin writes', async () => {
    await start();
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/1/archive',
      headers: { ...local, origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('demo mode', () => {
  it('may be exposed without a login and uses its own database file', () => {
    const config = loadConfig({ DEMO_MODE: 'true', HOST: '0.0.0.0', DATA_DIR: '/data' });
    expect(config.demoMode).toBe(true);
    expect(config.dbPath).toBe('/data/demo.db');
    expect(loadConfig({ DATA_DIR: '/data' }).dbPath).toBe('/data/ledgerly.db');
  });

  it('resets its sample data and serves any hostname', async () => {
    const db = openDb(':memory:');
    resetDemoData(db);
    app = await buildApp(db, { ...base, demoMode: true });
    const headers = { host: 'demo.example.com' };

    expect((await app.inject({ url: '/api/auth/status', headers })).json().demo).toBe(true);
    const before = (await app.inject({ url: '/api/reports/net-worth', headers })).json();
    expect(before.netWorth).toBeGreaterThan(0);

    const archive = await app.inject({
      method: 'DELETE',
      url: '/api/transactions/1',
      headers,
    });
    expect(archive.statusCode).toBe(204);

    const reset = await app.inject({ method: 'POST', url: '/api/demo/reset', headers });
    expect(reset.statusCode).toBe(200);
    const after = (await app.inject({ url: '/api/reports/net-worth', headers })).json();
    expect(after).toEqual(before);
  });

  it('has no reset route in normal mode', async () => {
    await start();
    const response = await app.inject({ method: 'POST', url: '/api/demo/reset', headers: local });
    expect(response.statusCode).toBe(404);
  });
});

function multipartBody(filename: string, content: string) {
  const boundary = 'testboundary';
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return { payload: body, headers: { ...local, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('importing statements', () => {
  it('rejects a missing or non-PDF upload', async () => {
    await start();
    const notPdf = await app.inject({ method: 'POST', url: '/api/imports', ...multipartBody('notes.txt', 'hello') });
    expect(notPdf.statusCode).toBe(400);
    expect(notPdf.json().error).toMatch(/not supported/);
    const binary = await app.inject({ method: 'POST', url: '/api/imports', ...multipartBody('notes.bin', 'a\u0000b') });
    expect(binary.json().error).toMatch(/PDF statement or a CSV/);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/imports',
      headers: { ...local, 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x--\r\n',
    });
    expect(empty.statusCode).toBe(400);
  });

  it('refuses uploads in demo mode but runs the sample statements end to end', async () => {
    const db = openDb(':memory:');
    resetDemoData(db);
    app = await buildApp(db, { ...base, demoMode: true });
    const headers = { host: 'demo.example.com' };

    const upload = await app.inject({ method: 'POST', url: '/api/imports', ...multipartBody('a.pdf', '%PDF-1.4'), headers: { ...multipartBody('a.pdf', '%PDF-1.4').headers, host: 'demo.example.com' } });
    expect(upload.statusCode).toBe(400);
    expect(upload.json().error).toMatch(/demo mode/);

    const samples = (await app.inject({ url: '/api/demo/samples', headers })).json();
    expect(samples.map((s: { id: string }) => s.id)).toEqual(['bank', 'card']);

    const staged = await app.inject({ method: 'POST', url: '/api/demo/samples/bank', headers });
    expect(staged.statusCode).toBe(201);
    const batch = staged.json();
    expect(batch).toMatchObject({ status: 'staged', accountName: 'Demo Savings', reconciliation: 'ok' });

    const again = await app.inject({ method: 'POST', url: '/api/demo/samples/bank', headers });
    expect(again.statusCode).toBe(409);

    const before = (await app.inject({ url: '/api/transactions?limit=1', headers })).json().total;
    const committed = await app.inject({ method: 'POST', url: `/api/imports/${batch.id}/commit`, headers });
    expect(committed.json().status).toBe('committed');
    const after = (await app.inject({ url: '/api/transactions?limit=1', headers })).json().total;
    expect(after).toBe(before + 7);

    const undone = await app.inject({ method: 'POST', url: `/api/imports/${batch.id}/undo`, headers });
    expect(undone.json().status).toBe('undone');
    expect((await app.inject({ url: '/api/transactions?limit=1', headers })).json().total).toBe(before);
  });

  it('has no sample routes outside demo mode', async () => {
    await start();
    expect((await app.inject({ url: '/api/demo/samples', headers: local })).statusCode).toBe(404);
  });

  it('manages rules', async () => {
    await start();
    const accounts = (await app.inject({ url: '/api/accounts', headers: local })).json();
    const groceries = accounts.find((a: { name: string }) => a.name === 'Groceries');

    const created = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: local,
      payload: { pattern: 'big basket', categoryId: groceries.id },
    });
    expect(created.statusCode).toBe(201);

    const list = (await app.inject({ url: '/api/rules', headers: local })).json();
    expect(list).toHaveLength(1);
    expect(list[0].categoryName).toBe('Groceries');

    const removed = await app.inject({ method: 'DELETE', url: `/api/rules/${created.json().id}`, headers: local });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/rules', headers: local })).json()).toEqual([]);
  });
});

describe('login', () => {
  const login = (password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: local,
      payload: { password },
    });

  it('protects the API until the right password is given', async () => {
    await start({ authPassword: 'correct horse' });

    expect((await app.inject({ url: '/api/accounts', headers: local })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/accounts?x=1', headers: local })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/health', headers: local })).statusCode).toBe(200);
    expect((await login('wrong')).statusCode).toBe(401);

    const success = await login('correct horse');
    expect(success.statusCode).toBe(200);
    const cookie = success.cookies[0]!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');

    const headers = { ...local, cookie: `${cookie.name}=${cookie.value}` };
    expect((await app.inject({ url: '/api/accounts', headers })).statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect((await app.inject({ url: '/api/accounts', headers })).statusCode).toBe(401);
  });

  it('slows down repeated guesses', async () => {
    await start({ authPassword: 'correct horse' });
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      last = (await login('wrong')).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('the tax pack', () => {
  it('downloads as a workbook with a sheet for each part, and refuses a year that is not one', async () => {
    await start();
    const ok = await app.inject({ url: '/api/export/tax-pack.xlsx?fy=2026-27', headers: local });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/spreadsheetml/);
    // An .xlsx is a zip archive.
    expect(ok.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await app.inject({ url: '/api/export/tax-pack.xlsx?fy=soon', headers: local })).statusCode).toBe(400);
  });
});
