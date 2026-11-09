import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@ledgerly/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { PRIVACY_TEMPLATE, TERMS_TEMPLATE } from './legal.ts';
import { initSecrets } from './secrets.ts';
import { clearFailures } from './security-log.ts';
import { resetLoginThrottle, solveChallenge } from './signup-guards.ts';
import { Tenants } from './tenants.ts';

const local = { host: 'localhost:4310' };
let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => cleanup?.());
beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-admin-'))));
const PASSWORD = 'quiet-river-stone';

async function start() {
  resetLoginThrottle();
  clearFailures();
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-ad-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password', ADMIN_USERNAME: 'asha', SIGNUP_MODE: 'open', SIGNUP_RATE: '1000' }), webDir: '/nonexistent' };
  const tenants = new Tenants(config);
  await tenants.bootstrap('asha', 'admin-password');
  const app = await buildApp(openDb(':memory:'), config, { tenants });
  cleanup = async () => {
    await app.close();
    tenants.close();
  };
  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, cookie?: string, payload?: unknown) => app.inject({ method, url, headers: { ...local, ...(cookie ? { cookie } : {}) }, payload: payload as object });
  const login = (username: string, password: string) => inject('POST', '/api/auth/login', undefined, { username, password });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;
  const asha = cookieOf(await login('asha', 'admin-password'));
  const signup = async (fields: Record<string, unknown>) => {
    const puzzle = (await app.inject({ url: '/api/auth/challenge', headers: local })).json();
    return inject('POST', '/api/auth/signup', undefined, { challenge: puzzle.token, nonce: solveChallenge(puzzle.token, puzzle.difficulty), ...fields });
  };
  return { app, tenants, inject, login, asha, cookieOf, signup };
}

describe('the administrator\'s overview', () => {
  it('is only for administrators', async () => {
    const { inject, signup, login, cookieOf } = await start();
    await signup({ username: 'ben', password: PASSWORD });
    const ben = cookieOf(await login('ben', PASSWORD));
    expect((await inject('GET', '/api/admin/overview', ben)).statusCode).toBe(403);
    expect((await inject('GET', '/api/admin/overview')).statusCode).toBe(401);
  });

  it('counts people, shows storage and last sign-in, and lists failed sign-ins without recording mistyped names', async () => {
    const { inject, signup, login, asha } = await start();
    await signup({ username: 'ben', password: PASSWORD });
    await signup({ username: 'carol', password: PASSWORD });
    await login('ben', 'wrong-password-here'); // a real account
    await login('not-a-real-name', 'x'); // maybe a password typed in the wrong box
    const overview = (await inject('GET', '/api/admin/overview', asha)).json();
    expect(overview.counts).toMatchObject({ total: 3, active: 3, waiting: 0, administrators: 1, twoFactor: 0 });
    expect(overview.signups.at(-1)).toMatchObject({ count: 3 });
    expect(overview.people.map((p: { username: string }) => p.username).sort()).toEqual(['asha', 'ben', 'carol']);
    expect(overview.people.find((p: { username: string }) => p.username === 'asha').lastLoginAt).toBeTruthy();
    expect(overview.failures).toHaveLength(2);
    expect(overview.failures.find((f: { kind: string }) => f.kind === 'wrong_password')).toMatchObject({ username: 'ben' });
    expect(overview.failures.find((f: { kind: string }) => f.kind === 'unknown_name').username).toBeNull();
    expect(JSON.stringify(overview)).not.toContain('not-a-real-name');
  });
});

describe('terms and privacy pages', () => {
  it('are public once written, and an administrator cannot turn them on with placeholders left in', async () => {
    const { inject, asha } = await start();
    expect((await inject('GET', '/api/legal')).json()).toEqual({ enabled: false, terms: '', privacy: '' });
    const templates = (await inject('GET', '/api/admin/legal', asha)).json().templates;
    expect(templates.terms).toBe(TERMS_TEMPLATE);
    expect((await inject('PUT', '/api/admin/legal', asha, { enabled: true, terms: TERMS_TEMPLATE, privacy: PRIVACY_TEMPLATE })).statusCode).toBe(400);
    const done = await inject('PUT', '/api/admin/legal', asha, { enabled: true, terms: '# Terms\nBe kind.', privacy: '# Privacy\nWe keep little.' });
    expect(done.statusCode).toBe(204);
    expect((await inject('GET', '/api/legal')).json()).toMatchObject({ enabled: true, terms: '# Terms\nBe kind.' });
  });

  it('must be agreed to at sign-up, and the time is kept', async () => {
    const { inject, signup, asha, tenants } = await start();
    await inject('PUT', '/api/admin/legal', asha, { enabled: true, terms: '# Terms', privacy: '# Privacy' });
    expect((await signup({ username: 'ben', password: PASSWORD })).statusCode).toBe(400);
    expect((await signup({ username: 'ben', password: PASSWORD, accept: true })).statusCode).toBe(201);
    expect(tenants.findByName('ben')!.termsAcceptedAt).toBeTruthy();
  });
});
