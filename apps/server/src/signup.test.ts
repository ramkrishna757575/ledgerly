import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@ledgerly/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { initSecrets } from './secrets.ts';
import { issueChallenge, loginBlocked, resetLoginThrottle, loginFailed, passwordProblem, solveChallenge, verifyChallenge } from './signup-guards.ts';
import { Tenants } from './tenants.ts';

const local = { host: 'localhost:4310' };
let cleanup: (() => Promise<unknown>) | undefined;
afterEach(async () => cleanup?.());
beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-signup-'))));

async function start(env: Record<string, string> = {}) {
  resetLoginThrottle();
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-su-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password', ADMIN_USERNAME: 'asha', SIGNUP_RATE: '1000', ...env }), webDir: '/nonexistent' };
  const tenants = new Tenants(config);
  await tenants.bootstrap('asha', 'admin-password');
  const app = await buildApp(openDb(':memory:'), config, { tenants });
  cleanup = async () => {
    await app.close();
    tenants.close();
  };
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0]!;
  const login = async (u: string, p: string) => app.inject({ method: 'POST', url: '/api/auth/login', headers: local, payload: { username: u, password: p } });
  const asha = cookieOf(await login('asha', 'admin-password'));
  const as = (cookie: string) => ({ ...local, cookie });
  const signup = async (fields: Record<string, unknown>) => {
    const puzzle = (await app.inject({ url: '/api/auth/challenge', headers: local })).json();
    return app.inject({ method: 'POST', url: '/api/auth/signup', headers: local, payload: { challenge: puzzle.token, nonce: solveChallenge(puzzle.token, puzzle.difficulty), ...fields } });
  };
  return { app, tenants, dataDir, asha, as, login, signup, cookieOf };
}

describe('the checks before an account is made', () => {
  it('turns away weak passwords and accepts a reasonable one', () => {
    expect(passwordProblem('short', 'ben')).toMatch(/at least 10/);
    expect(passwordProblem('password123', 'ben')).toMatch(/easy to guess/);
    expect(passwordProblem('aaaaaaaaaaaa', 'ben')).toMatch(/easy to guess/);
    expect(passwordProblem('1111122222', 'ben')).toMatch(/easy to guess/);
    expect(passwordProblem('my-ben-password', 'Ben')).toMatch(/username/);
    expect(passwordProblem('correct horse battery', 'ben')).toBeNull();
  });

  it('asks for a small piece of work that works once and expires', () => {
    const { token, difficulty } = issueChallenge(1_000);
    expect(verifyChallenge(token, 'not it', 1_001)).toBe(false);
    const nonce = solveChallenge(token, difficulty);
    expect(verifyChallenge(token + 'x', nonce, 1_001)).toBe(false);
    expect(verifyChallenge(token, nonce, 1_001)).toBe(true);
    expect(verifyChallenge(token, nonce, 1_002)).toBe(false); // spent
    const old = issueChallenge(1_000);
    expect(verifyChallenge(old.token, solveChallenge(old.token, old.difficulty), 1_000 + 11 * 60 * 1000)).toBe(false);
  });

  it('pauses a name after too many wrong passwords', () => {
    for (let i = 0; i < 8; i++) loginFailed('Victim', 1_000);
    expect(loginBlocked('victim', 1_001)).toBe(true);
    expect(loginBlocked('other', 1_001)).toBe(false);
    expect(loginBlocked('victim', 1_000 + 16 * 60 * 1000)).toBe(false);
  });
});

