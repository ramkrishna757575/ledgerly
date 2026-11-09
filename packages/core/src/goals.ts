import { goals, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getBalances } from './accounts.ts';
import { monthlyPattern } from './analysis/surplus.ts';
import { DomainError } from './errors.ts';
import { dateSchema } from './transactions.ts';

export const goalSchema = z.object({
  name: z.string().trim().min(1).max(100),
  targetAmount: z.number().int().safe().positive(),
  targetDate: dateSchema.nullable().optional(),
  accountIds: z.array(z.number().int().positive()).max(50).default([]),
  savedByHand: z.number().int().safe().min(0).default(0),
});

export function createGoal(db: Db, input: z.input<typeof goalSchema>) {
  const data = goalSchema.parse(input);
  return db.insert(goals).values({ ...data, targetDate: data.targetDate ?? null }).returning().get().id;
}

export function updateGoal(db: Db, id: number, input: z.input<typeof goalSchema>) {
  const data = goalSchema.parse(input);
  const row = db.update(goals).set({ ...data, targetDate: data.targetDate ?? null }).where(eq(goals.id, id)).returning().get();
  if (!row) throw new DomainError('not_found', 'No such goal');
}

export function deleteGoal(db: Db, id: number) {
  if (db.delete(goals).where(eq(goals.id, id)).returning().all().length === 0) throw new DomainError('not_found', 'No such goal');
}

const addMonths = (date: string, months: number) => {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
};

// Progress toward each goal. With a target date it says how much to put aside
// each month; and, from what you usually save in a month, when you would get
// there on current habits. Saving is income less spending over recent months.
export function listGoals(db: Db, input: { today?: string } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const balances = new Map(getBalances(db).filter((b) => !b.isArchived).map((b) => [b.id, b]));
  const pattern = monthlyPattern(db, today);
  const saving = pattern.income !== null && pattern.spending !== null ? Math.max(0, pattern.income - pattern.spending) : null;

  return db
    .select()
    .from(goals)
    .all()
    .map((goal) => {
      const linked = goal.accountIds.flatMap((id) => {
        const account = balances.get(id);
        return account ? [{ id, name: account.name, balance: Math.max(account.balance, 0) }] : [];
      });
      const current = linked.reduce((sum, a) => sum + a.balance, 0) + goal.savedByHand;
      const remaining = Math.max(0, goal.targetAmount - current);
      const monthsLeft = goal.targetDate ? Math.max(0, (Date.parse(goal.targetDate) - Date.parse(today)) / (30.4375 * 86_400_000)) : null;
      const done = remaining === 0;
      return {
        id: goal.id,
        name: goal.name,
        targetAmount: goal.targetAmount,
        targetDate: goal.targetDate,
        accountIds: goal.accountIds,
        savedByHand: goal.savedByHand,
        linked,
        current,
        remaining,
        share: Math.min(1, current / goal.targetAmount),
        done,
        monthsLeft: monthsLeft === null ? null : Math.round(monthsLeft * 10) / 10,
        neededPerMonth: done || monthsLeft === null ? null : monthsLeft < 1 ? remaining : Math.ceil(remaining / monthsLeft),
        // When, at your usual saving, it would be reached.
        reachedBy: done || saving === null || saving === 0 ? null : addMonths(today, Math.ceil(remaining / saving)),
        usualSaving: saving,
      };
    });
}

export type Goal = ReturnType<typeof listGoals>[number];
