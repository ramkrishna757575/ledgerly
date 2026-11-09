import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { commitReadyImports, createPayslip, learnParser, deletePayslip, dryRunCommitReady, DomainError, extractPdfText, listPayslips, parsePayslipText, stageAnyStatement } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { assertRoom } from './quota.ts';
import { readExport } from './uploads.ts';
import { readPdf } from './pdf-read.ts';

// For a pile of statements: one upload that works out whether each is a bank,
// card or investment statement, and one call that imports the ones that are
// safe to import without a look.
export function registerStatementRoutes(app: FastifyInstance, db: Db, config: Config) {
  const documentsDirOf = () => join(config.dataDir, 'documents');

  app.post('/api/statements', async (request, reply) => {
    if (config.demoMode) throw new DomainError('invalid', 'Uploads are turned off in demo mode.');

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
      const staged = stageAnyStatement(db, {
        text,
        file: { sha256, filename: upload.filename.slice(0, 200), mimeType: isPdf ? 'application/pdf' : exported!.mime, size: upload.buffer.length, storedName },
      });
      return reply.code(201).send({ ...staged, filename: upload.filename });
    } catch (error) {
      if (!alreadyStored) await rm(storedPath, { force: true });
      throw error;
    }
  });

  // For a statement in a layout nobody has written a reader for: a model works out a
  // recipe from this one, and it is kept for every later statement from that bank.
  app.post('/api/statements/learn', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request) => {
    if (config.demoMode) throw new DomainError('invalid', 'Uploads are turned off in demo mode.');
    if (!config.ai) throw new DomainError('invalid', 'No AI provider is set up yet');
    let buffer: Buffer | undefined;
    let password: string | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') buffer = await part.toBuffer();
      else if (part.fieldname === 'password' && part.value) password = String(part.value);
    }
    if (!buffer || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new DomainError('invalid', 'Choose the statement as a PDF');
    const work = await mkdtemp(join(tmpdir(), 'ledgerly-learn-'));
    try {
      const file = join(work, 'statement.pdf');
      await writeFile(file, buffer, { mode: 0o600 });
      const text = await readPdf(file, config.watchPasswords, password);
      return await learnParser(db, config.ai, text);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  // What importing would do, without doing it.
  app.post('/api/statements/preview-ready', async () => {
    if (config.demoMode) throw new DomainError('invalid', 'Imports are turned off in demo mode.');
    return dryRunCommitReady(db);
  });

  app.post('/api/statements/commit-ready', async () => {
    if (config.demoMode) throw new DomainError('invalid', 'Imports are turned off in demo mode.');
    return commitReadyImports(db);
  });

  // A payslip is read for its numbers and the file is not kept: it carries identity numbers the books have no use for.
  app.post('/api/payslips/read', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (request) => {
    if (config.demoMode) throw new DomainError('invalid', 'Uploads are turned off in demo mode.');
    let buffer: Buffer | undefined;
    let password: string | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') buffer = await part.toBuffer();
      else if (part.fieldname === 'password' && part.value) password = String(part.value);
    }
    if (!buffer || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new DomainError('invalid', 'Choose the payslip as a PDF');
    const work = await mkdtemp(join(tmpdir(), 'ledgerly-payslip-'));
    try {
      const file = join(work, 'payslip.pdf');
      await writeFile(file, buffer, { mode: 0o600 });
      let text: string | undefined;
      // The password given, or the ones saved for locked statements.
      for (const attempt of [password, ...(password ? [] : [undefined, ...config.watchPasswords])]) {
        try {
          text = await extractPdfText(file, { password: attempt });
          break;
        } catch (error) {
          if (!(error instanceof DomainError) || (error.code !== 'password_required' && error.code !== 'wrong_password')) throw error;
          if (password) throw error;
        }
      }
      if (text === undefined) throw new DomainError('password_required', 'This PDF is password protected. Enter its password to read it.');
      return parsePayslipText(text);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  app.get('/api/payslips', async () => listPayslips(db));
  app.post('/api/payslips', async (request, reply) => reply.code(201).send(createPayslip(db, request.body as never)));
  app.delete('/api/payslips/:id', async (request, reply) => {
    deletePayslip(db, z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id);
    return reply.code(204).send();
  });
}
