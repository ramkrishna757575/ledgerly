import { complete, describeDestination, DomainError, monthlySummaryEnabled, setMonthlySummary } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { clearAi, clearMail, describeAi, describeMail, readAi, readMail, readWatch, saveAi, saveMail, saveWatch } from './ledger-settings.ts';
import { testMailbox } from './mail.ts';
import { canSendMail } from './mailer.ts';
import { storageUsed } from './quota.ts';
import { tenantStore, touchSettings } from './tenants.ts';

// A person's own settings for their own books. Keys and passwords are written
// but never read back out: only whether one is set.
export function registerSettingsRoutes(app: FastifyInstance, db: Db, config: Config) {
  const changed = () => touchSettings(tenantStore.getStore());
  const notDemo = () => {
    if (config.demoMode) throw new DomainError('invalid', 'Settings are turned off in demo mode');
  };

  app.get('/api/settings', async () => {
    const watch = readWatch(db);
    return {
      usage: { used: await storageUsed(config, true), quota: config.quotaBytes || null },
      restricted: config.restrictOutbound,
      ai: { own: describeAi(db), usingServerDefault: !describeAi(db) && config.ai !== null, destination: config.ai ? describeDestination(config.ai) : null, model: config.ai?.model ?? null, provider: config.ai?.provider ?? null },
      mail: { own: describeMail(db), usingServerDefault: !describeMail(db) && config.mail !== undefined },
      summary: { enabled: monthlySummaryEnabled(db), email: tenantStore.getStore()?.emailOf?.() ?? null, canSend: canSendMail(config) },
      watch: { enabled: Boolean(config.watchDir), own: watch.enabled, folder: config.watchDir ?? null, passwords: watch.passwords.length },
    };
  });

  app.put('/api/settings/ai', async (request, reply) => {
    notDemo();
    await saveAi(db, request.body as never, config.restrictOutbound);
    changed();
    return reply.code(204).send();
  });
  app.delete('/api/settings/ai', async (_request, reply) => {
    clearAi(db);
    changed();
    return reply.code(204).send();
  });
  app.post('/api/settings/ai/test', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async () => {
    const ai = readAi(db) ?? config.ai;
    if (!ai) throw new DomainError('invalid', 'No AI provider is set up yet');
    const started = Date.now();
    const answer = await complete(ai, { system: 'Reply with the single word OK.', user: 'Test.', maxTokens: 20 });
    return { ok: true, reply: answer.slice(0, 40), milliseconds: Date.now() - started, destination: describeDestination(ai) };
  });

  app.put('/api/settings/mail', async (request, reply) => {
    notDemo();
    await saveMail(db, request.body as never, config.restrictOutbound);
    changed();
    return reply.code(204).send();
  });
  app.delete('/api/settings/mail', async (_request, reply) => {
    clearMail(db);
    changed();
    return reply.code(204).send();
  });
  app.post('/api/settings/mail/test', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async () => {
    const mail = readMail(db) ?? config.mail;
    if (!mail) throw new DomainError('invalid', 'No mailbox is set up yet');
    return testMailbox(mail);
  });

  app.put('/api/settings/summary', async (request, reply) => {
    notDemo();
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    if (enabled && !tenantStore.getStore()?.emailOf?.()) throw new DomainError('invalid', 'Add your email address first');
    setMonthlySummary(db, enabled);
    return reply.code(204).send();
  });

  app.put('/api/settings/watch', async (request, reply) => {
    notDemo();
    saveWatch(db, z.object({ enabled: z.boolean().optional(), passwords: z.array(z.string().max(200)).max(10).optional() }).parse(request.body));
    changed();
    return reply.code(204).send();
  });
}
