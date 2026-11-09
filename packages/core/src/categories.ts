import { accounts, budgets, postings, rules, stagedTransactions, type Db } from '@ledgerly/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { assertNotProtected, createAccount, getAccount, UNCATEGORIZED } from './accounts.ts';
import { DomainError } from './errors.ts';

export const categoryTypeSchema = z.enum(['income', 'expense']);

export function createCategory(db: Db, input: { name: string; type: 'income' | 'expense' }) {
  return createAccount(db, { name: input.name, type: categoryTypeSchema.parse(input.type) });
}

// Every income and spending category with what depends on it, so it is clear
// what a rename, merge or delete would touch.
export function listCategories(db: Db) {
  return db.all<{
    id: number;
    name: string;
    type: 'income' | 'expense';
    isArchived: number;
    transactions: number;
    total: number;
    rules: number;
    budget: number | null;
  }>(sql`
    SELECT a.id AS id, a.name AS name, a.type AS type, a.is_archived AS isArchived,
      (SELECT COUNT(DISTINCT p.transaction_id) FROM postings p WHERE p.account_id = a.id) AS transactions,
      (SELECT COALESCE(SUM(p.amount), 0) FROM postings p WHERE p.account_id = a.id) AS total,
      (SELECT COUNT(*) FROM rules r WHERE r.category_id = a.id) AS rules,
      (SELECT b.amount FROM budgets b WHERE b.category_id = a.id) AS budget
    FROM accounts a
    WHERE a.type IN ('income', 'expense')
    ORDER BY a.type DESC, a.is_archived, a.name COLLATE NOCASE`).map((row) => ({
    ...row,
    isArchived: Boolean(row.isArchived),
    // Income is stored as a credit, so show it as a positive amount.
    total: row.type === 'income' ? -row.total : row.total,
    isProtected: row.type === 'expense' && row.name === UNCATEGORIZED,
  }));
}

function checkMerge(db: Db, fromId: number, intoId: number) {
  if (fromId === intoId) throw new DomainError('invalid', 'Pick a different category to merge into');
  const from = getAccount(db, fromId);
  const into = getAccount(db, intoId);
  for (const account of [from, into]) {
    if (account.type !== 'income' && account.type !== 'expense') {
      throw new DomainError('invalid', `"${account.name}" is not a spending or income category`);
    }
  }
  if (from.type !== into.type) {
    throw new DomainError('invalid', 'Income can only be merged into income, and spending into spending');
  }
  assertNotProtected(from, 'merged away');
  if (into.isArchived) throw new DomainError('invalid', `"${into.name}" is archived. Restore it first.`);
  return { from, into };
}

// Moves everything from one category into another and removes the first:
// transactions, rules, statement rows waiting for review, and the budget (the
// target keeps its own if it has one).
export function mergeCategory(db: Db, fromId: number, intoId: number) {
  const { from, into } = checkMerge(db, fromId, intoId);
  return db.transaction((tx) => {
    const moved = tx.update(postings).set({ accountId: into.id }).where(eq(postings.accountId, from.id)).returning().all();
    tx.update(stagedTransactions).set({ categoryId: into.id }).where(eq(stagedTransactions.categoryId, from.id)).run();
    const movedRules = tx.update(rules).set({ categoryId: into.id }).where(eq(rules.categoryId, from.id)).returning().all();

    const theirs = tx.select().from(budgets).where(eq(budgets.categoryId, into.id)).get();
    const mine = tx.select().from(budgets).where(eq(budgets.categoryId, from.id)).get();
    if (mine && !theirs) tx.update(budgets).set({ categoryId: into.id }).where(eq(budgets.id, mine.id)).run();
    else if (mine) tx.delete(budgets).where(eq(budgets.id, mine.id)).run();

    tx.delete(accounts).where(and(eq(accounts.id, from.id))).run();
    return { into: into.name, transactions: new Set(moved.map((p) => p.transactionId)).size, rules: movedRules.length };
  });
}
