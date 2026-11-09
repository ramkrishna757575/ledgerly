import { attachments, documents, importBatches, investmentImports, transactions, type Db } from '@ledgerly/db';
import { and, eq, inArray } from 'drizzle-orm';
import { DomainError } from './errors.ts';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EXTENSION = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
export type AttachmentType = keyof typeof EXTENSION;

// What a file really is, from its first bytes. The name and the type the
// browser reports are whatever the sender chose to say.
export function sniffType(bytes: Uint8Array): AttachmentType | null {
  const starts = (...signature: number[]) => signature.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

export const attachmentFileName = (sha256: string, type: AttachmentType) => `${sha256}.${EXTENSION[type]}`;

export function addAttachment(
  db: Db,
  input: { transactionId: number; sha256: string; filename: string; type: AttachmentType; size: number },
) {
  if (!db.select({ id: transactions.id }).from(transactions).where(eq(transactions.id, input.transactionId)).get()) {
    throw new DomainError('not_found', `Transaction ${input.transactionId} not found`);
  }
  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    const document =
      store.select().from(documents).where(eq(documents.sha256, input.sha256)).get() ??
      store
        .insert(documents)
        .values({ sha256: input.sha256, filename: input.filename, mimeType: input.type, size: input.size, storedName: attachmentFileName(input.sha256, input.type) })
        .returning()
        .get();
    const already = store
      .select()
      .from(attachments)
      .where(and(eq(attachments.transactionId, input.transactionId), eq(attachments.documentId, document.id)))
      .get();
    if (already) throw new DomainError('conflict', 'That file is already attached to this transaction');
    const row = store.insert(attachments).values({ transactionId: input.transactionId, documentId: document.id }).returning().get();
    return { id: row.id, storedName: document.storedName };
  });
}

const columns = {
  id: attachments.id,
  transactionId: attachments.transactionId,
  filename: documents.filename,
  mimeType: documents.mimeType,
  size: documents.size,
  storedName: documents.storedName,
  createdAt: attachments.createdAt,
};

export function listAttachments(db: Db, transactionId: number) {
  return db.select(columns).from(attachments).innerJoin(documents, eq(documents.id, attachments.documentId)).where(eq(attachments.transactionId, transactionId)).all();
}

export function getAttachment(db: Db, id: number) {
  const row = db.select(columns).from(attachments).innerJoin(documents, eq(documents.id, attachments.documentId)).where(eq(attachments.id, id)).get();
  if (!row) throw new DomainError('not_found', 'No such attachment');
  return row;
}

export function attachmentCounts(db: Db, transactionIds: number[]) {
  if (transactionIds.length === 0) return new Map<number, number>();
  const counts = new Map<number, number>();
  for (const row of db.select({ id: attachments.transactionId }).from(attachments).where(inArray(attachments.transactionId, transactionIds)).all()) {
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  }
  return counts;
}

// Removes the attachment, and the file too when nothing else uses it. Returns
// the stored name to delete from disk, or null when the file is still in use.
export function deleteAttachment(db: Db, id: number) {
  const row = getAttachment(db, id);
  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    store.delete(attachments).where(eq(attachments.id, id)).run();
    const doc = store.select().from(documents).where(eq(documents.storedName, row.storedName)).get()!;
    const used =
      store.select({ id: attachments.id }).from(attachments).where(eq(attachments.documentId, doc.id)).get() ||
      store.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.documentId, doc.id)).get() ||
      store.select({ id: investmentImports.id }).from(investmentImports).where(eq(investmentImports.documentId, doc.id)).get();
    if (used) return null;
    store.delete(documents).where(eq(documents.id, doc.id)).run();
    return row.storedName;
  });
}

// Files no longer used by any attachment or import, which is what is left
// behind when a transaction with receipts is deleted. Returns their stored
// names so the files can be removed from disk.
export function pruneOrphanDocuments(db: Db) {
  const names: string[] = [];
  for (const doc of db.select().from(documents).all()) {
    const used =
      db.select({ id: attachments.id }).from(attachments).where(eq(attachments.documentId, doc.id)).get() ||
      db.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.documentId, doc.id)).get() ||
      db.select({ id: investmentImports.id }).from(investmentImports).where(eq(investmentImports.documentId, doc.id)).get();
    if (used) continue;
    db.delete(documents).where(eq(documents.id, doc.id)).run();
    names.push(doc.storedName);
  }
  return names;
}
