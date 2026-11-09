import { ALERT_KINDS, DIGEST_MODES, DomainError, getDigestMode, setDigestMode, getAlertKinds, getAlertLog, pendingAlerts, setAlertKinds, type AlertKind } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { inboxState, scanInbox } from './inbox.ts';
import { mailState, scanMail } from './mail.ts';
import { nextRun } from './scheduler.ts';
import { tenantStore } from './tenants.ts';
import { addStoredChannel, allChannels, deliver, describeStored, removeStoredChannel, storedChannels } from './notify.ts';

export function registerAlertRoutes(app: FastifyInstance, db: Db, config: Config) {
  app.get('/api/alerts', async () => ({
    // Only where messages go, never the address or token.
    channels: allChannels(db, config).map((c) => ({ id: c.id, label: c.label, host: c.host })),
    // The ones this person added, which they can remove. Never the address or token.
    own: storedChannels(db).map(describeStored),
    kinds: Object.entries(ALERT_KINDS).map(([kind, label]) => ({ kind, label, enabled: getAlertKinds(db).includes(kind as AlertKind) })),
    waiting: pendingAlerts(db).length,
    digest: getDigestMode(db),
    log: getAlertLog(db),
  }));

  app.post('/api/alerts/channels', async (request, reply) => {
    if (config.demoMode) throw new DomainError('invalid', 'Alerts are turned off in demo mode');
    const body = z.object({ kind: z.enum(['ntfy', 'telegram', 'webhook']), url: z.string().max(500).optional(), token: z.string().max(200).optional(), chat: z.string().max(100).optional() }).parse(request.body);
    return reply.code(201).send(describeStored(await addStoredChannel(db, config, body)));
  });
  app.delete('/api/alerts/channels/:id', async (request, reply) => {
    removeStoredChannel(db, z.object({ id: z.string().max(40) }).parse(request.params).id);
    return reply.code(204).send();
  });

  app.get('/api/inbox', async () => inboxState(db, config));
  app.post('/api/inbox/scan', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async () => {
    if (!config.watchDir) throw new DomainError('invalid', 'No inbox folder is set up');
    return (await scanInbox(db, config)) ?? { results: [], lastImport: null };
  });

  app.get('/api/mail', async () => ({ ...mailState(db, config), nextCheck: nextRun(tenantStore.getStore()?.id ?? 0, 'mail') }));
  app.post('/api/mail/scan', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async () => {
    if (!config.mail) throw new DomainError('invalid', 'No mailbox is set up');
    return (await scanMail(db, config)) ?? { results: [], lastImport: null, error: null };
  });

  app.put('/api/alerts/kinds', async (request, reply) => {
    const { kinds } = z.object({ kinds: z.array(z.enum(Object.keys(ALERT_KINDS) as [AlertKind, ...AlertKind[]])) }).parse(request.body);
    setAlertKinds(db, kinds);
    return reply.code(204).send();
  });

  app.put('/api/alerts/digest', async (request, reply) => {
    setDigestMode(db, z.object({ mode: z.enum(DIGEST_MODES) }).parse(request.body).mode);
    return reply.code(204).send();
  });

  app.post('/api/alerts/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async () => {
    const channels = allChannels(db, config);
    if (channels.length === 0) throw new DomainError('invalid', 'No way to send messages is set up yet');
    return deliver(db, channels, 'Ledgerly test', 'If you can read this, alerts will reach you here.', ['Test message']);
  });
}
