import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  applyAllRules,
  applyRule,
  assignAccount,
  commitBatch,
  createRule,
  deleteRule,
  discardBatch,
  DomainError,
  extractPdfText,
  getImportBatch,
  getSampleStatement,
  listImportBatches,
  listRules,
  listSampleStatements,
  previewRule,
  suggestRules,
  uncategorizedPayees,
  refreshSuggestions,
  runAutoRules,
  stageStatement,
  stagedPatchSchema,
  undoBatch,
  updateRule,
  updateStagedRow,
} from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { assertRoom } from './quota.ts';
import { readExport } from './uploads.ts';
import { readPdf } from './pdf-read.ts';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const rowParams = z.object({ rowId: z.coerce.number().int().positive() });

export function registerImportRoutes(app: FastifyInstance, db: Db, config: Config) {
  const documentsDirOf = () => join(config.dataDir, 'documents');

  app.post('/api/imports', async (request, reply) => {
    // A public demo should not store files from strangers.
    if (config.demoMode) {
      throw new DomainError('invalid', 'Uploads are turned off in demo mode. Try a sample statement instead.');
    }

    let upload: { buffer: Buffer; filename: string } | undefined;
    let accountId: number | undefined;
    let password: string | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        upload = { buffer: await part.toBuffer(), filename: basename(part.filename || 'statement.pdf') };
      } else if (part.fieldname === 'accountId' && part.value) {
        accountId = z.coerce.number().int().positive().parse(part.value);
      } else if (part.fieldname === 'password' && part.value) {
        password = String(part.value);
      }
    }

    if (!upload) throw new DomainError('invalid', 'Choose a PDF statement to upload');
    const isPdf = upload.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
    const exported = isPdf ? null : await readExport(upload.buffer);
    if (!isPdf && exported === null) throw new DomainError('invalid', 'Upload a PDF statement or a CSV download');

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
      const batch = stageStatement(db, {
        text,
        accountId,
        file: {
          sha256,
          filename: upload.filename.slice(0, 200),
          mimeType: isPdf ? 'application/pdf' : exported!.mime,
          size: upload.buffer.length,
          storedName,
        },
      });
      return reply.code(201).send(batch);
    } catch (error) {
      if (!alreadyStored) await rm(storedPath, { force: true });
      throw error;
    }
  });

  if (config.demoMode) {
    app.get('/api/demo/samples', async () => listSampleStatements());

    app.post('/api/demo/samples/:id', async (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const sample = getSampleStatement(id);
      if (!sample) throw new DomainError('not_found', 'No such sample statement');
      return reply.code(201).send(stageStatement(db, sample));
    });
  }

  app.get('/api/imports', async () => listImportBatches(db));

  app.get('/api/imports/:id', async (request) => {
    return getImportBatch(db, idParams.parse(request.params).id);
  });

  app.patch('/api/imports/:id', async (request) => {
    const { accountId } = z.object({ accountId: z.number().int().positive() }).parse(request.body);
    return assignAccount(db, idParams.parse(request.params).id, accountId);
  });

  app.patch('/api/imports/rows/:rowId', async (request) => {
    return updateStagedRow(db, rowParams.parse(request.params).rowId, stagedPatchSchema.parse(request.body));
  });

  app.post('/api/imports/:id/suggestions', async (request) => {
    return refreshSuggestions(db, idParams.parse(request.params).id);
  });

  app.post('/api/imports/:id/commit', async (request) => {
    const { acceptMismatch } = z
      .object({ acceptMismatch: z.boolean().optional() })
      .parse(request.body ?? {});
    const batch = commitBatch(db, idParams.parse(request.params).id, { acceptMismatch });
    // New data may be enough to learn a rule from.
    return { ...batch, autoRules: runAutoRules(db) };
  });

  app.post('/api/imports/:id/undo', async (request) => {
    return undoBatch(db, idParams.parse(request.params).id);
  });

  app.delete('/api/imports/:id', async (request, reply) => {
    const storedName = discardBatch(db, idParams.parse(request.params).id);
    if (storedName && !storedName.startsWith('sample-')) {
      await rm(join(documentsDirOf(), storedName), { force: true });
    }
    return reply.code(204).send();
  });

  app.get('/api/rules', async () => listRules(db));

  app.get('/api/rules/suggestions', async () => suggestRules(db));

  app.get('/api/rules/payees', async () => uncategorizedPayees(db));

  app.post('/api/rules', async (request, reply) => {
    return reply.code(201).send(createRule(db, request.body as never));
  });

  app.patch('/api/rules/:id', async (request) => {
    return updateRule(db, idParams.parse(request.params).id, request.body as never);
  });

  app.post('/api/rules/preview', async (request) => {
    const input = z.object({ pattern: z.string().max(200), matchType: z.enum(['contains', 'regex']).default('contains') });
    return previewRule(db, input.parse(request.body));
  });

  app.post('/api/rules/apply', async () => applyAllRules(db));

  app.post('/api/rules/:id/apply', async (request) => applyRule(db, idParams.parse(request.params).id));

  app.delete('/api/rules/:id', async (request, reply) => {
    deleteRule(db, idParams.parse(request.params).id);
    return reply.code(204).send();
  });
}
