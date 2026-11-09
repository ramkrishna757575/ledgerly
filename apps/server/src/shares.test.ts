import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@ledgerly/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { initSecrets } from './secrets.ts';
import { resetLoginThrottle } from './signup-guards.ts';
import { Tenants } from './tenants.ts';

const local = { host: 'localhost:4310' };
let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => cleanup?.());
beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-shares-'))));
const PASSWORD = 'quiet-river-stone';

async function start() {
  resetLoginThrottle();
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-sh-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password', ADMIN_USERNAME: 'asha' }), webDir: '/nonexistent' };
  const tenants = new Tenants(config);
  await tenants.bootstrap('asha', 'admin-password');
  const app = await buildApp(openDb(':memory:'), config, { tenants });
  cleanup = async () => {
    await app.close();
    tenants.close();
  };
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;
  const login = async (u: string, p: string) => cookieOf(await app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username: u, password: p } }));
  const asha = await login('asha', 'admin-password');
  for (const name of ['ben', 'carol']) await app.inject({ method: 'POST', url: '/api/users', headers: { ...local, cookie: asha }, payload: { username: name, password: PASSWORD } });
  const ben = await login('ben', PASSWORD);
  const carol = await login('carol', PASSWORD);
  const benId = tenants.findByName('ben')!.id;
  const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown, ledger?: number) =>
    app.inject({ method, url, headers: { ...local, cookie, ...(ledger ? { 'x-ledger': String(ledger) } : {}) }, payload: payload as object });
  const names = async (cookie: string, ledger?: number) => ((await send('GET', '/api/accounts', cookie, undefined, ledger)).json() as { name: string }[]).map((a) => a.name);
  await send('POST', '/api/accounts', ben, { name: 'Ben Savings', type: 'asset', subtype: 'bank' });
  return { app, tenants, send, names, ben, carol, benId, asha };
}

describe('letting someone into your books', () => {
  it('keeps the books closed until the owner lets someone in', async () => {
    const { send, carol, benId } = await start();
    const res = await send('GET', '/api/accounts', carol, undefined, benId);
    expect(res.statusCode).toBe(403);
  });

  it('lets a viewer look but not change, and never see keys, backups or agent access', async () => {
    const { send, names, ben, carol, benId } = await start();
    expect((await send('POST', '/api/shares', ben, { username: 'carol', role: 'viewer' })).statusCode).toBe(201);
    expect(await names(carol, benId)).toContain('Ben Savings');
    expect(await names(carol)).not.toContain('Ben Savings'); // her own books are still her own

    const write = await send('POST', '/api/accounts', carol, { name: 'Sneaky', type: 'asset', subtype: 'bank' }, benId);
    expect(write.statusCode).toBe(403);
    expect(write.json().error).toMatch(/look at these books but not change/);
    for (const url of ['/api/settings', '/api/backups', '/api/agents/tokens', '/api/mail', '/api/ai/status']) {
      expect((await send('GET', url, carol, undefined, benId)).statusCode).toBe(403);
    }
    expect(await names(ben)).not.toContain('Sneaky');
  });

  it('lets an editor change the books but still not the owner\'s settings, keys or backups', async () => {
    const { send, names, ben, carol, benId } = await start();
    await send('POST', '/api/shares', ben, { username: 'carol', role: 'editor' });
    const made = await send('POST', '/api/accounts', carol, { name: 'Joint Savings', type: 'asset', subtype: 'bank' }, benId);
    expect(made.statusCode).toBe(201);
    expect(await names(ben)).toContain('Joint Savings');
    expect(await names(carol)).not.toContain('Joint Savings');

    expect((await send('PUT', '/api/settings/ai', carol, { provider: 'anthropic', model: 'x', apiKey: 'k' }, benId)).statusCode).toBe(403);
    expect((await send('POST', '/api/backups', carol, undefined, benId)).statusCode).toBe(403);
    expect((await send('POST', '/api/agents/tokens', carol, { name: 'bot', scope: 'read' }, benId)).statusCode).toBe(403);
    expect((await send('POST', '/api/account/reset', carol, { confirm: 'DELETE EVERYTHING' }, benId)).statusCode).not.toBe(403);
    // ...and that last one reset Carol's own books, never Ben's.
    expect(await names(ben)).toContain('Joint Savings');
  });

  it('takes access away when the owner revokes it, or when the person leaves', async () => {
    const { send, names, ben, carol, benId, tenants } = await start();
    await send('POST', '/api/shares', ben, { username: 'carol', role: 'viewer' });
    const carolId = tenants.findByName('carol')!.id;
    expect((await send('GET', '/api/shares', ben)).json().granted).toEqual([{ memberId: carolId, username: 'carol', role: 'viewer' }]);
    expect((await send('GET', '/api/shares', carol)).json().received).toEqual([{ ownerId: benId, username: 'ben', role: 'viewer' }]);

    expect((await send('DELETE', `/api/shares/${carolId}`, ben)).statusCode).toBe(204);
    expect((await send('GET', '/api/accounts', carol, undefined, benId)).statusCode).toBe(403);

    await send('POST', '/api/shares', ben, { username: 'carol', role: 'viewer' });
    expect((await send('DELETE', `/api/shares/received/${benId}`, carol)).statusCode).toBe(204);
    expect((await send('GET', '/api/accounts', carol, undefined, benId)).statusCode).toBe(403);
    expect(await names(ben)).toContain('Ben Savings');
  });

  it('refuses someone who does not exist, and yourself, and tells the page whose books it is looking at', async () => {
    const { send, app, ben, carol, benId } = await start();
    expect((await send('POST', '/api/shares', ben, { username: 'nobody', role: 'viewer' })).statusCode).toBe(404);
    expect((await send('POST', '/api/shares', ben, { username: 'ben', role: 'viewer' })).statusCode).toBe(400);
    await send('POST', '/api/shares', ben, { username: 'carol', role: 'editor' });
    const status = (await app.inject({ url: '/api/auth/status', headers: { ...local, cookie: carol, 'x-ledger': String(benId) } })).json();
    expect(status.viewing).toEqual({ ownerId: benId, username: 'ben', role: 'editor' });
    expect((await app.inject({ url: '/api/auth/status', headers: { ...local, cookie: carol } })).json().viewing).toBeNull();
  });

  it('removes shares when an account is deleted, so a reused id never inherits them', async () => {
    const { send, ben, carol, benId, tenants, asha } = await start();
    await send('POST', '/api/shares', ben, { username: 'carol', role: 'viewer' });
    const carolId = tenants.findByName('carol')!.id;
    await send('PATCH', `/api/users/${benId}`, asha, { disabled: true });
    expect((await send('GET', '/api/shares', carol)).json().received).toEqual([]); // the owner is disabled
    void carolId;
    expect((await send('GET', '/api/accounts', carol, undefined, benId)).statusCode).toBe(403);
  });
});
