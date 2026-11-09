import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccount, createSimpleTransaction, ensureStarterCategories, listAccounts, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const local = { host: 'localhost:4310' };
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => close?.());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')]);

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-attach-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir }), webDir: '/nonexistent' };
  const db = openDb(config.dbPath);
  seedDefaults(db);
  ensureStarterCategories(db);
  const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' });
  const tx = createSimpleTransaction(db, { date: '2026-10-01', description: 'Washing machine', kind: 'expense', accountId: bank.id, counterAccountId: listAccounts(db).find((a) => a.name === 'Shopping')!.id, amount: 30_000_00 } as never);
  const app = await buildApp(db, config);
  close = () => app.close();
  return { app, db, dataDir, txId: (tx as { id: number }).id };
}

function upload(url: string, name: string, content: Buffer) {
  const boundary = 'b';
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { method: 'POST' as const, url, payload, headers: { ...local, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('attachments', () => {
  it('keeps a receipt with a transaction, serves it safely, and removes it', async () => {
    const { app, dataDir, txId } = await setup();
    const added = await app.inject(upload(`/api/transactions/${txId}/attachments`, '../warranty.png', PNG));
    expect(added.statusCode).toBe(201);
    const item = added.json();
    expect(item).toMatchObject({ filename: 'warranty.png', mimeType: 'image/png', size: PNG.length });

    const list = (await app.inject({ url: `/api/transactions/${txId}/attachments`, headers: local })).json();
    expect(list).toHaveLength(1);
    expect((await app.inject({ url: '/api/transactions', headers: local })).json().items[0].attachments).toBe(1);

    const file = await app.inject({ url: item.url, headers: local });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain("default-src 'none'");

    expect((await app.inject(upload(`/api/transactions/${txId}/attachments`, 'again.png', PNG))).statusCode).toBe(409);
    const stored = join(dataDir, 'documents');
    expect(existsSync(stored)).toBe(true);

    expect((await app.inject({ method: 'DELETE', url: `/api/attachments/${item.id}`, headers: local })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/transactions/${txId}/attachments`, headers: local })).json()).toEqual([]);
    expect((await app.inject({ url: item.url, headers: local })).statusCode).toBe(404);
  });

  it('judges a file by its contents, not its name', async () => {
    const { app, txId } = await setup();
    const fake = await app.inject(upload(`/api/transactions/${txId}/attachments`, 'invoice.pdf', Buffer.from('<script>alert(1)</script>')));
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error).toMatch(/PDF, PNG, JPEG or WebP/);
    expect((await app.inject(upload('/api/transactions/9999/attachments', 'a.png', PNG))).statusCode).toBe(404);
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    expect((await app.inject(upload(`/api/transactions/${txId}/attachments`, 'big.png', big))).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('is gone with the transaction, file and all', async () => {
    const { app, txId, dataDir } = await setup();
    await app.inject(upload(`/api/transactions/${txId}/attachments`, 'a.png', PNG));
    expect((await app.inject({ method: 'DELETE', url: `/api/transactions/${txId}`, headers: local })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/transactions/${txId}/attachments`, headers: local })).json()).toEqual([]);
    expect(readdirSync(join(dataDir, 'documents'))).toEqual([]);
  });
});

describe('reading a receipt with a model', () => {
  it('reads a picture and says whether it matches, and refuses without a provider or for a PDF', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '{"vendor":"Shop","date":"2026-10-01","total":300,"currency":"INR","confidence":0.8}' } }] })));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-receipt-'));
      const config = { ...loadConfig({ DATA_DIR: dataDir, AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_BASE_URL: `http://127.0.0.1:${port}/v1` }), webDir: '/nonexistent' };
      const db = openDb(config.dbPath);
      seedDefaults(db);
      ensureStarterCategories(db);
      const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' });
      const tx = createSimpleTransaction(db, { date: '2026-10-01', description: 'Shop', kind: 'expense', accountId: bank.id, counterAccountId: listAccounts(db).find((a) => a.name === 'Shopping')!.id, amount: 300_00 } as never) as { id: number };
      const app = await buildApp(db, config);
      close = () => app.close();

      const up = (await app.inject(upload(`/api/transactions/${tx.id}/attachments`, 'r.png', PNG))).json();
      const result = (await app.inject({ method: 'POST', url: `/api/attachments/${up.id}/read`, headers: local })).json();
      expect(result.comparison).toEqual({ amount: true, amountDifference: 0, date: true, vendor: true });
      expect(result.destination.local).toBe(true);
      // Nothing about the transaction changed.
      expect((await app.inject({ url: '/api/transactions', headers: local })).json().items[0].postings.some((p: { amount: number }) => Math.abs(p.amount) === 300_00)).toBe(true);
      expect((await app.inject({ url: '/api/ai/status', headers: local })).json()).toMatchObject({ configured: true });

      // A PDF is kept with the transaction but cannot be read this way.
      const pdf = (await app.inject(upload(`/api/transactions/${tx.id}/attachments`, 'r.pdf', Buffer.from('%PDF-1.4 receipt')))).json();
      expect((await app.inject({ method: 'POST', url: `/api/attachments/${pdf.id}/read`, headers: local })).json().error).toMatch(/Only a picture/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('refuses with no provider set up', async () => {
    const { app, txId } = await setup();
    const up = (await app.inject(upload(`/api/transactions/${txId}/attachments`, 'r.png', PNG))).json();
    const res = await app.inject({ method: 'POST', url: `/api/attachments/${up.id}/read`, headers: local });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/No AI provider/);
  });
});
