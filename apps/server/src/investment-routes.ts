import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  sipPlans,
  applyPrices,
  commitInvestmentImport,
  discardInvestmentImport,
  DomainError,
  extractPdfText,
  getHoldings,
  getInvestmentImport,
  getInvestmentSample,
  listInvestmentImports,
  listInvestmentSamples,
  parseAmfiNav,
  stageInvestmentStatement,
  undoInvestmentImport,
} from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { assertRoom } from './quota.ts';
import { autoPricesOn, lastAutoPrices, refreshPrices, setAutoPrices } from './prices.ts';
import { readExport } from './uploads.ts';
import { readPdf } from './pdf-read.ts';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export function registerInvestmentRoutes(app: FastifyInstance, db: Db, config: Config) {
  const documentsDirOf = () => join(config.dataDir, 'documents');

  app.get('/api/investments', async () => getHoldings(db));
  app.get('/api/investments/sips', async () => sipPlans(db));

  app.post('/api/investments/imports', async (request, reply) => {
    if (config.demoMode) {
      throw new DomainError('invalid', 'Uploads are turned off in demo mode. Try a sample statement instead.');
    }
    let upload: { buffer: Buffer; filename: string } | undefined;
    let password: string | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') upload = { buffer: await part.toBuffer(), filename: basename(part.filename || 'statement.pdf') };
      else if (part.fieldname === 'password' && part.value) password = String(part.value);
    }
    if (!upload) throw new DomainError('invalid', 'Choose a PDF statement to upload');
    const isPdf = upload.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
    const exported = isPdf ? null : await readExport(upload.buffer);
    if (!isPdf && exported === null) throw new DomainError('invalid', 'Upload a PDF statement, or a CSV export of your holdings');

    await assertRoom(config, upload.buffer.length);
    const sha256 = createHash('sha256').update(upload.buffer).digest('hex');
    const storedName = `${sha256}.${isPdf ? 'pdf' : exported!.ext}`;
    const storedPath = join(documentsDirOf(), storedName);
    const alreadyStored = existsSync(storedPath);
    if (!alreadyStored) {
      await mkdir(documentsDirOf(), { recursive: true, mode: 0o700 });
      await writeFile(storedPath, upload.buffer, { mode: 0o600 });
    }
    try {
      const text = exported?.text ?? (await readPdf(storedPath, config.watchPasswords, password));
      const staged = stageInvestmentStatement(db, {
        text,
        file: { sha256, filename: upload.filename.slice(0, 200), mimeType: isPdf ? 'application/pdf' : exported!.mime, size: upload.buffer.length, storedName },
      });
      return reply.code(201).send(staged);
    } catch (error) {
      if (!alreadyStored) await rm(storedPath, { force: true });
      throw error;
    }
  });

  if (config.demoMode) {
    app.get('/api/demo/investment-samples', async () => listInvestmentSamples());
    app.post('/api/demo/investment-samples/:id', async (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const sample = getInvestmentSample(id);
      if (!sample) throw new DomainError('not_found', 'No such sample statement');
      return reply.code(201).send(stageInvestmentStatement(db, sample));
    });
  }

  app.get('/api/investments/imports', async () => listInvestmentImports(db));
  app.get('/api/investments/imports/:id', async (request) => getInvestmentImport(db, idParams.parse(request.params).id));

  app.post('/api/investments/imports/:id/commit', async (request) => {
    const { accountId } = z.object({ accountId: z.number().int().positive().optional() }).parse(request.body ?? {});
    return commitInvestmentImport(db, idParams.parse(request.params).id, { accountId });
  });

  app.post('/api/investments/imports/:id/undo', async (request) => undoInvestmentImport(db, idParams.parse(request.params).id));

  app.delete('/api/investments/imports/:id', async (request, reply) => {
    const storedName = discardInvestmentImport(db, idParams.parse(request.params).id);
    if (storedName && !storedName.startsWith('sample-')) await rm(join(documentsDirOf(), storedName), { force: true });
    return reply.code(204).send();
  });

  // Fetches the public daily price file. Nothing about you is sent.
  app.post('/api/investments/prices', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async () => {
    if (config.demoMode) throw new DomainError('invalid', 'Price updates are turned off in demo mode');
    return refreshPrices(db, config);
  });

  app.get('/api/investments/auto-prices', async () => ({ on: autoPricesOn(db), last: lastAutoPrices(db) }));
  app.put('/api/investments/auto-prices', async (request, reply) => {
    if (config.demoMode) throw new DomainError('invalid', 'Price updates are turned off in demo mode');
    setAutoPrices(db, z.object({ on: z.boolean() }).parse(request.body).on);
    return reply.code(204).send();
  });
}
