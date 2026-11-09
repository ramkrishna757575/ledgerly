import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@ledgerly/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig, loadSmtp } from './config.ts';
import { setMailSender } from './mailer.ts';
import { initSecrets } from './secrets.ts';
import { resetLoginThrottle, solveChallenge } from './signup-guards.ts';
import { Tenants } from './tenants.ts';
import { makeToken, readToken } from './tokens.ts';
import { totpCode } from './totp.ts';

const local = { host: 'localhost:4310' };
let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  setMailSender(undefined);
  await cleanup?.();
});
beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-email-'))));

const PASSWORD = 'quiet-river-stone';
type Sent = { to: string; subject: string; text: string };

async function start() {
  resetLoginThrottle();
  const sent: Sent[] = [];
  setMailSender(async (mail) => void sent.push(mail));
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-em-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password', ADMIN_USERNAME: 'asha', SIGNUP_MODE: 'open', SIGNUP_RATE: '1000', PUBLIC_URL: 'https://money.example.com/' }), webDir: '/nonexistent' };
  const tenants = new Tenants(config);
  await tenants.bootstrap('asha', 'admin-password');
  const app = await buildApp(openDb(':memory:'), config, { tenants });
  cleanup = async () => {
    await app.close();
    tenants.close();
  };
  const post = (url: string, payload: unknown, cookie?: string) => app.inject({ method: 'POST', url, headers: { ...local, ...(cookie ? { cookie } : {}) }, payload: payload as object });
  const login = (username: string, password: string, code?: string) => post('/api/auth/login', { username, password, ...(code ? { code } : {}) });
  const signup = async (fields: Record<string, unknown>) => {
    const puzzle = (await app.inject({ url: '/api/auth/challenge', headers: local })).json();
    return post('/api/auth/signup', { challenge: puzzle.token, nonce: solveChallenge(puzzle.token, puzzle.difficulty), ...fields });
  };
  const linkIn = (mail: Sent, path: 'verify' | 'reset') => mail.text.match(new RegExp(`https://money\\.example\\.com/${path}\\?token=(\\S+)`))![1]!;
  return { app, tenants, sent, post, login, signup, linkIn };
}

describe('the settings for sending mail', () => {
  it('needs a from address and the address the site is reached at', () => {
    expect(loadSmtp({})).toEqual({});
    expect(loadSmtp({ SMTP_HOST: 'smtp.example.com' }).smtpProblem).toMatch(/SMTP_FROM/);
    expect(loadSmtp({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'Ledgerly <no-reply@example.com>' }).smtpProblem).toMatch(/PUBLIC_URL/);
    expect(loadSmtp({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'no-reply@example.com', PUBLIC_URL: 'https://x.example.com', SMTP_PORT: '465' }).smtp).toMatchObject({ port: 465, secure: true });
  });
});

describe('links in mail', () => {
  it('cannot be forged, changed, aimed at another kind of link, or used late', () => {
    const token = makeToken('reset', 7, 60_000, 'abc');
    expect(readToken(token, 'reset')).toMatchObject({ userId: 7, fingerprint: 'abc' });
    expect(readToken(token, 'verify')).toBeNull();
    expect(readToken(`${token}x`, 'reset')).toBeNull();
    const [body] = token.split('.');
    expect(readToken(`${Buffer.from(JSON.stringify({ k: 'reset', u: 1, e: Date.now() + 99999, f: 'abc', d: '' })).toString('base64url')}.${token.split('.')[1]}`, 'reset')).toBeNull();
    expect(body).toBeTruthy();
    expect(readToken(makeToken('reset', 7, -1000), 'reset')).toBeNull();
  });
});

