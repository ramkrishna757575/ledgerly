import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { decryptSecret, encryptSecret, initSecrets } from './secrets.ts';
import { Tenants } from './tenants.ts';

const local = { host: 'localhost:4310' };
let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => cleanup?.());
beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-secrets-'))));

async function model(content = 'OK') {
  const server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] })));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { base, stop: () => new Promise((r) => server.close(r)) };
}

async function solo() {
  const config = { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ledgerly-set-')) }), webDir: '/nonexistent' };
  const db = openDb(config.dbPath);
  const app = await buildApp(db, config);
  cleanup = () => app.close();
  return { app, db, config };
}

async function shared(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-shared-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password', ADMIN_USERNAME: 'asha', ...env }), webDir: '/nonexistent' };
  const tenants = new Tenants(config);
  await tenants.bootstrap('asha', 'admin-password');
  const app = await buildApp(openDb(':memory:'), config, { tenants });
  cleanup = async () => {
    await app.close();
    tenants.close();
  };
  const login = async (u: string, p: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username: u, password: p } })).headers['set-cookie']).split(';')[0]!;
  const asha = await login('asha', 'admin-password');
  await app.inject({ method: 'POST', url: '/api/users', headers: { ...local, cookie: asha }, payload: { username: 'ben', password: 'quiet-river-stone' } });
  const ben = await login('ben', 'quiet-river-stone');
  const as = (cookie: string) => ({ ...local, cookie });
  return { app, dataDir, asha, ben, as };
}

describe('secrets at rest', () => {
  it('encrypts, decrypts, and treats damage or another key as not set', () => {
    const sealed = encryptSecret('sk-very-secret');
    expect(sealed).toMatch(/^enc1:/);
    expect(sealed).not.toContain('sk-very-secret');
    expect(decryptSecret(sealed)).toBe('sk-very-secret');
    expect(encryptSecret('sk-very-secret')).not.toBe(sealed);
    expect(decryptSecret(sealed.slice(0, -4) + 'AAAA')).toBeUndefined();
    expect(decryptSecret('plain text')).toBeUndefined();
    expect(decryptSecret(undefined)).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), 'ledgerly-key-'));
    initSecrets(dir);
    expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
    expect(decryptSecret(sealed)).toBeUndefined(); // a different key
    initSecrets(dir, Buffer.alloc(32, 7).toString('base64'));
    expect(() => initSecrets(dir, 'too-short')).toThrow(/32 random bytes/);
  });
});

