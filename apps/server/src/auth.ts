import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sessions, type Db } from '@ledgerly/db';
import { eq, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';

const COOKIE = 'ledgerly_session';
const SESSION_DAYS = 30;
const PUBLIC_ROUTES = new Set(['/api/health', '/api/auth/status', '/api/auth/login']);

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function passwordChecker(password: string) {
  const salt = randomBytes(16);
  const expected = scryptSync(password, salt, 32);
  return (candidate: string) => timingSafeEqual(scryptSync(candidate, salt, 32), expected);
}

function hostnameOf(value: string) {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

// Who is asking: the role of a valid session, or null when there is none.
export function sessionRole(db: Db, request: FastifyRequest) {
  const token = request.cookies[COOKIE];
  if (!token) return null;
  const session = db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .get();
  return session && session.expiresAt > new Date().toISOString() ? session.role : null;
}

export function registerAuth(app: FastifyInstance, db: Db, config: Config) {
  const { authPassword, viewerPassword, allowedHosts, cookieSecure, demoMode } = config;
  const checkPassword = authPassword ? passwordChecker(authPassword) : undefined;
  const checkViewer = viewerPassword ? passwordChecker(viewerPassword) : undefined;

  app.addHook('onRequest', async (request, reply) => {
    // With no login, a hostile site could rebind its domain to this machine and
    // read the API, so only known hostnames are served.
    if (!authPassword && !demoMode && !allowedHosts.includes(hostnameOf(request.headers.host ?? '') ?? '')) {
      return reply.code(403).send({ error: 'Host not allowed' });
    }

    const { origin } = request.headers;
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (!isRead && origin) {
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = undefined;
      }
      if (originHost !== request.headers.host) {
        return reply.code(403).send({ error: 'Cross-origin request blocked' });
      }
    }

    const path = request.url.split('?')[0] ?? '';
    if (authPassword && path.startsWith('/api/') && !PUBLIC_ROUTES.has(path)) {
      const role = sessionRole(db, request);
      if (!role) {
        return reply.code(401).send({ error: 'Login required' });
      }
      if (role === 'viewer') {
        // A viewer reads. The full database copy and the agent tokens are not for looking at.
        if (!isRead && path !== '/api/auth/logout') return reply.code(403).send({ error: 'This login is read-only' });
        if (path.startsWith('/api/backups') || path.startsWith('/api/agents')) return reply.code(403).send({ error: 'This login is read-only' });
      }
    }
  });

  app.get('/api/auth/status', async (request) => ({
    authRequired: Boolean(authPassword),
    demo: demoMode,
    authenticated: !authPassword || sessionRole(db, request) !== null,
    role: authPassword ? sessionRole(db, request) : 'owner',
  }));

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!checkPassword) return reply.code(400).send({ error: 'Login is not enabled' });

      const { password } = z.object({ password: z.string().max(200) }).parse(request.body);
      // Both are always checked, so how long it takes does not say which one was close.
      const isOwner = checkPassword(password);
      const isViewer = checkViewer ? checkViewer(password) : false;
      if (!isOwner && !isViewer) {
        return reply.code(401).send({ error: 'Incorrect password' });
      }
      const role = isOwner ? ('owner' as const) : ('viewer' as const);

      const now = new Date();
      db.delete(sessions).where(lt(sessions.expiresAt, now.toISOString())).run();

      const token = randomBytes(32).toString('base64url');
      const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
      db.insert(sessions)
        .values({ tokenHash: hashToken(token), expiresAt: expires.toISOString(), role })
        .run();

      return reply
        .setCookie(COOKIE, token, {
          path: '/',
          httpOnly: true,
          sameSite: 'strict',
          secure: cookieSecure,
          expires,
        })
        .send({ authenticated: true, role });
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[COOKIE];
    if (token) db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
    return reply.clearCookie(COOKIE, { path: '/' }).send({ authenticated: false });
  });
}