describe('who may sign up', () => {
  it('is closed unless an administrator opens it', async () => {
    const { signup, app, asha, as } = await start();
    expect((await app.inject({ url: '/api/auth/status', headers: local })).json().signup).toBe('closed');
    const res = await signup({ username: 'newbie', password: 'a-good-long-password' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/closed/);
    expect((await app.inject({ method: 'PUT', url: '/api/admin/signup', headers: as(asha), payload: { mode: 'open' } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/auth/status', headers: local })).json().signup).toBe('open');
  });

  it('lets anyone in when open, signs them in at once, and gives them empty books of their own', async () => {
    const { signup, app, as, asha, cookieOf, dataDir } = await start({ SIGNUP_MODE: 'open' });
    const res = await signup({ username: 'Priya', password: 'a-good-long-password' });
    expect(res.statusCode).toBe(201);
    const priya = cookieOf(res);
    expect((await app.inject({ url: '/api/auth/status', headers: as(priya) })).json()).toMatchObject({ authenticated: true, username: 'priya', isAdmin: false });
    await app.inject({ method: 'POST', url: '/api/accounts', headers: as(priya), payload: { name: 'Priya Bank', type: 'asset', subtype: 'bank' } });
    expect(existsSync(join(dataDir, 'users'))).toBe(true);
    const names = async (cookie: string) => ((await app.inject({ url: '/api/accounts', headers: as(cookie) })).json() as { name: string }[]).map((a) => a.name);
    expect(await names(priya)).toContain('Priya Bank');
    expect(await names(asha)).not.toContain('Priya Bank');
    // Not an administrator, and cannot make themselves one.
    expect((await app.inject({ url: '/api/users', headers: as(priya) })).statusCode).toBe(403);
  });

  it('refuses a bad name or password, a taken name, a missing or wrong puzzle, and a filled hidden field', async () => {
    const { signup, app } = await start({ SIGNUP_MODE: 'open' });
    expect((await signup({ username: 'ab', password: 'a-good-long-password' })).statusCode).toBe(400);
    expect((await signup({ username: 'has space', password: 'a-good-long-password' })).statusCode).toBe(400);
    expect((await signup({ username: 'carol', password: 'weak' })).json().error).toMatch(/at least 10/);
    expect((await signup({ username: 'carol', password: 'password123' })).json().error).toMatch(/easy to guess/);
    expect((await signup({ username: 'asha', password: 'a-good-long-password' })).statusCode).toBe(409);
    expect((await signup({ username: 'robot', password: 'a-good-long-password', website: 'http://spam' })).statusCode).toBe(400);
    const noPuzzle = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: local, payload: { username: 'dave', password: 'a-good-long-password', challenge: 'x.y', nonce: '1' } });
    expect(noPuzzle.statusCode).toBe(400);
    expect(noPuzzle.json().error).toMatch(/check before sign-up/);
    const reuse = (await app.inject({ url: '/api/auth/challenge', headers: local })).json();
    const nonce = solveChallenge(reuse.token, reuse.difficulty);
    const body = { username: 'erin', password: 'a-good-long-password', challenge: reuse.token, nonce };
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', headers: local, payload: body })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', headers: local, payload: { ...body, username: 'erin2' } })).statusCode).toBe(400);
  });

  it('holds a sign-up for approval when that is the mode, and lets the administrator decide', async () => {
    const { signup, app, asha, as, login, dataDir } = await start({ SIGNUP_MODE: 'approval' });
    const res = await signup({ username: 'frank', password: 'a-good-long-password' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ pending: true });
    expect(res.headers['set-cookie']).toBeUndefined();

    const waiting = await login('frank', 'a-good-long-password');
    expect(waiting.statusCode).toBe(403);
    expect(waiting.json().error).toMatch(/waiting for an administrator/);
    expect((await login('frank', 'wrong-password-here')).statusCode).toBe(401);
    expect(existsSync(join(dataDir, 'users'))).toBe(false); // no books until they are let in

    const frank = (await app.inject({ url: '/api/users', headers: as(asha) })).json().find((u: { username: string }) => u.username === 'frank');
    expect(frank).toMatchObject({ pending: true });
    expect((await app.inject({ method: 'PATCH', url: `/api/users/${frank.id}`, headers: as(asha), payload: { approve: true } })).statusCode).toBe(204);
    expect((await login('frank', 'a-good-long-password')).statusCode).toBe(200);

    await signup({ username: 'gina', password: 'a-good-long-password' });
    const gina = (await app.inject({ url: '/api/users', headers: as(asha) })).json().find((u: { username: string }) => u.username === 'gina');
    expect((await app.inject({ method: 'DELETE', url: `/api/users/${gina.id}`, headers: as(asha), payload: { confirm: 'gina' } })).statusCode).toBe(204);
    expect((await login('gina', 'a-good-long-password')).statusCode).toBe(401);
  });

  it('needs an invite code in invite mode, which works once, expires and can be withdrawn', async () => {
    const { signup, app, asha, as, cookieOf } = await start({ SIGNUP_MODE: 'invite' });
    expect((await signup({ username: 'hank', password: 'a-good-long-password' })).json().error).toMatch(/needs an invite code/);
    expect((await signup({ username: 'hank', password: 'a-good-long-password', code: 'AAAA-BBBB-CCCC-DDDD' })).json().error).toMatch(/not valid/);

    const invite = (await app.inject({ method: 'POST', url: '/api/invites', headers: as(asha), payload: { note: 'for Hank' } })).json();
    expect(invite.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    const listed = (await app.inject({ url: '/api/admin/signup', headers: as(asha) })).json();
    expect(JSON.stringify(listed)).not.toContain(invite.code);
    expect(listed.invites[0]).toMatchObject({ note: 'for Hank', usedBy: null });

    const ok = await signup({ username: 'hank', password: 'a-good-long-password', code: invite.code.toLowerCase() });
    expect(ok.statusCode).toBe(201);
    expect(cookieOf(ok)).toBeTruthy();
    expect((await signup({ username: 'ivy', password: 'a-good-long-password', code: invite.code })).json().error).toMatch(/used or expired|not valid/);

    // An invite for an administrator makes one.
    const adminInvite = (await app.inject({ method: 'POST', url: '/api/invites', headers: as(asha), payload: { role: 'admin' } })).json();
    const second = await signup({ username: 'jules', password: 'a-good-long-password', code: adminInvite.code });
    expect((await app.inject({ url: '/api/users', headers: as(cookieOf(second)) })).statusCode).toBe(200);

    const spare = (await app.inject({ method: 'POST', url: '/api/invites', headers: as(asha), payload: {} })).json();
    expect((await app.inject({ method: 'DELETE', url: `/api/invites/${spare.id}`, headers: as(asha) })).statusCode).toBe(204);
    expect((await signup({ username: 'kim', password: 'a-good-long-password', code: spare.code })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/invites', headers: as(cookieOf(ok)), payload: {} })).statusCode).toBe(403);
  });

  it('turns an invite away in closed mode, and honours a code even when sign-up is otherwise by approval', async () => {
    const { signup, app, asha, as } = await start();
    const invite = (await app.inject({ method: 'POST', url: '/api/invites', headers: as(asha), payload: {} })).json();
    expect((await signup({ username: 'lena', password: 'a-good-long-password', code: invite.code })).json().error).toMatch(/closed/);
    await app.inject({ method: 'PUT', url: '/api/admin/signup', headers: as(asha), payload: { mode: 'approval' } });
    expect((await signup({ username: 'lena', password: 'a-good-long-password', code: invite.code })).statusCode).toBe(201); // a code skips the queue
  });
});

describe('wrong passwords and closing an account', () => {
  it('pauses a name that keeps being guessed', async () => {
    const { login } = await start();
    for (let i = 0; i < 8; i++) expect((await login('asha', `wrong-${i}`)).statusCode).toBe(401);
    expect((await login('asha', 'admin-password')).statusCode).toBe(429);
  });

  it('lets someone close their own account and take their books with it, but not the first books', async () => {
    const { signup, app, asha, as, cookieOf, dataDir } = await start({ SIGNUP_MODE: 'open' });
    const res = await signup({ username: 'maya', password: 'a-good-long-password' });
    const maya = cookieOf(res);
    await app.inject({ url: '/api/accounts', headers: as(maya) });
    const folder = join(dataDir, 'users', '2');
    expect(existsSync(folder)).toBe(true);

    const close = (cookie: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/account/delete', headers: as(cookie), payload: body });
    expect((await close(maya, { password: 'wrong', confirm: 'maya' })).statusCode).toBe(400);
    expect((await close(maya, { password: 'a-good-long-password', confirm: 'someone' })).statusCode).toBe(400);
    expect((await close(maya, { password: 'a-good-long-password', confirm: 'maya' })).statusCode).toBe(204);
    expect(existsSync(folder)).toBe(false);
    expect((await app.inject({ url: '/api/accounts', headers: as(maya) })).statusCode).toBe(401);
    expect((await close(asha, { password: 'admin-password', confirm: 'asha' })).statusCode).toBe(409);
  });
});

describe('how often one address may sign up', () => {
  it('is limited', async () => {
    const { signup } = await start({ SIGNUP_MODE: 'open', SIGNUP_RATE: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await signup({ username: `user${i}`, password: 'a-good-long-password' })).statusCode);
    expect(codes.slice(0, 3)).toEqual([201, 201, 201]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});
