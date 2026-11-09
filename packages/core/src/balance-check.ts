import { accounts, importBatches, postings, transactions, type Db } from '@ledgerly/db';
import { and, eq, min, sql } from 'drizzle-orm';
import { getBalances, getOrCreateOpeningBalances } from './accounts.ts';
import { DomainError } from './errors.ts';
import { createTransaction } from './transactions.ts';

// A statement states the balance on its last day. If the books disagree, an
// earlier statement is missing or the account had money before the first one
// imported, and everything built on balances (net worth, idle cash) is off.
// Only the newest statement of each account is compared, since that is the
// balance that matters now.
export function statementBalanceChecks(db: Db) {
  const batches = db
    .select()
    .from(importBatches)
    .where(eq(importBatches.status, 'committed'))
    .all()
    .filter((b) => b.accountId !== null && b.closingBalance !== null && b.periodEnd !== null);

  const latest = new Map<number, (typeof batches)[number]>();
  for (const batch of batches) {
    const current = latest.get(batch.accountId!);
    if (!current || batch.periodEnd! > current.periodEnd!) latest.set(batch.accountId!, batch);
  }

  const results = [];
  for (const [accountId, batch] of latest) {
    const account = getBalances(db, { asOf: batch.periodEnd! }).find((a) => a.id === accountId);
    if (!account || account.isArchived) continue;
    const difference = batch.closingBalance! - account.balance;
    if (difference === 0) continue;
    results.push({
      accountId,
      accountName: account.name,
      type: account.type as 'asset' | 'liability',
      asOf: batch.periodEnd!,
      statement: batch.closingBalance!,
      ledger: account.balance,
      difference,
    });
  }
  return results;
}

// Adds the missing amount as an opening balance dated just before the account's
// first transaction, so nothing in the history moves and the balance on the
// statement's date comes out right.
export function matchStatementBalance(db: Db, accountId: number) {
  const check = statementBalanceChecks(db).find((c) => c.accountId === accountId);
  if (!check) throw new DomainError('not_found', 'That account already matches its statement');

  const first = db
    .select({ date: min(transactions.date) })
    .from(postings)
    .innerJoin(transactions, eq(transactions.id, postings.transactionId))
    .where(eq(postings.accountId, accountId))
    .get()?.date;
  const day = new Date(Date.parse(`${first ?? check.asOf}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  const sign = check.type === 'asset' ? 1 : -1;
  const equity = getOrCreateOpeningBalances(db);
  createTransaction(db, {
    date: day,
    description: `Balance carried in to match the ${check.asOf} statement`,
    source: 'opening_balance',
    postings: [
      { accountId, amount: check.difference * sign },
      { accountId: equity.id, amount: -check.difference * sign },
    ],
  });
  return check;
}
