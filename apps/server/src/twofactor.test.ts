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
import { totpCode } from './totp.ts';

const local = { host: 'localhost:4310' };
let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => cleanup?.());
beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-2fa-'))));

const PASSWORD = 'quiet-river-stone';
const stepNow = () => Math.floor(Date.now() / 30_000);

async function start() {
  resetLoginThrottle();
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-2fa-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password', ADMIN_USERNAME: 'asha' }), webDir: '/nonexistent' };
  const tenants = new Tenants(config);
  await tenants.bootstrap('asha', 'admin-password');
  const app = await buildApp(openDb(':memory:'), config, { tenants });
  cleanup = async () => {
    await app.close();
    tenants.close();
  };
  const login = (username: string, password: string, code?: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username, password, ...(code ? { code } : {}) } });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;
  const asha = cookieOf(await login('asha', 'admin-password'));
  await app.inject({ method: 'POST', url: '/api/users', headers: { ...local, cookie: asha }, payload: { username: 'ben', password: PASSWORD } });
  const ben = cookieOf(await login('ben', PASSWORD));
  const as = (cookie: string) => ({ ...local, cookie });
  const post = (cookie: string, url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: as(cookie), payload: payload as object });

  // Turns it on for Ben and returns what he would be shown.
  async function turnOn() {
    const setup = (await post(ben, '/api/account/2fa/setup', { password: PASSWORD })).json();
    const enabled = await post(ben, '/api/account/2fa/enable', { code: totpCode(setup.secret, stepNow()) });
    return { secret: setup.secret as string, setup, recovery: enabled.json().recoveryCodes as string[], enabled };
  }
  return { app, tenants, login, asha, ben, as, post, turnOn };
}

describe('two-step sign-in', () => {
  it('gives a QR code and a secret, needs the password, and is not on until a code works', async () => {
    const { post, ben, login, as, app } = await start();
    expect((await post(ben, '/api/account/2fa/setup', { password: 'wrong-password-here' })).statusCode).toBe(400);
    const setup = (await post(ben, '/api/account/2fa/setup', { password: PASSWORD })).json();
    expect(setup.uri).toContain('otpauth://totp/Ledgerly:ben');
    expect(setup.qr).toContain('<svg');
    // Set up but not confirmed: signing in still needs only the password.
    expect((await login('ben', PASSWORD)).statusCode).toBe(200);
    expect((await post(ben, '/api/account/2fa/enable', { code: '000000' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/auth/status', headers: as(ben) })).json().twoFactor).toBe(false);
  });

  it('asks for a code at sign-in once it is on, and accepts each code once', async () => {
    const { turnOn, login, app, as, ben } = await start();
    const { secret, enabled, recovery } = await turnOn();
    expect(enabled.statusCode).toBe(200);
    expect(recovery).toHaveLength(8);
    expect((await app.inject({ url: '/api/auth/status', headers: as(ben) })).json().twoFactor).toBe(true);

    const noCode = await login('ben', PASSWORD);
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().code).toBe('two_factor');
    expect(noCode.headers['set-cookie']).toBeUndefined();
    expect((await login('ben', 'wrong-password-here', totpCode(secret, stepNow() + 1))).json().code).toBeUndefined();
    expect((await login('ben', PASSWORD, '123456')).statusCode).toBe(401);

    const code = totpCode(secret, stepNow() + 1);
    expect((await login('ben', PASSWORD, code)).statusCode).toBe(200);
    // The same code cannot be used again.
    expect((await login('ben', PASSWORD, code)).statusCode).toBe(401);
  });

  it('accepts each recovery code once', async () => {
    const { turnOn, login } = await start();
    const { recovery } = await turnOn();
    expect((await login('ben', PASSWORD, recovery[0]!)).statusCode).toBe(200);
    expect((await login('ben', PASSWORD, recovery[0]!)).statusCode).toBe(401);
    expect((await login('ben', PASSWORD, recovery[1]!.toUpperCase())).statusCode).toBe(200);
  });

  it('is paused after too many wrong codes, like wrong passwords', async () => {
    const { turnOn, login } = await start();
    await turnOn();
    for (let i = 0; i < 8; i++) await login('ben', PASSWORD, '000000');
    expect((await login('ben', PASSWORD, '000000')).statusCode).toBe(429);
  });

  it('is turned off with the password and a code, and by an administrator for a lost phone', async () => {
    const { turnOn, post, ben, login, asha, tenants } = await start();
    const { secret } = await turnOn();
    expect((await post(ben, '/api/account/2fa/disable', { password: PASSWORD, code: '000000' })).statusCode).toBe(400);
    expect((await post(ben, '/api/account/2fa/disable', { password: PASSWORD, code: totpCode(secret, stepNow() + 1) })).statusCode).toBe(204);
    expect((await login('ben', PASSWORD)).statusCode).toBe(200);

    const again = await turnOn();
    expect((await login('ben', PASSWORD)).statusCode).toBe(401);
    const id = tenants.findByName('ben')!.id;
    expect((await post(ben, `/api/users/${id}/2fa/reset`, {})).statusCode).toBe(403); // not an administrator
    expect((await post(asha, `/api/users/${id}/2fa/reset`, {})).statusCode).toBe(204);
    expect((await login('ben', PASSWORD)).statusCode).toBe(200);
    void again;
  });

  it('never stores the secret in the clear', async () => {
    const { turnOn, tenants } = await start();
    const { secret } = await turnOn();
    const stored = tenants.findByName('ben')!;
    expect(stored.totpSecret).toMatch(/^enc1:/);
    expect(JSON.stringify(stored)).not.toContain(secret);
  });
});
