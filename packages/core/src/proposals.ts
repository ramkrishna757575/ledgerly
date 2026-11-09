import {
  accounts,
  importBatches,
  proposals,
  stagedTransactions,
  type Db,
  type ProposalKind,
} from '@ledgerly/db';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from './errors.ts';
import { updateStagedRow } from './imports/batches.ts';
import { createRule, validateRule } from './imports/rules.ts';
import { previewCategoryChange, setTransactionCategory } from './transactions.ts';

const MAX_ITEMS = 100;
const reasonSchema = z.string().trim().max(500).optional();
const id = z.number().int().positive();

export const transactionProposalSchema = z.object({
  items: z.array(z.object({ transactionId: id, categoryId: id, reason: reasonSchema })).min(1).max(MAX_ITEMS),
});
export const importRowProposalSchema = z.object({
  items: z.array(z.object({ rowId: id, categoryId: id, reason: reasonSchema })).min(1).max(MAX_ITEMS),
});
export const ruleProposalSchema = z.object({
  pattern: z.string().trim().min(2).max(200),
  matchType: z.enum(['contains', 'regex']).default('contains'),
  categoryId: id,
  reason: reasonSchema,
});

type Payload = Record<string, number | string | null>;

// A second suggestion for the same thing replaces the first instead of piling up.
function upsert(db: Db, kind: ProposalKind, source: string, payload: Payload, reason: string | undefined, sameTarget: (p: Payload) => boolean) {
  const open = db
    .select()
    .from(proposals)
    .where(and(eq(proposals.kind, kind), eq(proposals.status, 'pending')))
    .all()
    .find((p) => sameTarget(p.payload as Payload));
  if (open) {
    return db
      .update(proposals)
      .set({ payload, reason: reason ?? null, source })
      .where(eq(proposals.id, open.id))
      .returning()
      .get();
  }
  return db.insert(proposals).values({ kind, payload, reason: reason ?? null, source }).returning().get();
}

// Each item is checked now, so a bad one is reported to the agent straight away
// and never reaches you. The rest of the batch still goes through.
export function proposeTransactionCategories(db: Db, source: string, input: z.input<typeof transactionProposalSchema>) {
  const { items } = transactionProposalSchema.parse(input);
  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    return items.map((item) => {
      try {
        const { from, to } = previewCategoryChange(store, item.transactionId, item.categoryId);
        if (from.id === to.id) throw new DomainError('invalid', `Already in ${to.name}`);
        const created = upsert(
          store,
          'categorize_transaction',
          source,
          { transactionId: item.transactionId, categoryId: item.categoryId, fromCategoryId: from.id },
          item.reason,
          (p) => p.transactionId === item.transactionId,
        );
        return { transactionId: item.transactionId, proposalId: created.id };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return { transactionId: item.transactionId, error: error.message };
      }
    });
  });
}

export function proposeImportRowCategories(db: Db, source: string, input: z.input<typeof importRowProposalSchema>) {
  const { items } = importRowProposalSchema.parse(input);
  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    return items.map((item) => {
      try {
        const row = store.select().from(stagedTransactions).where(eq(stagedTransactions.id, item.rowId)).get();
        if (!row) throw new DomainError('not_found', `Import row ${item.rowId} not found`);
        const batch = store.select().from(importBatches).where(eq(importBatches.id, row.batchId)).get();
        if (batch?.status !== 'staged') throw new DomainError('conflict', 'That import is already finished');
        if (row.status !== 'pending') throw new DomainError('conflict', `That row is ${row.status}`);
        const category = store.select().from(accounts).where(eq(accounts.id, item.categoryId)).get();
        if (!category || category.isArchived || category.type === 'equity') {
          throw new DomainError('invalid', 'Choose a category or an account');
        }
        if (row.categoryId === item.categoryId) throw new DomainError('invalid', `Already in ${category.name}`);
        const created = upsert(
          store,
          'categorize_import_row',
          source,
          { rowId: item.rowId, categoryId: item.categoryId, fromCategoryId: row.categoryId },
          item.reason,
          (p) => p.rowId === item.rowId,
        );
        return { rowId: item.rowId, proposalId: created.id };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        return { rowId: item.rowId, error: error.message };
      }
    });
  });
}

export function proposeRule(db: Db, source: string, input: z.input<typeof ruleProposalSchema>) {
  const { reason, ...rule } = ruleProposalSchema.parse(input);
  validateRule(db, rule);
  const created = upsert(
    db,
    'create_rule',
    source,
    { pattern: rule.pattern, matchType: rule.matchType, categoryId: rule.categoryId },
    reason,
    (p) => String(p.pattern).toLowerCase() === rule.pattern.toLowerCase() && p.matchType === rule.matchType,
  );
  return { proposalId: created.id };
}

type Target = { date: string; description: string; payee: string | null; amount: number; account: string | null };

const categoryName = (db: Db, categoryId: unknown) =>
  typeof categoryId === 'number'
    ? (db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, categoryId)).get()?.name ?? null)
    : null;

