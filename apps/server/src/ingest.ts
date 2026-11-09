import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError, extractPdfText, stageAnyStatement } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { Config } from './config.ts';
import { readPdf } from './pdf-read.ts';
import { assertRoom } from './quota.ts';
import { readExport } from './uploads.ts';

export type IngestResult = { outcome: 'staged' | 'already' | 'held'; note?: string };

// One statement that arrived by itself (from the watched folder or from email):
// kept as a document, read, and staged. It never imports anything; the caller
// imports what is safe once all of a batch is staged.
export async function ingestStatement(db: Db, config: Config, input: { name: string; buffer: Buffer; passwords: string[] }): Promise<IngestResult> {
  const { name, buffer } = input;
  const isPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-';
  const exported = isPdf ? null : await readExport(buffer);
  if (!isPdf && exported === null) return { outcome: 'held', note: 'Not a PDF or a CSV export' };

  try {
    await assertRoom(config, buffer.length);
  } catch (error) {
    return { outcome: 'held', note: error instanceof Error ? error.message : 'Storage is full' };
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const storedName = `${sha256}.${isPdf ? 'pdf' : exported!.ext}`;
  const documentsDir = join(config.dataDir, 'documents');
  const stored = join(documentsDir, storedName);
  await mkdir(documentsDir, { recursive: true, mode: 0o700 });
  const fresh = !existsSync(stored);
  if (fresh) await writeFile(stored, buffer, { mode: 0o600 });

  try {
    const text = exported?.text ?? (await readPdf(stored, input.passwords));
    stageAnyStatement(db, { text, file: { sha256, filename: name.slice(0, 200), mimeType: isPdf ? 'application/pdf' : exported!.mime, size: buffer.length, storedName } });
    return { outcome: 'staged' };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'conflict') return { outcome: 'already', note: 'Already imported' };
    // A file that did not become a statement is not kept in the data folder.
    if (fresh) await rm(stored, { force: true });
    return { outcome: 'held', note: error instanceof Error ? error.message : 'Could not be read' };
  }
}
