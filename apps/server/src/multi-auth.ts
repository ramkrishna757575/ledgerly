import { createHash, randomBytes } from 'node:crypto';
import { DomainError } from '@ledgerly/core';
import { userSessions, users } from '@ledgerly/db';
import { eq, lt } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { issueChallenge, loginBlocked, loginFailed, loginSucceeded, verifyChallenge } from './signup-guards.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from './totp.ts';
import { PRIVACY_TEMPLATE, readLegal, saveLegal, TERMS_TEMPLATE } from './legal.ts';
import { canSendMail, sendMail } from './mailer.ts';
import { recentFailures, recordFailure } from './security-log.ts';
import { storageUsed } from './quota.ts';
import { signValue } from './secrets.ts';
import { makeToken, readToken } from './tokens.ts';
import { checkPassword, EMAIL, tenantStore, type Tenant, type Tenants, type UserRow } from './tenants.ts';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant | null;
    user: UserRow | null;
    // Set when the books being used belong to someone else, with what this person may do in them.
    ledgerRole: 'editor' | 'viewer' | null;
  }
}

const COOKIE = 'ledgerly_session';
const SESSION_DAYS = 30;
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/challenge', '/api/auth/signup', '/api/auth/verify', '/api/auth/resend', '/api/auth/forgot', '/api/auth/reset', '/api/legal']);
// Things about a person's own account, which are never about the books being looked at.
const OWN_AREAS = /^\/api\/(auth|account|users|admin|shares|invites|legal|health)(\/|$)/;
// What only the owner of the books may do, even for someone who may change them: keys and
// passwords, backups, agent access, and anything that spends the owner's AI key.
const OWNER_ONLY = /^\/api\/(settings|backups|mail|inbox|ai|demo)(\/|$)|^\/api\/agents\/tokens|^\/api\/alerts\/(channels|test)|^\/api\/analysis\/(run|market|settings)/;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// Sign-in for a server shared by several people, each with their own books.
// Who is asking decides which ledger every request reads and writes.
export function registerMultiAuth(app: FastifyInstance, tenants: Tenants, config: Config) {
  const { cookieSecure } = config;
  app.decorateRequest('tenant', null);
  app.decorateRequest('user', null);
  app.decorateRequest('ledgerRole', null);

  const userOf = (request: FastifyRequest) => {
    const token = request.cookies[COOKIE];
    if (!token) return null;
    const session = tenants.directory.select().from(userSessions).where(eq(userSessions.tokenHash, hashToken(token))).get();
    if (!session || session.expiresAt <= new Date().toISOString()) return null;
    const user = tenants.find(session.userId);
    return user && !user.disabled && !user.pending ? user : null;
  };

  app.addHook('onRequest', async (request, reply) => {
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const { origin } = request.headers;
    if (!isRead && origin) {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = undefined;
      }
      if (originHost !== request.headers.host) return reply.code(403).send({ error: 'Cross-origin request blocked' });
    }

    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/') || PUBLIC_ROUTES.has(path)) return;
    const user = userOf(request);
    if (!user) return reply.code(401).send({ error: 'Login required' });
    request.user = user;
    request.tenant = tenants.tenantFor(user);

    // Someone else's books, if this person has been let into them and asks for them.
    const asked = Number(request.headers['x-ledger']);
    if (Number.isInteger(asked) && asked > 0 && asked !== user.id && !OWN_AREAS.test(path)) {
      const role = tenants.accessTo(user.id, asked);
      const owner = role ? tenants.find(asked) : undefined;
      if (!role || !owner || owner.disabled || owner.pending) return reply.code(403).send({ error: 'You do not have access to those books' });
      if (OWNER_ONLY.test(path)) return reply.code(403).send({ error: 'Only the owner of these books can do that' });
      if (role === 'viewer' && !isRead) return reply.code(403).send({ error: 'You can look at these books but not change them' });
      request.tenant = tenants.tenantFor(owner);
      request.ledgerRole = role;
    }
  });

  // Everything after this point, in this request, belongs to one person's books.
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.tenant) tenantStore.run(request.tenant, done);
    else done();
  });

  // A code from the app, each good once, or a recovery code, each good once. Records the use.
  function useSecondFactor(user: UserRow, code: string) {
    const secret = decryptSecret(user.totpSecret);
    if (secret) {
      const step = verifyTotp(secret, code, user.totpLastStep);
      if (step !== null) {
        tenants.directory.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id)).run();
        return true;
      }
    }
    const hash = hashRecoveryCode(code);
    if (user.recoveryHashes.includes(hash)) {
      tenants.directory.update(users).set({ recoveryHashes: user.recoveryHashes.filter((h) => h !== hash) }).where(eq(users.id, user.id)).run();
      return true;
    }
    return false;
  }

  app.get('/api/auth/status', async (request) => {
    const user = userOf(request);
    const asked = Number(request.headers['x-ledger']);
    const role = user && Number.isInteger(asked) && asked !== user.id ? tenants.accessTo(user.id, asked) : null;
    const owner = role ? tenants.find(asked) : undefined;
    const viewing = role && owner && !owner.disabled && !owner.pending ? { ownerId: owner.id, username: owner.username, role } : null;
    return { authRequired: true, demo: false, multiUser: true, signup: tenants.signupMode(), authenticated: Boolean(user), username: user?.username ?? null, isAdmin: user?.role === 'admin', role: user ? 'owner' : null, twoFactor: Boolean(user?.totpEnabled), email: canSendMail(config), address: user?.email ?? null, legal: readLegal(tenants.directory).enabled, viewing };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { username, password, code } = z.object({ username: z.string().max(60), password: z.string().max(200), code: z.string().max(40).optional() }).parse(request.body);
    // A name that has been guessed at too often is paused, whoever is asking.
    if (loginBlocked(username)) {
      recordFailure({ kind: 'paused', username: tenants.findByName(username)?.username ?? null, ip: request.ip });
      return reply.code(429).send({ error: 'Too many wrong passwords. Try again in a few minutes.' });
    }
    const user = tenants.findByName(username);
    const ok = await checkPassword(user, password);
    if (!user || !ok || user.disabled) {
      recordFailure({ kind: user ? 'wrong_password' : 'unknown_name', username: user?.username ?? null, ip: request.ip });
      loginFailed(username);
      return reply.code(401).send({ error: 'Incorrect username or password' });
    }
    if (!user.emailVerified) return reply.code(403).send({ error: 'Confirm your email address first. The link was sent when you signed up.', code: 'verify_email' });
    if (user.pending) return reply.code(403).send({ error: 'Your account is waiting for an administrator to approve it.' });
    if (user.totpEnabled) {
      // The password was right. Now the code from the phone, or one of the recovery codes.
      if (!code) return reply.code(401).send({ error: 'Enter the 6-digit code from your authenticator app', code: 'two_factor' });
      if (!useSecondFactor(user, code)) {
        recordFailure({ kind: 'wrong_code', username: user.username, ip: request.ip });
        loginFailed(username);
        return reply.code(401).send({ error: 'That code is not right, or has already been used', code: 'two_factor' });
      }
    }
    loginSucceeded(username);
    tenants.directory.update(users).set({ lastLoginAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();

    const now = new Date();
    tenants.directory.delete(userSessions).where(lt(userSessions.expiresAt, now.toISOString())).run();
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    tenants.directory.insert(userSessions).values({ tokenHash: hashToken(token), userId: user.id, expiresAt: expires.toISOString() }).run();
    return reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: cookieSecure, expires }).send({ authenticated: true, username: user.username, isAdmin: user.role === 'admin' });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[COOKIE];
    if (token) tenants.directory.delete(userSessions).where(eq(userSessions.tokenHash, hashToken(token))).run();
    return reply.clearCookie(COOKIE, { path: '/' }).send({ authenticated: false });
  });

  // ---- Creating your own account ------------------------------------------------

  app.get('/api/auth/challenge', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => issueChallenge());

  app.post('/api/auth/signup', { config: { rateLimit: { max: config.signupRate, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = z
      .object({ username: z.string().max(60), password: z.string().max(200), code: z.string().max(40).optional(), email: z.string().max(200).optional(), accept: z.boolean().optional(), challenge: z.string().max(600), nonce: z.string().max(40), website: z.string().max(200).optional() })
      .parse(request.body);
    // A field people never see: a form-filling robot fills it in.
    if (body.website) return reply.code(400).send({ error: 'Sign-up failed' });
    if (readLegal(tenants.directory).enabled && body.accept !== true) throw new DomainError('invalid', 'Please agree to the terms and privacy pages to create an account');
    if (!verifyChallenge(body.challenge, body.nonce)) throw new DomainError('invalid', 'The check before sign-up did not pass. Reload the page and try again.');
    const { user, pending } = await tenants.register({ username: body.username, password: body.password, code: body.code, email: body.email });
    if (readLegal(tenants.directory).enabled) tenants.directory.update(users).set({ termsAcceptedAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();
    if (!user.emailVerified) {
      await sendVerification(user, user.email!);
      return reply.code(202).send({ pending, verify: true });
    }
    if (pending) return reply.code(202).send({ pending: true });
    // Signed in straight away.
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    tenants.directory.insert(userSessions).values({ tokenHash: hashToken(token), userId: user.id, expiresAt: expires.toISOString() }).run();
    return reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: cookieSecure, expires }).code(201).send({ authenticated: true, username: user.username });
  });

  // ---- Email: confirming an address and forgotten passwords ---------------------------------

  const linkBase = () => config.publicUrl ?? '';
  const resetFingerprint = (user: UserRow) => signValue(`fp:${user.passwordHash}`).slice(0, 16);

  async function sendVerification(user: UserRow, email: string) {
    const token = makeToken('verify', user.id, 3 * 86_400_000, '', email);
    await sendMail(config, {
      to: email,
      subject: 'Confirm your email address for Ledgerly',
      text: `Hello ${user.username},\n\nConfirm this email address to finish setting up your Ledgerly account:\n\n${linkBase()}/verify?token=${token}\n\nThe link works for 3 days. If you did not sign up, ignore this message and nothing will happen.\n`,
    }).catch(() => {});
  }

  // Someone typing an address in should not learn whether it has an account, nor be able to flood it.
  const lastSent = new Map<string, number>();
  const cooledDown = (key: string) => {
    const now = Date.now();
    if (now - (lastSent.get(key) ?? 0) < 60_000) return false;
    lastSent.set(key, now);
    return true;
  };
  const byEmail = z.object({ email: z.string().max(200) });
  const mailLimit = { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } };

  app.post('/api/auth/verify', mailLimit, async (request, reply) => {
    const { token } = z.object({ token: z.string().max(800) }).parse(request.body);
    const read = readToken(token, 'verify');
    const user = read && tenants.find(read.userId);
    if (!read || !user || !read.data) throw new DomainError('invalid', 'This link has expired or is not valid. Ask for a new one.');
    const taken = tenants.findByEmail(read.data);
    if (taken && taken.id !== user.id) throw new DomainError('conflict', 'That email address is already used by another account');
    tenants.directory.update(users).set({ email: read.data, emailVerified: true }).where(eq(users.id, user.id)).run();
    return reply.code(200).send({ confirmed: true, pending: user.pending });
  });

  app.post('/api/auth/resend', mailLimit, async (request, reply) => {
    const { email } = byEmail.parse(request.body);
    const user = canSendMail(config) ? tenants.findByEmail(email) : undefined;
    if (user && !user.emailVerified && cooledDown(`v:${user.id}`)) await sendVerification(user, user.email!);
    return reply.code(204).send();
  });

  app.post('/api/auth/forgot', mailLimit, async (request, reply) => {
    const { email } = byEmail.parse(request.body);
    const user = canSendMail(config) ? tenants.findByEmail(email) : undefined;
    if (user && user.emailVerified && !user.disabled && !user.pending && cooledDown(`r:${user.id}`)) {
      const token = makeToken('reset', user.id, 60 * 60_000, resetFingerprint(user));
      await sendMail(config, {
        to: user.email!,
        subject: 'Reset your Ledgerly password',
        text: `Hello ${user.username},\n\nSomeone asked to reset the password for your Ledgerly account. To choose a new one, open:\n\n${linkBase()}/reset?token=${token}\n\nThe link works for one hour and only once. If this was not you, ignore this message: your password has not changed. Your books are not touched either way${user.totpEnabled ? ', and you will still need your authenticator code to sign in' : ''}.\n`,
      }).catch(() => {});
    }
    return reply.code(204).send();
  });

  app.post('/api/auth/reset', mailLimit, async (request, reply) => {
    const { token, password } = z.object({ token: z.string().max(800), password: z.string().max(200) }).parse(request.body);
    const read = readToken(token, 'reset');
    const user = read && tenants.find(read.userId);
    if (!read || !user || user.disabled || read.fingerprint !== resetFingerprint(user)) throw new DomainError('invalid', 'This link has expired or has already been used. Ask for a new one.');
    await tenants.setPassword(user.id, password);
    loginSucceeded(user.username);
    return reply.code(204).send();
  });

  // ---- Accounts ------------------------------------------------------------

  const requireAdmin = (request: FastifyRequest) => {
    if (request.user?.role !== 'admin') throw Object.assign(new Error('Only an administrator can do that'), { statusCode: 403 });
  };
  const present = (u: UserRow) => ({ id: u.id, username: u.username, role: u.role, disabled: u.disabled, pending: u.pending, createdAt: u.createdAt, holdsFirstBooks: u.dataPath === '', twoFactor: u.totpEnabled, email: u.email, emailVerified: u.emailVerified });
  const idParams = z.object({ id: z.coerce.number().int().positive() });

  app.get('/api/users', async (request) => {
    requireAdmin(request);
    return tenants.list().map(present);
  });

  app.post('/api/users', async (request, reply) => {
    requireAdmin(request);
    const body = z.object({ username: z.string(), password: z.string(), role: z.enum(['admin', 'user']).default('user') }).parse(request.body);
    const tenant = await tenants.create(body);
    return reply.code(201).send(present(tenants.find(tenant.id)!));
  });

  app.patch('/api/users/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const body = z.object({ disabled: z.boolean().optional(), role: z.enum(['admin', 'user']).optional(), password: z.string().optional(), approve: z.boolean().optional() }).parse(request.body);
    if (id === request.user!.id && (body.disabled || body.role === 'user')) throw new DomainError('conflict', 'You cannot lock yourself out. Ask another administrator.');
    if (body.approve) tenants.approve(id);
    tenants.update(id, { disabled: body.disabled, role: body.role });
    if (body.password !== undefined) await tenants.setPassword(id, body.password);
    return reply.code(204).send();
  });

  app.delete('/api/users/:id', async (request, reply) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    const { confirm } = z.object({ confirm: z.string() }).parse(request.body ?? {});
    const user = tenants.find(id);
    if (!user) throw new DomainError('not_found', 'No such user');
    if (confirm !== user.username) throw new DomainError('invalid', 'Type the username to confirm. This deletes all of their books and files.');
    await tenants.remove(id);
    return reply.code(204).send();
  });

  // ---- What the administrator sees of the site ---------------------------------------------

  app.get('/api/legal', async () => {
    const legal = readLegal(tenants.directory);
    return legal.enabled ? legal : { enabled: false, terms: '', privacy: '' };
  });

  app.get('/api/admin/legal', async (request) => {
    requireAdmin(request);
    return { ...readLegal(tenants.directory), templates: { terms: TERMS_TEMPLATE, privacy: PRIVACY_TEMPLATE } };
  });

  app.put('/api/admin/legal', async (request, reply) => {
    requireAdmin(request);
    const body = z.object({ enabled: z.boolean(), terms: z.string().max(60_000), privacy: z.string().max(60_000) }).parse(request.body);
    if (body.enabled && (!body.terms.trim() || !body.privacy.trim())) throw new DomainError('invalid', 'Write both pages before asking people to agree to them');
    if (body.enabled && /\[(YOUR|DATE|EMAIL)/i.test(`${body.terms}${body.privacy}`)) throw new DomainError('invalid', 'The pages still have [PLACEHOLDERS] to fill in');
    saveLegal(tenants.directory, body);
    return reply.code(204).send();
  });

  app.get('/api/admin/overview', async (request) => {
    requireAdmin(request);
    const all = tenants.list();
    const now = Date.now();
    const day = (iso: string) => iso.slice(0, 10);
    const signups = new Map<string, number>();
    for (let i = 13; i >= 0; i--) signups.set(day(new Date(now - i * 86_400_000).toISOString()), 0);
    for (const u of all) if (signups.has(day(u.createdAt))) signups.set(day(u.createdAt), signups.get(day(u.createdAt))! + 1);

    // Space each person's books take, with the first administrator's being whatever the others do not.
    const people = all.filter((u) => u.dataPath !== '');
    const sizes = await Promise.all(people.map(async (u) => ({ id: u.id, bytes: await storageUsed({ dataDir: tenants.dataDirOf(u) }, true) })));
    const total = await storageUsed({ dataDir: config.dataDir }, true);
    const others = sizes.reduce((sum, s) => sum + s.bytes, 0);
    const bytes = new Map(sizes.map((s) => [s.id, s.bytes]));
    for (const u of all) if (u.dataPath === '') bytes.set(u.id, Math.max(0, total - others));

    return {
      counts: {
        total: all.length,
        active: all.filter((u) => !u.disabled && !u.pending && u.emailVerified).length,
        waiting: all.filter((u) => u.pending).length,
        unconfirmed: all.filter((u) => !u.emailVerified).length,
        disabled: all.filter((u) => u.disabled).length,
        administrators: all.filter((u) => u.role === 'admin' && !u.disabled).length,
        twoFactor: all.filter((u) => u.totpEnabled).length,
      },
      signupMode: tenants.signupMode(),
      mailOn: canSendMail(config),
      openLedgers: tenants.openCount,
      totalBytes: total,
      quotaBytes: config.quotaBytes || null,
      signups: [...signups].map(([date, count]) => ({ date, count })),
      people: all
        .map((u) => ({ id: u.id, username: u.username, role: u.role, bytes: bytes.get(u.id) ?? 0, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, twoFactor: u.totpEnabled, status: u.disabled ? 'disabled' : u.pending ? 'waiting' : !u.emailVerified ? 'unconfirmed' : 'active' }))
        .sort((a, b) => b.bytes - a.bytes),
      failures: recentFailures(40),
    };
  });

  app.get('/api/admin/signup', async (request) => {
    requireAdmin(request);
    return { mode: tenants.signupMode(), invites: tenants.listInvites() };
  });
  app.put('/api/admin/signup', async (request, reply) => {
    requireAdmin(request);
    tenants.setSignupMode(z.object({ mode: z.enum(['closed', 'invite', 'approval', 'open']) }).parse(request.body).mode);
    return reply.code(204).send();
  });
  app.post('/api/invites', async (request, reply) => {
    requireAdmin(request);
    const body = z.object({ role: z.enum(['admin', 'user']).default('user'), note: z.string().max(100).optional(), days: z.number().int().min(1).max(60).default(7) }).parse(request.body ?? {});
    return reply.code(201).send(tenants.createInvite({ ...body, createdBy: request.user!.id }));
  });
  app.delete('/api/invites/:id', async (request, reply) => {
    requireAdmin(request);
    tenants.revokeInvite(idParams.parse(request.params).id);
    return reply.code(204).send();
  });

  // Anyone can close their own account, which removes their books and files for good.
  app.post('/api/account/delete', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { password, confirm } = z.object({ password: z.string().max(200), confirm: z.string().max(60) }).parse(request.body);
    const user = request.user!;
    if (confirm !== user.username) throw new DomainError('invalid', 'Type your username to confirm');
    if (!(await checkPassword(user, password))) throw new DomainError('invalid', 'The password is not right');
    if (user.dataPath === '') throw new DomainError('conflict', 'This account holds the books that were here first, and is closed by whoever runs the server');
    if (user.role === 'admin' && tenants.list().filter((u) => u.role === 'admin' && !u.disabled).length <= 1) throw new DomainError('conflict', 'You are the only administrator. Make someone else one first.');
    tenants.update(user.id, { disabled: true });
    await tenants.remove(user.id);
    return reply.clearCookie(COOKIE, { path: '/' }).code(204).send();
  });

  // ---- Letting others into your books ------------------------------------------------------

  app.get('/api/shares', async (request) => ({
    granted: tenants.sharedBy(request.user!.id),
    received: tenants.sharedWith(request.user!.id),
  }));

  app.post('/api/shares', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { username, role } = z.object({ username: z.string().max(60), role: z.enum(['editor', 'viewer']) }).parse(request.body);
    const member = tenants.grantAccess(request.user!.id, username, role);
    return reply.code(201).send({ memberId: member.id, username: member.username, role });
  });

  // The owner takes access back, or the person let in gives it up.
  app.delete('/api/shares/:memberId', async (request, reply) => {
    const { memberId } = z.object({ memberId: z.coerce.number().int().positive() }).parse(request.params);
    tenants.revokeAccess(request.user!.id, memberId);
    return reply.code(204).send();
  });

  app.delete('/api/shares/received/:ownerId', async (request, reply) => {
    const { ownerId } = z.object({ ownerId: z.coerce.number().int().positive() }).parse(request.params);
    tenants.revokeAccess(ownerId, request.user!.id);
    return reply.code(204).send();
  });

  // Changing the address a person gets mail at: it changes once they open the link sent to the new one.
  app.post('/api/account/email', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { email, password } = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(request.body);
    const user = request.user!;
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address)) throw new DomainError('invalid', 'That does not look like an email address');
    if (!(await checkPassword(user, password))) throw new DomainError('invalid', 'The password is not right');
    if (tenants.findByEmail(address)) throw new DomainError('conflict', 'That email address is already used');
    if (!canSendMail(config)) {
      tenants.directory.update(users).set({ email: address }).where(eq(users.id, user.id)).run();
      return reply.code(200).send({ changed: true });
    }
    await sendVerification(user, address);
    return reply.code(200).send({ changed: false, sentTo: address });
  });

  // ---- Two-step sign-in -----------------------------------------------------------

  const limited = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } };

  // Makes a secret for the person to put in their authenticator app. Nothing is switched on until a code from the app is shown to work.
  app.post('/api/account/2fa/setup', limited, async (request) => {
    const { password } = z.object({ password: z.string().max(200) }).parse(request.body);
    const user = request.user!;
    if (user.totpEnabled) throw new DomainError('conflict', 'Two-step sign-in is already on');
    if (!(await checkPassword(user, password))) throw new DomainError('invalid', 'The password is not right');
    const secret = newTotpSecret();
    tenants.directory.update(users).set({ totpSecret: encryptSecret(secret), totpLastStep: 0 }).where(eq(users.id, user.id)).run();
    const uri = otpauthUri('Ledgerly', user.username, secret);
    return { secret, uri, qr: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 192 }) };
  });

  app.post('/api/account/2fa/enable', limited, async (request) => {
    const { code } = z.object({ code: z.string().max(20) }).parse(request.body);
    const user = request.user!;
    const secret = decryptSecret(user.totpSecret);
    if (user.totpEnabled || !secret) throw new DomainError('conflict', 'Start the set-up first');
    const step = verifyTotp(secret, code, 0);
    if (step === null) throw new DomainError('invalid', 'That code is not right. Check the time on your phone and try the next one.');
    const recovery = newRecoveryCodes();
    tenants.directory
      .update(users)
      .set({ totpEnabled: true, totpLastStep: step, recoveryHashes: recovery.map(hashRecoveryCode) })
      .where(eq(users.id, user.id))
      .run();
    return { recoveryCodes: recovery };
  });

  app.post('/api/account/2fa/disable', limited, async (request, reply) => {
    const { password, code } = z.object({ password: z.string().max(200), code: z.string().max(40) }).parse(request.body);
    const user = request.user!;
    if (!user.totpEnabled) return reply.code(204).send();
    if (!(await checkPassword(user, password))) throw new DomainError('invalid', 'The password is not right');
    if (!useSecondFactor(user, code)) throw new DomainError('invalid', 'That code is not right');
    tenants.directory.update(users).set({ totpEnabled: false, totpSecret: null, totpLastStep: 0, recoveryHashes: [] }).where(eq(users.id, user.id)).run();
    return reply.code(204).send();
  });

  // For someone who has lost their phone and their recovery codes.
  app.post('/api/users/:id/2fa/reset', async (request, reply) => {
    requireAdmin(request);
    const { id } = idParams.parse(request.params);
    if (!tenants.find(id)) throw new DomainError('not_found', 'No such user');
    tenants.directory.update(users).set({ totpEnabled: false, totpSecret: null, totpLastStep: 0, recoveryHashes: [] }).where(eq(users.id, id)).run();
    tenants.directory.delete(userSessions).where(eq(userSessions.userId, id)).run();
    return reply.code(204).send();
  });

  // Anyone can change their own password, which signs them out elsewhere.
  app.post('/api/account/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { current, next } = z.object({ current: z.string().max(200), next: z.string().max(200) }).parse(request.body);
    const user = request.user!;
    if (!(await checkPassword(user, current))) throw new DomainError('invalid', 'The current password is not right');
    await tenants.setPassword(user.id, next);
    // A new session for this browser, so changing it does not log you out of here.
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    tenants.directory.insert(userSessions).values({ tokenHash: hashToken(token), userId: user.id, expiresAt: expires.toISOString() }).run();
    return reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: cookieSecure, expires }).code(204).send();
  });
}