// A proposal as the person reviewing it needs to see it, with names, not ids.
function describe(db: Db, row: typeof proposals.$inferSelect) {
  const payload = row.payload as Payload;
  let target: Target | null = null;

  if (row.kind === 'categorize_transaction') {
    try {
      const { transaction, moneySide } = previewCategoryChange(db, Number(payload.transactionId), Number(payload.categoryId));
      target = {
        date: transaction.date,
        description: transaction.description,
        payee: transaction.payee,
        amount: moneySide.amount,
        account: moneySide.accountName,
      };
    } catch {
      target = null;
    }
  } else if (row.kind === 'categorize_import_row') {
    const staged = db.select().from(stagedTransactions).where(eq(stagedTransactions.id, Number(payload.rowId))).get();
    if (staged) {
      target = { date: staged.date, description: staged.description, payee: staged.payee, amount: staged.amount, account: null };
    }
  }

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    source: row.source,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    error: row.error,
    target,
    from: categoryName(db, payload.fromCategoryId),
    to: categoryName(db, payload.categoryId),
    rule: row.kind === 'create_rule' ? { pattern: String(payload.pattern), matchType: String(payload.matchType) } : null,
  };
}

export function listProposals(db: Db, options: { status?: 'pending' | 'approved' | 'rejected' | 'failed'; limit?: number } = {}) {
  const rows = db
    .select()
    .from(proposals)
    .where(options.status ? eq(proposals.status, options.status) : undefined)
    .orderBy(options.status === 'pending' ? asc(proposals.id) : desc(proposals.id))
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500))
    .all();
  return rows.map((row) => describe(db, row));
}

export function countPendingProposals(db: Db) {
  return db.select({ id: proposals.id }).from(proposals).where(eq(proposals.status, 'pending')).all().length;
}

function getPending(db: Db, proposalId: number) {
  const row = db.select().from(proposals).where(eq(proposals.id, proposalId)).get();
  if (!row) throw new DomainError('not_found', `Suggestion ${proposalId} not found`);
  if (row.status !== 'pending') throw new DomainError('conflict', `That suggestion was already ${row.status}`);
  return row;
}

// Approving applies the change through the same rules as a change made by hand,
// and refuses if what it would change has moved on since it was suggested.
function apply(db: Db, row: typeof proposals.$inferSelect) {
  const payload = row.payload as Payload;
  if (row.kind === 'categorize_transaction') {
    const { from } = previewCategoryChange(db, Number(payload.transactionId), Number(payload.categoryId));
    if (from.id !== payload.fromCategoryId) {
      throw new DomainError('conflict', `Changed to ${from.name} after this was suggested`);
    }
    setTransactionCategory(db, Number(payload.transactionId), Number(payload.categoryId));
  } else if (row.kind === 'categorize_import_row') {
    const staged = db.select().from(stagedTransactions).where(eq(stagedTransactions.id, Number(payload.rowId))).get();
    if (!staged) throw new DomainError('not_found', 'That import row no longer exists');
    if (staged.categoryId !== payload.fromCategoryId) {
      throw new DomainError('conflict', 'Its category was changed after this was suggested');
    }
    updateStagedRow(db, staged.id, { categoryId: Number(payload.categoryId) });
  } else {
    createRule(db, { pattern: String(payload.pattern), matchType: payload.matchType as 'contains' | 'regex', categoryId: Number(payload.categoryId) });
  }
}

export function approveProposal(db: Db, proposalId: number) {
  const row = getPending(db, proposalId);
  try {
    db.transaction((tx) => apply(tx as unknown as Db, row));
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    db.update(proposals)
      .set({ status: 'failed', error: error.message, decidedAt: new Date().toISOString() })
      .where(eq(proposals.id, proposalId))
      .run();
    return describe(db, db.select().from(proposals).where(eq(proposals.id, proposalId)).get()!);
  }
  const done = db
    .update(proposals)
    .set({ status: 'approved', decidedAt: new Date().toISOString() })
    .where(eq(proposals.id, proposalId))
    .returning()
    .get();
  return describe(db, done);
}

export function rejectProposal(db: Db, proposalId: number) {
  getPending(db, proposalId);
  const done = db
    .update(proposals)
    .set({ status: 'rejected', decidedAt: new Date().toISOString() })
    .where(eq(proposals.id, proposalId))
    .returning()
    .get();
  return describe(db, done);
}

export function decideAll(db: Db, decision: 'approve' | 'reject', ids?: number[]) {
  const pending = db
    .select({ id: proposals.id })
    .from(proposals)
    .where(ids ? and(eq(proposals.status, 'pending'), inArray(proposals.id, ids)) : eq(proposals.status, 'pending'))
    .orderBy(asc(proposals.id))
    .all();
  const outcome = { done: 0, failed: 0 };
  for (const { id: proposalId } of pending) {
    const result = decision === 'approve' ? approveProposal(db, proposalId) : rejectProposal(db, proposalId);
    if (result.status === 'failed') outcome.failed += 1;
    else outcome.done += 1;
  }
  return outcome;
}
