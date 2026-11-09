import { documents, importBatches, investmentImports, stagedTransactions, type Db } from '@ledgerly/db';
import { and, asc, eq } from 'drizzle-orm';
import { getBalances } from '../accounts.ts';
import { DomainError } from '../errors.ts';
import { commitInvestmentImport, getInvestmentImport, stageInvestmentStatement } from '../investments/portfolio.ts';
import { detectInvestmentAdapter } from '../investments/registry.ts';
import { assignAccount, commitBatch, refreshSuggestions, stageStatement, type StoredFile } from './batches.ts';
import { learnedAdapters } from './learned.ts';
import { detectAdapter } from './registry.ts';

export type Staged = { kind: 'bank'; id: number } | { kind: 'investment'; id: number };

// A statement of either kind, for people who have a folder of them and should
// not have to say which is which. Accounts that do not exist yet are created.
export function stageAnyStatement(db: Db, input: { text: string; file: StoredFile }): Staged {
  if (detectAdapter(input.text, learnedAdapters(db))) return { kind: 'bank', id: stageStatement(db, { ...input, createAccount: true }).id };
  if (detectInvestmentAdapter(input.text)) return { kind: 'investment', id: stageInvestmentStatement(db, input).id };
  throw new DomainError('invalid', 'This statement format is not supported yet');
}

export type CommitReadyResult = {
  imported: { kind: 'bank' | 'investment'; id: number; filename: string }[];
  held: { kind: 'bank' | 'investment'; id: number; filename: string; reason: string }[];
};

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : 'Could not be imported');

// Imports every waiting statement that is safe to import without a look, oldest
// first so balances and valuations build up in order. A statement is left for
// review when its transactions do not add up to its own totals, when it has no
// account, or when something in it needs a decision. Rows already imported from
// an overlapping statement are left out.
export function commitReadyImports(db: Db): CommitReadyResult {
  const result: CommitReadyResult = { imported: [], held: [] };

  const banks = db
    .select({ batch: importBatches })
    .from(importBatches)
    .where(eq(importBatches.status, 'staged'))
    .orderBy(asc(importBatches.periodStart), asc(importBatches.id))
    .all();
  for (const { batch } of banks) {
    const filename = batchFilename(db, batch.documentId);
    try {
      if (batch.accountId === null) throw new DomainError('invalid', 'No account matched this statement. Choose one in the review.');
      // Re-check for rows an earlier statement in this run has just brought in.
      assignAccount(db, batch.id, batch.accountId);
      refreshSuggestions(db, batch.id);
      commitBatch(db, batch.id);
      result.imported.push({ kind: 'bank', id: batch.id, filename });
    } catch (error) {
      const reason = reasonOf(error);
      result.held.push({
        kind: 'bank',
        id: batch.id,
        filename,
        reason: /no transactions left|nothing left/i.test(reason)
          ? 'Everything in it was already imported from another statement.'
          : /each card payment/i.test(reason)
            ? 'It pays a credit card that is not set up yet. Import that card\'s statement or add the card on the Accounts page, then import again.'
            : reason,
      });
    }
  }

  const funds = db
    .select({ row: investmentImports })
    .from(investmentImports)
    .where(eq(investmentImports.status, 'staged'))
    .orderBy(asc(investmentImports.asOf), asc(investmentImports.id))
    .all();
  for (const { row } of funds) {
    const detail = getInvestmentImport(db, row.id);
    try {
      const gap = detail.statedTotal === null ? 0 : Math.abs(detail.statedTotal - detail.total);
      if (gap > Math.max(5_000, Math.abs(detail.statedTotal ?? 0) * 0.001)) {
        throw new DomainError('conflict', "The funds don't add up to the statement's own total, so something may be misread.");
      }
      commitInvestmentImport(db, row.id);
      result.imported.push({ kind: 'investment', id: row.id, filename: detail.filename });
    } catch (error) {
      result.held.push({ kind: 'investment', id: row.id, filename: detail.filename, reason: reasonOf(error) });
    }
  }
  return result;
}

function batchFilename(db: Db, documentId: number) {
  return db.select({ filename: documents.filename }).from(documents).where(eq(documents.id, documentId)).get()?.filename ?? 'statement';
}

class Rollback extends Error {
  result: unknown;
  constructor(result: unknown) {
    super('rollback');
    this.result = result;
  }
}

export type DryRun = {
  imported: (CommitReadyResult['imported'][number] & { transactions?: number; moneyIn?: number; moneyOut?: number; holdings?: number })[];
  held: CommitReadyResult['held'];
  balances: { accountName: string; before: number; after: number }[];
};

// Exactly what importing everything that is ready would do, worked out by doing
// it and then undoing it: the same checks, the same rows left out as duplicates,
// the same account balances. Nothing is saved.
export function dryRunCommitReady(db: Db): DryRun {
  const before = new Map(getBalances(db).map((b) => [b.id, b.balance]));
  try {
    db.transaction((tx) => {
      const store = tx as unknown as Db;
      const done = commitReadyImports(store);
      const imported = done.imported.map((item) => {
        if (item.kind === 'investment') return { ...item, holdings: getInvestmentImport(store, item.id).holdings.length };
        const rows = store.select().from(stagedTransactions).where(and(eq(stagedTransactions.batchId, item.id), eq(stagedTransactions.status, 'committed'))).all();
        return {
          ...item,
          transactions: rows.length,
          moneyIn: rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0),
          moneyOut: rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0),
        };
      });
      const balances = getBalances(store)
        .filter((b) => b.balance !== (before.get(b.id) ?? 0) && (b.type === 'asset' || b.type === 'liability'))
        .map((b) => ({ accountName: b.name, before: before.get(b.id) ?? 0, after: b.balance }));
      throw new Rollback({ imported, held: done.held, balances } satisfies DryRun);
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result as DryRun;
    throw error;
  }
  throw new Error('unreachable');
}
