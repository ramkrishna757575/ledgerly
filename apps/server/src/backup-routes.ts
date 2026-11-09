import { createReadStream } from 'node:fs';
import { DomainError, capitalGainsCsv, exportTransactionsCsv, fySchema } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { taxPackWorkbook } from './taxpack.ts';
import { copyOffsite, offsiteState, verifyBackup } from './offsite.ts';
import { tenantStore } from './tenants.ts';
import { backupPath, BACKUP_KEEP, createBackup, deleteBackup, listBackups } from './backup.ts';
import type { Config } from './config.ts';

const nameParams = z.object({ name: z.string().max(100) });
const rangeQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });

export function registerBackupRoutes(app: FastifyInstance, db: Db, config: Config) {
  app.get('/api/backups', async () => ({
    enabled: !config.demoMode,
    keep: config.backupKeep,
    items: await listBackups(config),
  }));

  app.post('/api/backups', async (_request, reply) => {
    const made = await createBackup(db, config);
    const label = tenantStore.getStore()?.username || 'main';
    await copyOffsite(db, config, label, made.name);
    await verifyBackup(db, config, made.name);
    return reply.code(201).send(made);
  });

  app.get('/api/backups/status', async () => offsiteState(db, config));
  // Opens the newest backup in a scratch copy and checks it could be restored.
  app.post('/api/backups/verify', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async () => verifyBackup(db, config));
  app.post('/api/backups/offsite', { config: { rateLimit: { max: 6, timeWindow: '10 minutes' } } }, async () => {
    const [latest] = await listBackups(config);
    if (!latest) throw new DomainError('not_found', 'There is no backup to copy yet');
    if (!config.offsite) throw new DomainError('invalid', 'No copy destination is set up');
    return copyOffsite(db, config, tenantStore.getStore()?.username || 'main', latest.name);
  });

  app.get('/api/backups/:name', async (request, reply) => {
    const { name } = nameParams.parse(request.params);
    return reply
      .header('Content-Type', name.endsWith('.enc') ? 'application/octet-stream' : 'application/gzip')
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(createReadStream(backupPath(config, name)));
  });

  app.delete('/api/backups/:name', async (request, reply) => {
    await deleteBackup(config, nameParams.parse(request.params).name);
    return reply.code(204).send();
  });

  app.get('/api/export/transactions.csv', async (request, reply) => {
    const range = rangeQuery.parse(request.query);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="ledgerly-transactions.csv"')
      .send(exportTransactionsCsv(db, range));
  });

  app.get('/api/export/capital-gains.csv', async (request, reply) => {
    const { fy } = z.object({ fy: fySchema }).parse(request.query);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="ledgerly-capital-gains-${fy}.csv"`)
      .send(capitalGainsCsv(db, fy));
  });

  app.get('/api/export/tax-pack.xlsx', async (request, reply) => {
    const { fy } = z.object({ fy: fySchema }).parse(request.query);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="ledgerly-tax-pack-${fy}.xlsx"`)
      .send(await taxPackWorkbook(db, fy));
  });
}
