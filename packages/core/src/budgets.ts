import { accounts, budgets, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from './errors.ts';
import { spendingByCategory } from './reports.ts';

export const budgetSchema = z.object({
  categoryId: z.number().int().positive(),
  amount: z.number().int().safe().positive(),
});

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-10');

const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
const today = () => new Date().toISOString().slice(0, 10);

function shiftMonth(month: string, by: number) {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1 + by;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

const range = (month: string) => ({ from: `${month}-01`, to: `${month}-${pad(daysIn(month))}` });

export function setBudget(db: Db, input: z.input<typeof budgetSchema>) {
  const { categoryId, amount } = budgetSchema.parse(input);
  const category = db.select().from(accounts).where(eq(accounts.id, categoryId)).get();
  if (!category || category.type !== 'expense') {
    throw new DomainError('invalid', 'A budget can only be set on a spending category');
  }
  db.insert(budgets)
    .values({ categoryId, amount })
    .onConflictDoUpdate({ target: budgets.categoryId, set: { amount } })
    .run();
  return { categoryId, amount };
}

export function deleteBudget(db: Db, categoryId: number) {
  const removed = db.delete(budgets).where(eq(budgets.categoryId, categoryId)).returning().all();
  if (removed.length === 0) throw new DomainError('not_found', 'No budget on that category');
}

export type BudgetState = 'ok' | 'watch' | 'over';

// How each budget stands in a month. In the current month a budget is "watch"
// when spending runs ahead of an even pace or has passed 80%; "over" once it
// is exceeded. Earlier months are judged on the final figure alone.
export function budgetStatus(db: Db, input: { month?: string; today?: string } = {}) {
  const now = input.today ?? today();
  const month = monthSchema.parse(input.month ?? now.slice(0, 7));
  const elapsed = month < now.slice(0, 7) ? 1 : month > now.slice(0, 7) ? 0 : Number(now.slice(8, 10)) / daysIn(month);

  const spent = new Map(spendingByCategory(db, range(month)).map((r) => [r.categoryId, r]));
  const rows = db
    .select({ categoryId: budgets.categoryId, name: accounts.name, amount: budgets.amount })
    .from(budgets)
    .innerJoin(accounts, eq(accounts.id, budgets.categoryId))
    .all();

  const items = rows
    .map((row) => {
      const used = spent.get(row.categoryId)?.total ?? 0;
      const nearLimit = used >= row.amount * 0.8;
      const aheadOfPace = elapsed > 0 && elapsed < 1 && used >= row.amount * 0.5 && used > row.amount * elapsed * 1.1;
      const state: BudgetState = used > row.amount ? 'over' : nearLimit || aheadOfPace ? 'watch' : 'ok';
      return {
        ...row,
        spent: used,
        remaining: row.amount - used,
        share: row.amount === 0 ? 0 : used / row.amount,
        state,
      };
    })
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));

  const budgeted = new Set(rows.map((r) => r.categoryId));
  const unbudgeted = [...spent.values()].filter((r) => !budgeted.has(r.categoryId)).map((r) => ({ categoryId: r.categoryId, name: r.name, spent: r.total }));

  return {
    month,
    elapsed,
    items,
    totals: {
      budgeted: items.reduce((s, i) => s + i.amount, 0),
      spent: items.reduce((s, i) => s + i.spent, 0),
      unbudgeted: unbudgeted.reduce((s, i) => s + i.spent, 0),
    },
    unbudgeted,
  };
}

// Starting points for categories with no budget: the average of the last three
// full months, rounded up to a whole ₹100. Needs two months with spending, so
// one odd month does not set the limit.
export function suggestBudgets(db: Db, input: { today?: string } = {}) {
  const current = (input.today ?? today()).slice(0, 7);
  const months = [1, 2, 3].map((n) => shiftMonth(current, -n));
  const has = new Set(db.select({ id: budgets.categoryId }).from(budgets).all().map((b) => b.id));

  const totals = new Map<number, { name: string; sum: number; months: number }>();
  for (const month of months) {
    for (const row of spendingByCategory(db, range(month))) {
      if (has.has(row.categoryId) || row.name === 'Uncategorized') continue;
      const entry = totals.get(row.categoryId) ?? { name: row.name, sum: 0, months: 0 };
      entry.sum += row.total;
      entry.months += 1;
      totals.set(row.categoryId, entry);
    }
  }
  return [...totals.entries()]
    .filter(([, t]) => t.months >= 2)
    .map(([categoryId, t]) => ({
      categoryId,
      name: t.name,
      average: Math.round(t.sum / months.length),
      amount: Math.ceil(t.sum / months.length / 10_000) * 10_000,
    }))
    .sort((a, b) => b.average - a.average);
}
