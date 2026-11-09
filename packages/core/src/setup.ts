import { accounts, budgets, importBatches, transactions, type Db } from '@ledgerly/db';
import { and, count, eq, sql } from 'drizzle-orm';
import { dismiss, dismissedKeys } from './settings.ts';

export type SetupStep = {
  key: 'accounts' | 'import' | 'categories' | 'budget';
  title: string;
  detail: string;
  done: boolean;
  to: '/accounts' | '/import' | '/transactions' | '/budgets';
  label: string;
};

const KEY = 'setup:hidden';

// A short list of what a new person should do first, ticked off from what is
// already in their books. It disappears once everything is done or it is turned down.
export function setupProgress(db: Db): { steps: SetupStep[]; hidden: boolean } {
  const money = db.select({ n: count() }).from(accounts).where(and(eq(accounts.isArchived, false), sql`${accounts.type} IN ('asset', 'liability')`)).get()!.n;
  const imported = db.select({ n: count() }).from(importBatches).where(eq(importBatches.status, 'committed')).get()!.n;
  const all = db.select({ n: count() }).from(transactions).get()!.n;
  const budgeted = db.select({ n: count() }).from(budgets).get()!.n;
  const uncategorised = db.get<{ n: number }>(sql`
    SELECT COUNT(DISTINCT t.id) AS n FROM transactions t
    JOIN postings p ON p.transaction_id = t.id JOIN accounts a ON a.id = p.account_id
    WHERE a.type = 'expense' AND a.name = 'Uncategorized'`).n;

  const steps: SetupStep[] = [
    { key: 'accounts', title: 'Add your accounts and cards', detail: 'Your bank accounts, credit cards and any investments, each with today\'s balance (or the amount owed on a card).', done: money > 0, to: '/accounts', label: 'Add accounts' },
    { key: 'import', title: 'Import a statement', detail: 'Upload your latest bank or card statement, or a few months of them. You review everything before it is added, and you can undo it.', done: imported > 0 || all >= 20, to: '/import', label: 'Import' },
    { key: 'categories', title: 'Check the categories', detail: 'Fix any spending filed under the wrong category. After a few fixes Ledgerly starts suggesting rules so it does it for you.', done: all >= 5 && uncategorised / all < 0.2, to: '/transactions', label: 'See transactions' },
    { key: 'budget', title: 'Set a monthly limit', detail: 'Pick the categories you want to keep an eye on, such as food or shopping, and a monthly amount for each.', done: budgeted > 0, to: '/budgets', label: 'Set budgets' },
  ];
  return { steps, hidden: dismissedKeys(db).has(KEY) || steps.every((step) => step.done) };
}

export function hideSetup(db: Db) {
  dismiss(db, KEY);
}
