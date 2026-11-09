import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { DomainError } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { registerAuth } from './auth.ts';
import { registerAlertRoutes } from './alert-routes.ts';
import { registerAnalysisRoutes } from './analysis-routes.ts';
import { registerActivity } from './activity.ts';
import { registerAgentRoutes } from './agent-routes.ts';
import { registerAttachmentRoutes } from './attachment-routes.ts';
import { registerBackupRoutes } from './backup-routes.ts';
import type { Config } from './config.ts';
import { registerMultiAuth } from './multi-auth.ts';
import { tenantConfig, tenantDb, tenantStore, type Tenant, type Tenants } from './tenants.ts';
import { registerImportRoutes } from './import-routes.ts';
import { registerInvestmentRoutes } from './investment-routes.ts';
import { registerSettingsRoutes } from './settings-routes.ts';
import { registerStatementRoutes } from './statement-routes.ts';
import { registerRoutes } from './routes.ts';

const STATUS_BY_CODE = { invalid: 400, not_found: 404, conflict: 409, password_required: 422, wrong_password: 422 };

export async function buildApp(defaultDb: Db, baseConfig: Config, options: { logger?: boolean; tenants?: Tenants } = {}) {
  // With several people, every route is written as before but is handed whichever
  // person's books the request belongs to.
  const { tenants } = options;
  const db = tenantDb(defaultDb);
  const config = tenantConfig(baseConfig);
  // With one person, they are simply the only tenant: the same code path, the same per-person settings.
  const solo: Tenant | undefined = tenants ? undefined : { id: 0, username: '', isAdmin: true, db: defaultDb, dataDir: baseConfig.dataDir };
  // The few lines of script written into the page itself are allowed by their
  // hash. Nothing else may run, load from elsewhere or frame the app.
  const hashes: string[] = [];
  try {
    const html = readFileSync(join(baseConfig.webDir, 'index.html'), 'utf8');
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) hashes.push(`'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`);
  } catch {
    // No built app to serve, as in most tests.
  }
  const csp = ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim(), "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');

  const app = Fastify({ logger: options.logger ?? false, trustProxy: baseConfig.trustProxy });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // A file someone uploaded is served with a stricter policy of its own.
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', csp);
    if (baseConfig.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid input', issues: error.issues });
    }
    if (error instanceof DomainError) {
      return reply.code(STATUS_BY_CODE[error.code]).send({ error: error.message, code: error.code });
    }
    const { statusCode, message } = error as { statusCode?: number; message: string };
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: message });

    request.log.error(error);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  if (solo) app.addHook('onRequest', (_request, _reply, done) => tenantStore.run(solo, done));
  if (tenants) registerMultiAuth(app, tenants, baseConfig);
  else registerAuth(app, db, config);
  registerActivity(app, db, config);
  registerRoutes(app, db, config);
  registerImportRoutes(app, db, config);
  registerAgentRoutes(app, db, config, tenants ? (id) => { const user = tenants.find(id); return user && !user.disabled ? tenants.tenantFor(user) : undefined; } : undefined);
  registerInvestmentRoutes(app, db, config);
  registerBackupRoutes(app, db, config);
  registerAttachmentRoutes(app, db, config);
  registerAnalysisRoutes(app, db, config);
  registerAlertRoutes(app, db, config);
  registerStatementRoutes(app, db, config);
  registerSettingsRoutes(app, db, config);

  const hasWebBuild = existsSync(config.webDir);
  if (hasWebBuild) await app.register(fastifyStatic, { root: config.webDir });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    // Page routes fall back to the app. A missing file must stay a 404, or a
    // stale script URL would come back as HTML and fail with a confusing error.
    const isPage = !path.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(path);
    if (hasWebBuild && request.method === 'GET' && isPage) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });

  return app;
}
