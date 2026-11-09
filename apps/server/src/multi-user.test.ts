import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@ledgerly/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { initSecrets } from './secrets.ts';
import { Tenants } from './tenants.ts';

const local = { host: 'localhost:4310' };
beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-mu-secrets-'))));
let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => cleanup?.());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')]);

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-multi-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password', ADMIN_USERNAME: 'Asha' }), webDir: '/nonexistent' };
  const tenants = new Tenants(config);
  await tenants.bootstrap(config.adminUsername, config.authPassword!);
  const app = await buildApp(openDb(':memory:'), config, { tenants });
  cleanup = async () => {
    await app.close();
    tenants.close();
  };
  const who = (cookie?: string) => ({ ...local, ...(cookie ? { cookie } : {}) });
  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username, password } });
    const raw = res.headers['set-cookie'];
    return { res, cookie: res.statusCode === 200 ? String(Array.isArray(raw) ? raw[0] : raw).split(';')[0]! : '' };
  };
  const asha = (await login('asha', 'admin-password')).cookie;
  const addUser = (username: string, password: string, role = 'user') =>
    app.inject({ method: 'POST', url: '/api/users', headers: who(asha), payload: { username, password, role } });
  await addUser('ben', 'quiet-river-stone');
  const ben = (await login('ben', 'quiet-river-stone')).cookie;
  return { app, tenants, config, dataDir, who, login, asha, ben, addUser };
}

const names = async (app: Awaited<ReturnType<typeof start>>['app'], headers: Record<string, string>) =>
  ((await app.inject({ url: '/api/accounts', headers })).json() as { name: string }[]).map((a) => a.name);

