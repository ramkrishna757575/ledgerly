import { importBatches, type Db } from '@ledgerly/db';
import { and, eq } from 'drizzle-orm';
import { getBalances } from './accounts.ts';

const day = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

// What each credit card bill still needs: the amount on its latest statement,
// less anything already paid since (the card now owes less than the statement
// said). A bill whose date has passed with nothing paid is overdue.
export function cardDues(db: Db, input: { today?: string } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const balances = new Map(getBalances(db).map((b) => [b.id, b]));

  const batches = db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.status, 'committed'), eq(importBatches.accountKind, 'credit_card')))
    .all()
    .filter((b) => b.accountId !== null && b.dueDate && b.closingBalance !== null && b.periodEnd);

  const latest = new Map<number, (typeof batches)[number]>();
  for (const batch of batches) {
    const current = latest.get(batch.accountId!);
    if (!current || batch.periodEnd! > current.periodEnd!) latest.set(batch.accountId!, batch);
  }

  const dues = [];
  for (const [accountId, batch] of latest) {
    const account = balances.get(accountId);
    if (!account || account.isArchived) continue;
    const owed = Math.max(account.balance, 0);
    const statement = Math.max(batch.closingBalance!, 0);
    const remaining = Math.min(statement, owed);
    if (remaining <= 0) continue;
    const daysToDue = day(batch.dueDate!) - day(today);
    // A bill long past due with money still owed is more likely newer spending than an unpaid bill.
    if (daysToDue < -30) continue;
    dues.push({
      accountId,
      name: account.name,
      dueDate: batch.dueDate!,
      daysToDue,
      statementAmount: statement,
      remaining,
      minimumDue: batch.minimumDue ?? null,
      overdue: daysToDue < 0,
      partlyPaid: remaining < statement,
    });
  }
  return dues.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export type CardDue = ReturnType<typeof cardDues>[number];

