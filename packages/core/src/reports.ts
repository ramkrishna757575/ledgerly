import type { Db } from '@ledgerly/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { dateSchema } from './transactions.ts';

export const rangeSchema = z.object({ from: dateSchema, to: dateSchema });
export const periodSchema = z.enum(['month', 'year', 'fy']);
export type Period = z.infer<typeof periodSchema>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Periods are calendar months, calendar years, or Indian financial years (April to March).
function periodOf(month: string, period: Period) {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  if (period === 'month') return { key: month, label: `${MONTHS[number - 1]} ${year}` };
  if (period === 'year') return { key: String(year), label: String(year) };
  const start = number >= 4 ? year : year - 1;
  return { key: `FY${start}`, label: `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}` };
}

// Every period the range touches, in order, so quiet months show up as zero.
function periodsBetween(from: string, to: string, period: Period) {
  const found = new Map<string, { key: string; label: string }>();
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const lastYear = Number(to.slice(0, 4));
  const lastMonth = Number(to.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const entry = periodOf(`${year}-${String(month).padStart(2, '0')}`, period);
    if (!found.has(entry.key)) found.set(entry.key, entry);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return [...found.values()];
}

const clean = (total: number) => (total === 0 ? 0 : total);

export function spendingByCategory(db: Db, input: z.input<typeof rangeSchema>) {
  const { from, to } = rangeSchema.parse(input);
  const rows = db.all<{ categoryId: number; name: string; total: number; transactions: number }>(sql`
    SELECT a.id AS categoryId, a.name AS name, SUM(p.amount) AS total, COUNT(DISTINCT t.id) AS transactions
    FROM postings p
    JOIN accounts a ON a.id = p.account_id
    JOIN transactions t ON t.id = p.transaction_id
    WHERE t.date BETWEEN ${from} AND ${to} AND a.type = 'expense'
    GROUP BY a.id
    HAVING SUM(p.amount) > 0
    ORDER BY total DESC, a.name`);
  return rows;
}

export function periodSummary(db: Db, input: z.input<typeof rangeSchema> & { period?: Period }) {
  const { from, to } = rangeSchema.parse(input);
  const period = periodSchema.parse(input.period ?? 'month');

  const rows = db.all<{ month: string; type: string; total: number }>(sql`
    SELECT substr(t.date, 1, 7) AS month, a.type AS type, SUM(p.amount) AS total
    FROM postings p
    JOIN accounts a ON a.id = p.account_id
    JOIN transactions t ON t.id = p.transaction_id
    WHERE t.date BETWEEN ${from} AND ${to} AND a.type IN ('income', 'expense')
    GROUP BY month, a.type`);

  const sums = new Map<string, { income: number; expenses: number }>();
  for (const { month, type, total } of rows) {
    const key = periodOf(month, period).key;
    const entry = sums.get(key) ?? { income: 0, expenses: 0 };
    if (type === 'income') entry.income += -total;
    else entry.expenses += total;
    sums.set(key, entry);
  }

  return periodsBetween(from, to, period).map(({ key, label }) => {
    const { income, expenses } = sums.get(key) ?? { income: 0, expenses: 0 };
    return { key, label, income: clean(income), expenses: clean(expenses), net: clean(income - expenses) };
  });
}

// Spending per period for the biggest categories, with the rest folded into one.
export function categoryTrend(
  db: Db,
  input: z.input<typeof rangeSchema> & { period?: Period; top?: number },
) {
  const { from, to } = rangeSchema.parse(input);
  const period = periodSchema.parse(input.period ?? 'month');
  const top = Math.min(Math.max(input.top ?? 5, 1), 8);

  const rows = db.all<{ month: string; categoryId: number; name: string; total: number }>(sql`
    SELECT substr(t.date, 1, 7) AS month, a.id AS categoryId, a.name AS name, SUM(p.amount) AS total
    FROM postings p
    JOIN accounts a ON a.id = p.account_id
    JOIN transactions t ON t.id = p.transaction_id
    WHERE t.date BETWEEN ${from} AND ${to} AND a.type = 'expense'
    GROUP BY month, a.id`);

  const periods = periodsBetween(from, to, period);
  const index = new Map(periods.map((entry, position) => [entry.key, position]));

  const byCategory = new Map<number, { name: string; values: number[]; total: number }>();
  for (const { month, categoryId, name, total } of rows) {
    const entry = byCategory.get(categoryId) ?? { name, values: periods.map(() => 0), total: 0 };
    entry.values[index.get(periodOf(month, period).key)!]! += total;
    entry.total += total;
    byCategory.set(categoryId, entry);
  }

  const ranked = [...byCategory.entries()]
    .filter(([, entry]) => entry.total > 0)
    .sort((a, b) => b[1].total - a[1].total);
  const shown = ranked.slice(0, top);
  const rest = ranked.slice(top);

  // A period where refunds outweigh spending counts as nothing, not as a negative bar.
  const floor = (values: number[]) => values.map((value) => Math.max(0, clean(value)));
  return {
    periods,
    series: shown.map(([categoryId, entry]) => ({ categoryId, name: entry.name, values: floor(entry.values) })),
    other: floor(periods.map((_, position) => rest.reduce((sum, [, entry]) => sum + entry.values[position]!, 0))),
  };
}

export function topPayees(db: Db, input: z.input<typeof rangeSchema> & { limit?: number }) {
  const { from, to } = rangeSchema.parse(input);
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  return db.all<{ name: string; total: number; transactions: number }>(sql`
    SELECT MAX(COALESCE(t.payee, t.description)) AS name, SUM(p.amount) AS total, COUNT(DISTINCT t.id) AS transactions
    FROM postings p
    JOIN accounts a ON a.id = p.account_id
    JOIN transactions t ON t.id = p.transaction_id
    WHERE t.date BETWEEN ${from} AND ${to} AND a.type = 'expense'
    GROUP BY lower(COALESCE(t.payee, t.description))
    HAVING SUM(p.amount) > 0
    ORDER BY total DESC, name
    LIMIT ${limit}`);
}

// What is not yet sorted into a real category, since reports are only as good as the categories.
export function uncategorizedSummary(db: Db, input: z.input<typeof rangeSchema>) {
  const { from, to } = rangeSchema.parse(input);
  const row = db.all<{ categoryId: number | null; count: number; total: number | null }>(sql`
    SELECT MAX(a.id) AS categoryId, COUNT(DISTINCT t.id) AS count, SUM(p.amount) AS total
    FROM postings p
    JOIN accounts a ON a.id = p.account_id
    JOIN transactions t ON t.id = p.transaction_id
    WHERE t.date BETWEEN ${from} AND ${to} AND a.type = 'expense' AND a.name = 'Uncategorized'`)[0];
  return { categoryId: row?.categoryId ?? null, count: row?.count ?? 0, total: row?.total ?? 0 };
}

export function overview(db: Db, input: z.input<typeof rangeSchema>) {
  const periods = periodSummary(db, { ...input, period: 'year' });
  const income = periods.reduce((sum, entry) => sum + entry.income, 0);
  const expenses = periods.reduce((sum, entry) => sum + entry.expenses, 0);
  const net = income - expenses;
  return {
    income,
    expenses,
    net,
    // Share of income that was not spent. Undefined when nothing came in.
    savingsRate: income > 0 ? net / income : null,
    uncategorized: uncategorizedSummary(db, input),
  };
}

export function netWorthHistory(db: Db, input: { months?: number; today?: string } = {}) {
  const months = Math.min(Math.max(input.months ?? 12, 1), 60);
  const today = dateSchema.parse(input.today ?? new Date().toISOString().slice(0, 10));
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  // Money in and out of assets and liabilities by month, in one pass, then
  // added up month by month, instead of working out every balance again for each point.
  const rows = db.all<{ month: string; type: 'asset' | 'liability'; total: number }>(sql`
    SELECT substr(t.date, 1, 7) AS month, a.type AS type, SUM(p.amount) AS total
    FROM postings p
    JOIN accounts a ON a.id = p.account_id
    JOIN transactions t ON t.id = p.transaction_id
    WHERE a.type IN ('asset', 'liability') AND t.date <= ${today}
    GROUP BY month, a.type`);

  return Array.from({ length: months }, (_, offset) => {
    const back = months - 1 - offset;
    const first = new Date(Date.UTC(year, month - 1 - back, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const key = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}`;
    const date = back === 0 ? today : `${key}-${String(lastDay).padStart(2, '0')}`;
    let assets = 0;
    let liabilities = 0;
    for (const row of rows) {
      if (row.month > key) continue;
      if (row.type === 'asset') assets += row.total;
      else liabilities -= row.total;
    }
    return { date, label: periodOf(key, 'month').label, assets: clean(assets), liabilities: clean(liabilities), netWorth: clean(assets - liabilities) };
  });
}
