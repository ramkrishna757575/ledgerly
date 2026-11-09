import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  compareReceipt,
  getTransaction,
  readReceipt,
  describeDestination,
  addAttachment,
  attachmentFileName,
  deleteAttachment,
  DomainError,
  getAttachment,
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  sniffType,
} from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { assertRoom } from './quota.ts';

const idParams = z.object({ id: z.coerce.number().int().positive() });

export function registerAttachmentRoutes(app: FastifyInstance, db: Db, config: Config) {
  const documentsDirOf = () => join(config.dataDir, 'documents');
  const present = (row: ReturnType<typeof listAttachments>[number]) => ({
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    url: `/api/attachments/${row.id}/file`,
  });

  app.get('/api/transactions/:id/attachments', async (request) => listAttachments(db, idParams.parse(request.params).id).map(present));

  app.post('/api/transactions/:id/attachments', async (request, reply) => {
    if (config.demoMode) throw new DomainError('invalid', 'Uploads are turned off in demo mode.');
    const { id } = idParams.parse(request.params);
    let upload: { buffer: Buffer; filename: string } | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') upload = { buffer: await part.toBuffer(), filename: basename(part.filename || 'receipt') };
    }
    if (!upload) throw new DomainError('invalid', 'Choose a file to attach');
    if (upload.buffer.length > MAX_ATTACHMENT_BYTES) throw new DomainError('invalid', 'That file is over 10 MB');
    const type = sniffType(upload.buffer);
    if (!type) throw new DomainError('invalid', 'Attach a PDF, PNG, JPEG or WebP file');

    await assertRoom(config, upload.buffer.length);
    const sha256 = createHash('sha256').update(upload.buffer).digest('hex');
    const storedName = attachmentFileName(sha256, type);
    const storedPath = join(documentsDirOf(), storedName);
    const fresh = !existsSync(storedPath);
    if (fresh) {
      await mkdir(documentsDirOf(), { recursive: true, mode: 0o700 });
      await writeFile(storedPath, upload.buffer, { mode: 0o600 });
    }
    try {
      const added = addAttachment(db, { transactionId: id, sha256, filename: upload.filename.slice(0, 200), type, size: upload.buffer.length });
      return reply.code(201).send(present(getAttachment(db, added.id)));
    } catch (error) {
      if (fresh) await rm(storedPath, { force: true });
      throw error;
    }
  });

  // The file as stored, shown in the browser. It is user-supplied content, so
  // it may not run anything or load anything else.
  app.get('/api/attachments/:id/file', async (request, reply) => {
    const row = getAttachment(db, idParams.parse(request.params).id);
    const path = join(documentsDirOf(), row.storedName);
    if (!existsSync(path)) throw new DomainError('not_found', 'The file is missing from disk');
    const { createReadStream } = await import('node:fs');
    return reply
      .header('Content-Type', row.mimeType)
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
      .send(createReadStream(path));
  });

  // Asks a vision model to read a receipt picture and says whether it agrees
  // with the transaction. It changes nothing, and only runs when pressed.
  app.post('/api/attachments/:id/read', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    if (!config.ai) throw new DomainError('invalid', config.demoMode ? 'The AI features are turned off in demo mode' : 'No AI provider is set up yet');
    const row = getAttachment(db, idParams.parse(request.params).id);
    if (row.mimeType !== 'image/png' && row.mimeType !== 'image/jpeg' && row.mimeType !== 'image/webp') {
      throw new DomainError('invalid', 'Only a picture can be read this way: PNG, JPEG or WebP.');
    }
    const path = join(documentsDirOf(), row.storedName);
    if (!existsSync(path)) throw new DomainError('not_found', 'The file is missing from disk');
    const { readFile } = await import('node:fs/promises');
    const read = await readReceipt(config.ai, { mediaType: row.mimeType, base64: (await readFile(path)).toString('base64') });
    const tx = getTransaction(db, row.transactionId);
    const amount = Math.max(...tx.postings.map((p) => Math.abs(p.amount)));
    return {
      read,
      comparison: compareReceipt(read, { date: tx.date, amount, payee: tx.payee, description: tx.description }),
      transaction: { date: tx.date, description: tx.payee ?? tx.description, amount },
      destination: describeDestination(config.ai),
    };
  });

  app.delete('/api/attachments/:id', async (request, reply) => {
    const storedName = deleteAttachment(db, idParams.parse(request.params).id);
    if (storedName) await rm(join(documentsDirOf(), storedName), { force: true });
    return reply.code(204).send();
  });
}