describe('your own AI provider', () => {
  it('is saved with the key kept secret, used straight away, tested and removed', async () => {
    initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-secrets-')));
    const fake = await model('OK');
    const { app, db } = await solo();
    expect((await app.inject({ url: '/api/ai/status', headers: local })).json().configured).toBe(false);

    const saved = await app.inject({ method: 'PUT', url: '/api/settings/ai', headers: local, payload: { provider: 'openai', model: 'llama3', baseUrl: fake.base, apiKey: 'sk-secret-key' } });
    expect(saved.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/ai/status', headers: local })).json()).toMatchObject({ configured: true, destination: { local: true } });

    const settings = await app.inject({ url: '/api/settings', headers: local });
    expect(settings.body).not.toContain('sk-secret-key');
    expect(settings.json().ai.own).toEqual({ provider: 'openai', model: 'llama3', baseUrl: fake.base, region: null, hasKey: true });
    expect(getSetting(db, 'cfg.ai')).not.toContain('sk-secret-key');

    const test = await app.inject({ method: 'POST', url: '/api/settings/ai/test', headers: local });
    expect(test.json()).toMatchObject({ ok: true, reply: 'OK' });

    // Editing without retyping the key keeps it.
    await app.inject({ method: 'PUT', url: '/api/settings/ai', headers: local, payload: { provider: 'openai', model: 'llama3.1', baseUrl: fake.base } });
    expect((await app.inject({ url: '/api/settings', headers: local })).json().ai.own).toMatchObject({ model: 'llama3.1', hasKey: true });

    expect((await app.inject({ method: 'DELETE', url: '/api/settings/ai', headers: local })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/ai/status', headers: local })).json().configured).toBe(false);
    await fake.stop();
  });

  it('is checked: a key is needed for Anthropic, an address for a model server', async () => {
    const { app } = await solo();
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings/ai', headers: local, payload });
    expect((await put({ provider: 'anthropic' })).statusCode).toBe(400);
    expect((await put({ provider: 'openai', model: 'm' })).statusCode).toBe(400);
    expect((await put({ provider: 'openai', model: 'm', baseUrl: 'ftp://x' })).statusCode).toBe(400);
    expect((await put({ provider: 'nope' })).statusCode).toBe(400);
    expect((await put({ provider: 'anthropic', apiKey: 'k' })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/settings', headers: local })).json().ai.own).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  });
});

describe('everyone\'s own settings on a shared server', () => {
  it('keep each person\'s key to themselves, and give the server\'s key to nobody by default', async () => {
    const { app, asha, ben, as } = await shared({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-server-key' });
    expect((await app.inject({ url: '/api/ai/status', headers: as(asha) })).json().configured).toBe(true);
    expect((await app.inject({ url: '/api/ai/status', headers: as(ben) })).json().configured).toBe(false);

    await app.inject({ method: 'PUT', url: '/api/settings/ai', headers: as(ben), payload: { provider: 'anthropic', apiKey: 'sk-ben-key' } });
    expect((await app.inject({ url: '/api/ai/status', headers: as(ben) })).json()).toMatchObject({ configured: true, destination: { host: 'api.anthropic.com' } });
    for (const cookie of [asha, ben]) expect((await app.inject({ url: '/api/settings', headers: as(cookie) })).body).not.toMatch(/sk-ben-key|sk-server-key/);
    expect((await app.inject({ url: '/api/settings', headers: as(asha) })).json().ai.own).toBeNull();
    expect((await app.inject({ url: '/api/settings', headers: as(ben) })).json().ai.own).toMatchObject({ hasKey: true });
  });

  it('cannot point the server at its own network, but the administrator can', async () => {
    const { app, asha, ben, as } = await shared();
    const ai = (cookie: string, baseUrl: string) => app.inject({ method: 'PUT', url: '/api/settings/ai', headers: as(cookie), payload: { provider: 'openai', model: 'm', baseUrl } });
    for (const url of ['https://localhost/v1', 'https://127.0.0.1/v1', 'https://192.168.1.5/v1', 'http://93.184.216.34/v1', 'https://169.254.169.254/v1']) expect((await ai(ben, url)).statusCode, url).toBe(400);
    expect((await ai(ben, 'https://93.184.216.34/v1')).statusCode).toBe(204);
    expect((await ai(asha, 'http://127.0.0.1:11434/v1')).statusCode).toBe(204);

    const mail = (cookie: string, host: string) => app.inject({ method: 'PUT', url: '/api/settings/mail', headers: as(cookie), payload: { host, user: 'u@x.com', password: 'p', senders: ['axisbank.com'] } });
    expect((await mail(ben, '10.0.0.8')).statusCode).toBe(400);
    expect((await mail(ben, 'localhost')).statusCode).toBe(400);
    expect((await mail(ben, '93.184.216.34')).statusCode).toBe(204);
    expect((await mail(asha, '10.0.0.8')).statusCode).toBe(204);
  });

  it('give each person their own mailbox, kept apart and with the password hidden', async () => {
    const { app, asha, ben, as } = await shared();
    await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: as(ben), payload: { host: '93.184.216.34', user: 'ben@example.com', password: 'ben-mail-password', senders: ['axisbank.com', 'Scripbox.com'] } });
    const benMail = (await app.inject({ url: '/api/mail', headers: as(ben) })).json();
    expect(benMail).toMatchObject({ enabled: true, mailbox: 'ben@example.com on 93.184.216.34', senders: ['axisbank.com', 'scripbox.com'] });
    expect(JSON.stringify(benMail)).not.toContain('ben-mail-password');
    expect((await app.inject({ url: '/api/mail', headers: as(asha) })).json().enabled).toBe(false);
    expect((await app.inject({ url: '/api/settings', headers: as(ben) })).json().mail.own).toMatchObject({ hasPassword: true, user: 'ben@example.com' });
    expect((await app.inject({ method: 'PUT', url: '/api/settings/mail', headers: as(ben), payload: { host: '93.184.216.34', user: 'x', password: 'p', senders: [] } })).statusCode).toBe(400);
  });

  it('give each person a statement folder of their own, which only reads their own files', async () => {
    const { app, dataDir, asha, ben, as } = await shared();
    expect((await app.inject({ url: '/api/settings', headers: as(ben) })).json().watch).toMatchObject({ enabled: false, own: false, folder: null });
    await app.inject({ method: 'PUT', url: '/api/settings/watch', headers: as(ben), payload: { enabled: true, passwords: ['p1', 'p2'] } });
    const watch = (await app.inject({ url: '/api/settings', headers: as(ben) })).json().watch;
    expect(watch).toMatchObject({ enabled: true, own: true, passwords: 2 });
    // It is a fixed place inside their own data folder: nobody chooses a path.
    expect(watch.folder).toBe(join(dataDir, 'users', '2', 'inbox'));
    expect((await app.inject({ url: '/api/settings', headers: as(asha) })).json().watch.enabled).toBe(false);

    mkdirSync(watch.folder, { recursive: true });
    const file = join(watch.folder, 'holdings.csv');
    writeFileSync(file, 'Instrument,Qty.,Avg. cost,LTP,Cur. val\nBen Corp Ltd,10,1500.00,1650.50,16505.00\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const scan = await app.inject({ method: 'POST', url: '/api/inbox/scan', headers: as(ben) });
    expect(scan.json().results).toMatchObject([{ file: 'holdings.csv', outcome: 'staged' }]);
    expect((await app.inject({ url: '/api/investments', headers: as(ben) })).json().holdings.map((h: { name: string }) => h.name)).toEqual(['Ben Corp Ltd']);
    expect((await app.inject({ url: '/api/investments', headers: as(asha) })).json().holdings).toEqual([]);
    expect(existsSync(join(watch.folder, 'processed', 'holdings.csv'))).toBe(true);
    void readFileSync;
  });
});

describe('how much space each person gets', () => {
  const png = (n: number, seed: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, seed)]);
  const upload = (url: string, content: Buffer, name = 'r.png') => {
    const boundary = 'b';
    return { method: 'POST' as const, url, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { ...local, 'content-type': `multipart/form-data; boundary=${boundary}` } };
  };

  it('is limited for everyone but the person running the server, and shown', async () => {
    const { app, asha, ben, as } = await shared({ USER_QUOTA_MB: '2' });
    const tx = async (cookie: string) => {
      const accounts = (await app.inject({ url: '/api/accounts', headers: as(cookie) })).json();
      const bank = (await app.inject({ method: 'POST', url: '/api/accounts', headers: as(cookie), payload: { name: 'Bank', type: 'asset', subtype: 'bank' } })).json();
      const food = accounts.find((a: { name: string }) => a.name === 'Groceries');
      return (await app.inject({ method: 'POST', url: '/api/transactions/simple', headers: as(cookie), payload: { date: '2026-10-01', description: 'x', kind: 'expense', accountId: bank.id, counterAccountId: food.id, amount: 100 } })).json().id as number;
    };
    const benTx = await tx(ben);
    const ashaTx = await tx(asha);

    expect((await app.inject(upload(`/api/transactions/${benTx}/attachments`, png(1_000_000, 1)))).statusCode).toBe(401); // not signed in
    const first = await app.inject({ ...upload(`/api/transactions/${benTx}/attachments`, png(1_000_000, 1)), headers: { ...upload('', Buffer.alloc(0)).headers, cookie: ben } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ ...upload(`/api/transactions/${benTx}/attachments`, png(1_000_000, 2)), headers: { ...upload('', Buffer.alloc(0)).headers, cookie: ben } });
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toMatch(/storage is full/i);

    const usage = (await app.inject({ url: '/api/settings', headers: as(ben) })).json().usage;
    expect(usage.quota).toBe(2_097_152);
    expect(usage.used).toBeGreaterThan(1_000_000);

    // The person running the server has no limit.
    for (const seed of [3, 4, 5]) {
      expect((await app.inject({ ...upload(`/api/transactions/${ashaTx}/attachments`, png(600_000, seed)), headers: { ...upload('', Buffer.alloc(0)).headers, cookie: asha } })).statusCode).toBe(201);
    }
    expect((await app.inject({ url: '/api/settings', headers: as(asha) })).json().usage.quota).toBeNull();

    // Deleting something makes room again.
    expect((await app.inject({ method: 'DELETE', url: `/api/attachments/${first.json().id}`, headers: as(ben) })).statusCode).toBe(204);
    const again = await app.inject({ ...upload(`/api/transactions/${benTx}/attachments`, png(1_000_000, 2)), headers: { ...upload('', Buffer.alloc(0)).headers, cookie: ben } });
    expect(again.statusCode).toBe(201);
  });
});
