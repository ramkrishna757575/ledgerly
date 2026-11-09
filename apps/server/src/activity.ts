import { listActivity, recordActivity } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { sessionRole } from './auth.ts';
import type { Config } from './config.ts';
import { tenantStore } from './tenants.ts';

// A change log of what people did in the app: every request that changes
// something, who made it, and whether it went through. Requests are recorded by
// their route and ids ("DELETE /api/transactions/:id"), never their contents.
export function registerActivity(app: FastifyInstance, db: Db, config: Config) {
  if (!config.demoMode) {
    app.addHook('onResponse', async (request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
      if (!path.startsWith('/api/') || path === '/api/auth/logout') return;
      const route = request.routeOptions?.url ?? path;
      const role = request.user?.username ?? (config.authPassword ? sessionRole(db, request) : 'local');
      const params = Object.entries((request.params as Record<string, string>) ?? {}).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ');
      const status = reply.statusCode;
      // This runs after the response, outside the request's own context, so say whose books.
      const write = () => recordActivity(db, {
        actor: role ?? 'anonymous',
        action: `${request.method} ${route}`,
        detail: [params, `status ${status}`].filter(Boolean).join(' · '),
        outcome: status < 400 ? 'ok' : status === 401 || status === 403 ? 'denied' : 'error',
      });
      if (request.tenant) tenantStore.run(request.tenant, write);
      // With several people, a request nobody has signed in for has no books to write to.
      else if (!config.multiUser) write();
    });
  }

  app.get('/api/activity', async () => listActivity(db, 200));
}
