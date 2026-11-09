import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeInsights, createAccount, createSimpleTransaction, ensureStarterCategories, listAccounts, pendingAlerts, seedDefaults, setAlertKinds, setBudget } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { initSecrets } from './secrets.ts';
import { beforeAll } from 'vitest';
import { loadChannels, sendPendingAlerts } from './notify.ts';

const local = { host: 'localhost:4310' };
beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-alert-secrets-'))));
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => close?.());

function books() {
  const db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 10_00_000_00, openingDate: '2026-01-01' });
  const groceries = listAccounts(db).find((a) => a.name === 'Groceries')!;
  // A budget already blown this month gives something worth a message.
  setBudget(db, { categoryId: groceries.id, amount: 1_000_00 });
  createSimpleTransaction(db, { date: new Date().toISOString().slice(0, 10), description: 'Big shop', kind: 'expense', accountId: bank.id, counterAccountId: groceries.id, amount: 5_000_00 } as never);
  return db;
}

type Call = { url: string; init: RequestInit };
const recorder = (fail = false) => {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('', { status: fail ? 500 : 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

describe('channels', () => {
  it('are set up from the environment, one per kind', () => {
    expect(loadChannels({})).toEqual([]);
    expect(loadChannels({ NOTIFY_NTFY_URL: 'https://ntfy.sh/mine', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', NOTIFY_WEBHOOK_URL: 'https://hooks.example/x' }).map((c) => c.id)).toEqual(['ntfy', 'telegram', 'webhook']);
    expect(loadChannels({ TELEGRAM_BOT_TOKEN: 't' })).toEqual([]);
  });
});

describe('sending alerts', () => {
  it('sends a new finding once, to every channel, in the right shape for each', async () => {
    const db = books();
    const channels = loadChannels({ NOTIFY_NTFY_URL: 'https://ntfy.sh/mine', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '42', NOTIFY_WEBHOOK_URL: 'https://hooks.example/x' });
    const { calls, fetcher } = recorder();

    const first = await sendPendingAlerts(db, channels, fetcher);
    expect(first).toMatchObject({ ok: true, channels: ['ntfy', 'Telegram', 'Webhook'] });
    expect(first!.titles.some((t) => /budget/.test(t))).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(['https://ntfy.sh/mine', 'https://api.telegram.org/bottok/sendMessage', 'https://hooks.example/x']);
    expect((calls[0]!.init.headers as Record<string, string>).Title).toMatch(/Ledgerly/);
    expect(JSON.parse(calls[1]!.init.body as string)).toMatchObject({ chat_id: '42' });
    expect(JSON.parse(calls[2]!.init.body as string)).toHaveProperty('text');

    // The same findings are not sent again.
    expect(await sendPendingAlerts(db, channels, fetcher)).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('tries again later when every channel failed, but not when one succeeded', async () => {
    const db = books();
    const [ntfy, hook] = loadChannels({ NOTIFY_NTFY_URL: 'https://ntfy.sh/mine', NOTIFY_WEBHOOK_URL: 'https://hooks.example/x' });
    const down = recorder(true);
    expect((await sendPendingAlerts(db, [ntfy!], down.fetcher))!.ok).toBe(false);
    expect(await sendPendingAlerts(db, [ntfy!], recorder().fetcher)).toMatchObject({ ok: true });

    const db2 = books();
    const mixed = (async (url: string) => new Response('', { status: url.includes('ntfy') ? 500 : 200 })) as unknown as typeof fetch;
    const partial = await sendPendingAlerts(db2, [ntfy!, hook!], mixed);
    expect(partial).toMatchObject({ ok: false, error: expect.stringContaining('ntfy') });
    expect(await sendPendingAlerts(db2, [ntfy!, hook!], recorder().fetcher)).toBeNull();
  });

  it('respects the kinds you turned off, and does nothing without a channel', async () => {
    const db = books();
    const { fetcher, calls } = recorder();
    const channels = loadChannels({ NOTIFY_NTFY_URL: 'https://ntfy.sh/mine' });
    setAlertKinds(db, ['bills']);
    expect(await sendPendingAlerts(db, channels, fetcher)).toBeNull();
    expect(await sendPendingAlerts(books(), [], fetcher)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('which findings are worth a message', () => {
  it('leaves out a balance that is merely below zero', async () => {
    const db = openDb(':memory:');
    seedDefaults(db);
    ensureStarterCategories(db);
    const bank = createAccount(db, { name: 'Overdrawn', type: 'asset', subtype: 'bank' });
    createSimpleTransaction(db, { date: '2026-10-01', description: 'x', kind: 'expense', accountId: bank.id, counterAccountId: listAccounts(db).find((a) => a.name === 'Groceries')!.id, amount: 5_000_00 } as never);
    expect(computeInsights(db).some((i) => i.kind === 'balance')).toBe(true);
    expect(pendingAlerts(db).some((i) => i.kind === 'balance')).toBe(false);
  });
});

describe('alert routes', () => {
  it('shows where messages go without exposing addresses or tokens, and saves the kinds', async () => {
    const config = { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ledgerly-alerts-')), NOTIFY_NTFY_URL: 'https://ntfy.sh/secret-topic', TELEGRAM_BOT_TOKEN: 'super-secret-token', TELEGRAM_CHAT_ID: '7' }), webDir: '/nonexistent' };
    const app = await buildApp(books(), config);
    close = () => app.close();

    const res = await app.inject({ url: '/api/alerts', headers: local });
    expect(res.body).not.toMatch(/secret-topic|super-secret-token/);
    expect(res.json().channels).toEqual([{ id: 'ntfy', label: 'ntfy', host: 'ntfy.sh' }, { id: 'telegram', label: 'Telegram', host: 'api.telegram.org' }]);
    expect(res.json().kinds.every((k: { enabled: boolean }) => k.enabled)).toBe(true);

    expect((await app.inject({ method: 'PUT', url: '/api/alerts/kinds', headers: local, payload: { kinds: ['bills'] } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/alerts', headers: local })).json().kinds.filter((k: { enabled: boolean }) => k.enabled).map((k: { kind: string }) => k.kind)).toEqual(['bills']);
    expect((await app.inject({ method: 'PUT', url: '/api/alerts/kinds', headers: local, payload: { kinds: ['nonsense'] } })).statusCode).toBe(400);
  });

  it('refuses a test message when nothing is set up', async () => {
    const app = await buildApp(books(), { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ledgerly-alerts-')) }), webDir: '/nonexistent' });
    close = () => app.close();
    expect((await app.inject({ method: 'POST', url: '/api/alerts/test', headers: local })).statusCode).toBe(400);
  });
});

describe('a person\'s own channels', () => {
  it('are added, used and removed, and never show their address or token', async () => {
    const config = { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ledgerly-own-')) }), webDir: '/nonexistent' };
    const db = books();
    const app = await buildApp(db, config);
    close = () => app.close();

    const added = await app.inject({ method: 'POST', url: '/api/alerts/channels', headers: local, payload: { kind: 'ntfy', url: 'https://ntfy.sh/my-private-topic' } });
    expect(added.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: '/api/alerts/channels', headers: local, payload: { kind: 'telegram', token: 'secret-bot-token', chat: '42' } });
    const state = await app.inject({ url: '/api/alerts', headers: local });
    expect(state.body).not.toMatch(/my-private-topic|secret-bot-token/);
    // And on disk, the address and token are sealed.
    const { getSetting } = await import('@ledgerly/core');
    expect(getSetting(db, 'alerts.own')).not.toMatch(/my-private-topic|secret-bot-token/);
    expect(state.json().own).toEqual([{ id: expect.any(String), kind: 'ntfy', host: 'ntfy.sh' }, { id: expect.any(String), kind: 'telegram', host: 'api.telegram.org' }]);
    expect(state.json().channels.map((c: { id: string }) => c.id)).toEqual(['ntfy', 'telegram']);

    // They are what a pending alert goes to.
    const { allChannels } = await import('./notify.ts');
    const { fetcher, calls } = recorder();
    await sendPendingAlerts(db, allChannels(db, config), fetcher);
    expect(calls.map((c) => c.url)).toEqual(['https://ntfy.sh/my-private-topic', 'https://api.telegram.org/botsecret-bot-token/sendMessage']);

    expect((await app.inject({ method: 'DELETE', url: `/api/alerts/channels/${added.json().id}`, headers: local })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/alerts', headers: local })).json().own).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: '/api/alerts/channels/nope', headers: local })).statusCode).toBe(404);
  });

  it('are checked: an address, a Telegram pair, and no more than five', async () => {
    const config = { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ledgerly-own-')) }), webDir: '/nonexistent' };
    const app = await buildApp(books(), config);
    close = () => app.close();
    const add = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/alerts/channels', headers: local, payload });
    expect((await add({ kind: 'ntfy', url: 'not a url' })).statusCode).toBe(400);
    expect((await add({ kind: 'telegram', token: 't' })).statusCode).toBe(400);
    expect((await add({ kind: 'bogus' })).statusCode).toBe(400);
    for (let i = 0; i < 5; i++) expect((await add({ kind: 'webhook', url: `https://hooks.example/${i}` })).statusCode).toBe(201);
    expect((await add({ kind: 'webhook', url: 'https://hooks.example/6' })).statusCode).toBe(409);
  });
});