describe('separate books for each person', () => {
  it('keeps everything one person does out of everyone else\'s view', async () => {
    const { app, who, asha, ben } = await start();
    expect((await app.inject({ url: '/api/accounts', headers: local })).statusCode).toBe(401);

    await app.inject({ method: 'POST', url: '/api/accounts', headers: who(asha), payload: { name: 'Asha Savings', type: 'asset', subtype: 'bank' } });
    await app.inject({ method: 'POST', url: '/api/accounts', headers: who(ben), payload: { name: 'Ben Savings', type: 'asset', subtype: 'bank' } });
    expect(await names(app, who(asha))).toContain('Asha Savings');
    expect(await names(app, who(asha))).not.toContain('Ben Savings');
    expect(await names(app, who(ben))).toContain('Ben Savings');
    expect(await names(app, who(ben))).not.toContain('Asha Savings');

    // Reports and every other route read the same person's books.
    const asNet = (await app.inject({ url: '/api/reports/net-worth', headers: who(ben) })).json();
    expect(asNet.netWorth).toBe(0);
  });

  it('starts one person over without touching anyone else', async () => {
    const { app, who, asha, ben } = await start();
    await app.inject({ method: 'POST', url: '/api/accounts', headers: who(asha), payload: { name: 'Asha Savings', type: 'asset', subtype: 'bank' } });
    await app.inject({ method: 'POST', url: '/api/accounts', headers: who(ben), payload: { name: 'Ben Savings', type: 'asset', subtype: 'bank' } });
    const done = await app.inject({ method: 'POST', url: '/api/account/reset', headers: who(ben), payload: { confirm: 'DELETE EVERYTHING' } });
    expect(done.statusCode).toBe(200);
    expect(await names(app, who(ben))).not.toContain('Ben Savings');
    expect(await names(app, who(ben))).toContain('Groceries');
    expect(await names(app, who(asha))).toContain('Asha Savings');
    // Still signed in afterwards.
    expect((await app.inject({ url: '/api/accounts', headers: who(ben) })).statusCode).toBe(200);
  });

  it('holds up when two people use it at the same moment', async () => {
    const { app, who, asha, ben } = await start();
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => app.inject({ method: 'POST', url: '/api/accounts', headers: who(asha), payload: { name: `A${i}`, type: 'asset', subtype: 'bank' } })),
      ...Array.from({ length: 10 }, (_, i) => app.inject({ method: 'POST', url: '/api/accounts', headers: who(ben), payload: { name: `B${i}`, type: 'asset', subtype: 'bank' } })),
    ]);
    const [a, b] = await Promise.all([names(app, who(asha)), names(app, who(ben))]);
    expect(a.filter((n) => /^[AB]\d$/.test(n)).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `A${i}`));
    expect(b.filter((n) => /^[AB]\d$/.test(n)).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `B${i}`));
  });

  it('keeps files, backups and the change log apart too', async () => {
    const { app, who, asha, ben, dataDir } = await start();
    const bank = (await app.inject({ method: 'POST', url: '/api/accounts', headers: who(asha), payload: { name: 'Bank', type: 'asset', subtype: 'bank' } })).json();
    const food = (await app.inject({ url: '/api/accounts', headers: who(asha) })).json().find((a: { name: string }) => a.name === 'Groceries');
    const tx = (await app.inject({ method: 'POST', url: '/api/transactions/simple', headers: who(asha), payload: { date: '2026-10-01', description: 'Shop', kind: 'expense', accountId: bank.id, counterAccountId: food.id, amount: 100_00 } })).json();

    const boundary = 'b';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.png"\r\nContent-Type: image/png\r\n\r\n`), PNG, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const up = await app.inject({ method: 'POST', url: `/api/transactions/${tx.id}/attachments`, payload: body, headers: { ...who(asha), 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(up.statusCode).toBe(201);
    expect(readdirSync(join(dataDir, 'documents')).length).toBe(1);
    // Ben has no such transaction or file, by id or by address.
    expect((await app.inject({ url: `/api/transactions/${tx.id}/attachments`, headers: who(ben) })).json()).toEqual([]);
    expect((await app.inject({ url: up.json().url, headers: who(ben) })).statusCode).toBe(404);

    await app.inject({ method: 'POST', url: '/api/backups', headers: who(asha) });
    expect((await app.inject({ url: '/api/backups', headers: who(asha) })).json().items).toHaveLength(1);
    expect((await app.inject({ url: '/api/backups', headers: who(ben) })).json().items).toHaveLength(0);
    expect(existsSync(join(dataDir, 'users', '2', 'backups'))).toBe(false);

    const activity = async (h: Record<string, string>) => JSON.stringify((await app.inject({ url: '/api/activity', headers: h })).json());
    expect(await activity(who(asha))).toContain('POST /api/transactions/simple');
    expect(await activity(who(ben))).not.toContain('transactions/simple');
  });

  it('opens an agent token for the right person\'s books only', async () => {
    const { app, who, asha, ben } = await start();
    const tokenFor = async (cookie: string) => (await app.inject({ method: 'POST', url: '/api/agents/tokens', headers: who(cookie), payload: { name: 'bot', scope: 'read' } })).json().token as string;
    const ta = await tokenFor(asha);
    const tb = await tokenFor(ben);
    expect(ta).toMatch(/^lg_u1\./);
    expect(tb).toMatch(/^lg_u2\./);

    await app.inject({ method: 'POST', url: '/api/accounts', headers: who(asha), payload: { name: 'Asha Only', type: 'asset', subtype: 'bank' } });
    const ask = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...local, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_accounts', arguments: {} } },
      });
    expect((await ask(ta)).body).toContain('Asha Only');
    expect((await ask(tb)).body).not.toContain('Asha Only');
    // Ben's secret under Asha's number opens nothing.
    expect((await ask(`lg_u1.${tb.split('.')[1]}`)).statusCode).toBe(401);
    expect((await ask('lg_u99.whatever')).statusCode).toBe(401);
    expect((await ask(ta.replace('lg_u1.', 'lg_'))).statusCode).toBe(401);
  });
});