describe('confirming an email address', () => {
  it('needs an address, sends a link, and does not let anyone in until it is opened', async () => {
    const { signup, login, post, sent, linkIn } = await start();
    expect((await signup({ username: 'ben', password: PASSWORD })).statusCode).toBe(400);
    const made = await signup({ username: 'ben', password: PASSWORD, email: 'Ben@Example.com' });
    expect(made.statusCode).toBe(202);
    expect(made.json()).toMatchObject({ verify: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ben@example.com', subject: expect.stringContaining('Confirm') });

    const early = await login('ben', PASSWORD);
    expect(early.statusCode).toBe(403);
    expect(early.json().code).toBe('verify_email');

    expect((await post('/api/auth/verify', { token: 'nonsense' })).statusCode).toBe(400);
    expect((await post('/api/auth/verify', { token: linkIn(sent[0]!, 'verify') })).statusCode).toBe(200);
    expect((await login('ben', PASSWORD)).statusCode).toBe(200);
  });

  it('refuses an address that is already used, and resends without saying whether an address exists', async () => {
    const { signup, post, sent } = await start();
    await signup({ username: 'ben', password: PASSWORD, email: 'ben@example.com' });
    expect((await signup({ username: 'carol', password: PASSWORD, email: 'ben@example.com' })).statusCode).toBe(409);
    sent.length = 0;
    expect((await post('/api/auth/resend', { email: 'nobody@example.com' })).statusCode).toBe(204);
    expect(sent).toHaveLength(0);
    expect((await post('/api/auth/resend', { email: 'ben@example.com' })).statusCode).toBe(204);
    expect(sent).toHaveLength(1);
  });
});

describe('a forgotten password', () => {
  async function member() {
    const t = await start();
    await t.signup({ username: 'ben', password: PASSWORD, email: 'ben@example.com' });
    await t.post('/api/auth/verify', { token: t.linkIn(t.sent[0]!, 'verify') });
    t.sent.length = 0;
    return t;
  }

  it('sends a link only for a known address, answers the same either way, and works once', async () => {
    const { post, login, sent, linkIn } = await member();
    expect((await post('/api/auth/forgot', { email: 'nobody@example.com' })).statusCode).toBe(204);
    expect(sent).toHaveLength(0);
    expect((await post('/api/auth/forgot', { email: 'ben@example.com' })).statusCode).toBe(204);
    expect(sent).toHaveLength(1);
    const token = linkIn(sent[0]!, 'reset');

    expect((await post('/api/auth/reset', { token, password: 'short' })).statusCode).toBe(400);
    expect((await post('/api/auth/reset', { token, password: 'another-calm-lake' })).statusCode).toBe(204);
    expect((await login('ben', PASSWORD)).statusCode).toBe(401);
    expect((await login('ben', 'another-calm-lake')).statusCode).toBe(200);
    // Used once: the same link no longer works.
    expect((await post('/api/auth/reset', { token, password: 'yet-another-river' })).statusCode).toBe(400);
  });

  it('does not send a second link within a minute', async () => {
    const { post, sent } = await member();
    await post('/api/auth/forgot', { email: 'ben@example.com' });
    await post('/api/auth/forgot', { email: 'ben@example.com' });
    expect(sent).toHaveLength(1);
  });

  it('signs the person out everywhere, and still asks for the authenticator code', async () => {
    const { post, login, sent, linkIn, tenants } = await member();
    const cookie = String((await login('ben', PASSWORD)).headers['set-cookie']).split(';')[0]!;
    const setup = (await post('/api/account/2fa/setup', { password: PASSWORD }, cookie)).json();
    await post('/api/account/2fa/enable', { code: totpCode(setup.secret, Math.floor(Date.now() / 30_000)) }, cookie);
    await post('/api/auth/forgot', { email: 'ben@example.com' });
    await post('/api/auth/reset', { token: linkIn(sent.at(-1)!, 'reset'), password: 'another-calm-lake' });
    expect((await post('/api/accounts', {}, cookie)).statusCode).toBe(401);
    expect(tenants.findByName('ben')!.totpEnabled).toBe(true);
    expect((await login('ben', 'another-calm-lake')).json().code).toBe('two_factor');
  });
});

describe('changing the address', () => {
  it('sends a link to the new address and changes it only once that is opened', async () => {
    const { post, login, sent, linkIn, signup, tenants } = await start();
    await signup({ username: 'ben', password: PASSWORD, email: 'ben@example.com' });
    await post('/api/auth/verify', { token: linkIn(sent[0]!, 'verify') });
    const cookie = String((await login('ben', PASSWORD)).headers['set-cookie']).split(';')[0]!;
    sent.length = 0;
    expect((await post('/api/account/email', { email: 'new@example.com', password: 'wrong-password-here' }, cookie)).statusCode).toBe(400);
    expect((await post('/api/account/email', { email: 'new@example.com', password: PASSWORD }, cookie)).json()).toMatchObject({ sentTo: 'new@example.com' });
    expect(tenants.findByName('ben')!.email).toBe('ben@example.com');
    await post('/api/auth/verify', { token: linkIn(sent[0]!, 'verify') });
    expect(tenants.findByName('ben')!.email).toBe('new@example.com');
  });
});

describe('the monthly summary', () => {
  it('is only sent to someone who asked, once a month, from the second, with no amounts in the subject', async () => {
    const { tenants, sent } = await start();
    const { tickSummary } = await import('./summary-mail.ts');
    const { setMonthlySummary } = await import('@ledgerly/core');
    const config = { ...loadConfig({ DATA_DIR: tmpdir(), PUBLIC_URL: 'https://money.example.com' }) };
    const db = tenants.tenantFor(tenants.findByName('asha')!).db;

    await tickSummary(db, config, 'asha@example.com', () => {}, '2026-11-05');
    expect(sent).toHaveLength(0); // not turned on
    setMonthlySummary(db, true);
    await tickSummary(db, config, 'asha@example.com', () => {}, '2026-11-01');
    expect(sent).toHaveLength(0); // too early in the month
    await tickSummary(db, config, null, () => {}, '2026-11-05');
    expect(sent).toHaveLength(0); // no address
    await tickSummary(db, config, 'asha@example.com', () => {}, '2026-11-05');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Your Ledgerly summary for October 2026');
    expect(sent[0]!.subject).not.toMatch(/₹|rs\.?\s?\d/i);
    expect(sent[0]!.text).toContain('Income:');
    await tickSummary(db, config, 'asha@example.com', () => {}, '2026-11-20');
    expect(sent).toHaveLength(1); // once for October
    await tickSummary(db, config, 'asha@example.com', () => {}, '2026-12-03');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toContain('November 2026');
  });
});