describe('managing people', () => {
  it('lets only an administrator see and change who has access', async () => {
    const { app, who, asha, ben } = await start();
    expect((await app.inject({ url: '/api/users', headers: who(ben) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/users', headers: who(ben), payload: { username: 'eve', password: 'password123' } })).statusCode).toBe(403);
    const list = (await app.inject({ url: '/api/users', headers: who(asha) })).json();
    expect(list.map((u: { username: string }) => u.username)).toEqual(['asha', 'ben']);
    expect(JSON.stringify(list)).not.toMatch(/password|hash|salt/i);
    expect((await app.inject({ url: '/api/auth/status', headers: who(ben) })).json()).toMatchObject({ multiUser: true, username: 'ben', isAdmin: false });
  });

  it('checks usernames and passwords, and refuses a duplicate', async () => {
    const { app, who, asha, addUser } = await start();
    expect((await addUser('x', 'longenough1')).statusCode).toBe(400);
    expect((await addUser('has space', 'longenough1')).statusCode).toBe(400);
    expect((await addUser('carol', 'short')).statusCode).toBe(400);
    expect((await addUser('BEN', 'another-pass12')).statusCode).toBe(409);
    expect((await addUser('carol', 'long-enough-12')).statusCode).toBe(201);
    void app; void who; void asha;
  });

  it('signs a disabled person out at once and keeps them out, and can bring them back', async () => {
    const { app, who, asha, ben, login } = await start();
    const users = (await app.inject({ url: '/api/users', headers: who(asha) })).json();
    const benId = users.find((u: { username: string }) => u.username === 'ben').id;
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${benId}`, headers: who(asha), payload: { disabled: true } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/accounts', headers: who(ben) })).statusCode).toBe(401);
    expect((await login('ben', 'quiet-river-stone')).res.statusCode).toBe(401);
    await app.inject({ method: 'PATCH', url: `/api/users/${benId}`, headers: who(asha), payload: { disabled: false } });
    expect((await login('ben', 'quiet-river-stone')).res.statusCode).toBe(200);
  });

  it('never leaves the server without an administrator, or an administrator locked out by themselves', async () => {
    const { app, who, asha } = await start();
    const me = (await app.inject({ url: '/api/users', headers: who(asha) })).json()[0];
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${me.id}`, headers: who(asha), payload: { disabled: true } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${me.id}`, headers: who(asha), payload: { role: 'user' } })).statusCode).toBe(409);
  });

  it('deletes a person\'s books only when they are disabled and their name is typed, and never the first books', async () => {
    const { app, who, asha, dataDir, tenants } = await start();
    const created = (await app.inject({ method: 'POST', url: '/api/users', headers: who(asha), payload: { username: 'dan', password: 'quiet-meadow-stone' } })).json();
    const folder = join(dataDir, 'users', String(created.id));
    expect(existsSync(join(folder, 'ledgerly.db'))).toBe(true);

    const del = (id: number, confirm: string) => app.inject({ method: 'DELETE', url: `/api/users/${id}`, headers: who(asha), payload: { confirm } });
    expect((await del(created.id, 'dan')).statusCode).toBe(409); // not disabled yet
    await app.inject({ method: 'PATCH', url: `/api/users/${created.id}`, headers: who(asha), payload: { disabled: true } });
    expect((await del(created.id, 'wrong')).statusCode).toBe(400);
    expect(existsSync(folder)).toBe(true);
    expect((await del(created.id, 'dan')).statusCode).toBe(204);
    expect(existsSync(folder)).toBe(false);
    expect(tenants.findByName('dan')).toBeUndefined();

    const first = tenants.list().find((u) => u.dataPath === '')!;
    await app.inject({ method: 'POST', url: '/api/users', headers: who(asha), payload: { username: 'second', password: 'quiet-forest-stone', role: 'admin' } });
    await app.inject({ method: 'PATCH', url: `/api/users/${first.id}`, headers: { ...local, cookie: (await (async () => { const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username: 'second', password: 'quiet-forest-stone' } }); return String(r.headers['set-cookie']).split(';')[0]!; })()) }, payload: { disabled: true } });
    expect((await del(first.id, 'asha')).statusCode).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dataDir, 'ledgerly.db'))).toBe(true);
  });
});

describe('passwords', () => {
  it('changes only with the current one, and signs out other devices', async () => {
    const { app, who, ben, login } = await start();
    const other = (await login('ben', 'quiet-river-stone')).cookie;
    expect((await app.inject({ method: 'POST', url: '/api/account/password', headers: who(ben), payload: { current: 'nope', next: 'fresh-green-hill' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/account/password', headers: who(ben), payload: { current: 'quiet-river-stone', next: 'short' } })).statusCode).toBe(400);
    const changed = await app.inject({ method: 'POST', url: '/api/account/password', headers: who(ben), payload: { current: 'quiet-river-stone', next: 'fresh-green-hill' } });
    expect(changed.statusCode).toBe(204);
    const fresh = String(changed.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ url: '/api/accounts', headers: who(fresh) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/accounts', headers: who(other) })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/accounts', headers: who(ben) })).statusCode).toBe(401);
    expect((await login('ben', 'quiet-river-stone')).res.statusCode).toBe(401);
    expect((await login('ben', 'fresh-green-hill')).res.statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown name, and needs a server password to start', async () => {
    const { app } = await start();
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username: 'asha', password: 'nope' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username: 'nobody', password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(() => loadConfig({ MULTI_USER: 'true' })).toThrow(/AUTH_PASSWORD/);
    expect(() => loadConfig({ MULTI_USER: 'true', AUTH_PASSWORD: 'x', VIEWER_PASSWORD: 'y' })).toThrow(/VIEWER_PASSWORD/);
  });
});

describe('what belongs to the person running the server', () => {
  it('keeps the AI key and alert channels to the administrator unless the key is shared', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-multi-ai-'));
    const env = { DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-secret', NOTIFY_NTFY_URL: 'https://ntfy.sh/mine' };
    for (const [extra, benSees] of [[{}, false], [{ AI_FOR_ALL_USERS: 'true' }, true]] as const) {
      const config = { ...loadConfig({ ...env, ...extra, DATA_DIR: mkdtempSync(join(tmpdir(), 'ledgerly-multi-ai-')) }), webDir: '/nonexistent' };
      const tenants = new Tenants(config);
      await tenants.bootstrap('admin', 'admin-password');
      const app = await buildApp(openDb(':memory:'), config, { tenants });
      const cookieOf = async (u: string, p: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username: u, password: p } })).headers['set-cookie']).split(';')[0]!;
      const admin = await cookieOf('admin', 'admin-password');
      await app.inject({ method: 'POST', url: '/api/users', headers: { ...local, cookie: admin }, payload: { username: 'ben', password: 'quiet-river-stone' } });
      const ben = await cookieOf('ben', 'quiet-river-stone');

      expect((await app.inject({ url: '/api/analysis', headers: { ...local, cookie: admin } })).json().ai.configured).toBe(true);
      expect((await app.inject({ url: '/api/analysis', headers: { ...local, cookie: ben } })).json().ai.configured).toBe(benSees);
      expect((await app.inject({ url: '/api/alerts', headers: { ...local, cookie: admin } })).json().channels).toHaveLength(1);
      expect((await app.inject({ url: '/api/alerts', headers: { ...local, cookie: ben } })).json().channels).toHaveLength(0);
      await app.close();
      tenants.close();
    }
  });
});

describe('each person\'s own alert channels', () => {
  it('belong to them alone, and cannot point the server at its own network unless they run it', async () => {
    const { app, who, asha, ben } = await start();
    const add = (cookie: string, url: string) => app.inject({ method: 'POST', url: '/api/alerts/channels', headers: who(cookie), payload: { kind: 'webhook', url } });

    for (const url of ['https://127.0.0.1/hook', 'https://192.168.1.10/hook', 'https://[::1]/hook', 'https://10.0.0.5/hook', 'https://localhost/hook', 'http://93.184.216.34/hook', 'https://169.254.169.254/latest']) {
      const res = await add(ben, url);
      expect(res.statusCode, url).toBe(400);
    }
    expect((await add(ben, 'https://93.184.216.34/hook')).statusCode).toBe(201);
    // The administrator runs the machine and may point at their own network.
    expect((await add(asha, 'https://192.168.1.10/hook')).statusCode).toBe(201);

    expect((await app.inject({ url: '/api/alerts', headers: who(ben) })).json().own).toHaveLength(1);
    expect((await app.inject({ url: '/api/alerts', headers: who(asha) })).json().own).toHaveLength(1);
    expect(JSON.stringify((await app.inject({ url: '/api/alerts', headers: who(ben) })).json())).not.toContain('192.168');
  });
});

describe('where each person\'s files are kept', () => {
  it('puts a person\'s statements and receipts in their own folder, never in a shared one', async () => {
    const { app, who, asha, ben, dataDir } = await start();
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('same picture')]);
    const tx = async (cookie: string) => {
      const bank = (await app.inject({ method: 'POST', url: '/api/accounts', headers: who(cookie), payload: { name: 'Bank', type: 'asset', subtype: 'bank' } })).json();
      const food = (await app.inject({ url: '/api/accounts', headers: who(cookie) })).json().find((a: { name: string }) => a.name === 'Groceries');
      return (await app.inject({ method: 'POST', url: '/api/transactions/simple', headers: who(cookie), payload: { date: '2026-10-01', description: 'x', kind: 'expense', accountId: bank.id, counterAccountId: food.id, amount: 100 } })).json().id as number;
    };
    const attach = (cookie: string, id: number) => {
      const boundary = 'b';
      return app.inject({ method: 'POST', url: `/api/transactions/${id}/attachments`, payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.png"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { ...who(cookie), 'content-type': `multipart/form-data; boundary=${boundary}` } });
    };
    const a = await attach(ben, await tx(ben));
    expect(a.statusCode).toBe(201);
    // Ben's file is in Ben's folder. The first administrator's folder is the server's root, so it holds nothing of his.
    expect(readdirSync(join(dataDir, 'users', '2', 'documents')).length).toBe(1);
    expect(existsSync(join(dataDir, 'documents'))).toBe(false);

    // The very same picture from someone else is a separate copy, so neither can see or remove the other's.
    const b = await attach(asha, await tx(asha));
    expect(b.statusCode).toBe(201);
    expect(readdirSync(join(dataDir, 'documents')).length).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/attachments/${a.json().id}`, headers: who(ben) })).statusCode).toBe(204);
    expect(readdirSync(join(dataDir, 'documents')).length).toBe(1);
    expect((await app.inject({ url: b.json().url, headers: who(asha) })).statusCode).toBe(200);
    expect((await app.inject({ url: b.json().url, headers: who(ben) })).statusCode).toBe(404);
  });
});
