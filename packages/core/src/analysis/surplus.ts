import { importBatches, type Db } from '@ledgerly/db';
import { and, eq } from 'drizzle-orm';
import { getBalances } from '../accounts.ts';
import { periodSummary, spendingByCategory } from '../reports.ts';
import { recurringPayments, summarizeRecurring } from '../recurring.ts';
import { getSetting } from '../settings.ts';

export const BUFFER_KEY = 'analysis.bufferMonths';
export const DEFAULT_BUFFER_MONTHS = 6;

export function getBufferMonths(db: Db) {
  const value = Number(getSetting(db, BUFFER_KEY));
  return Number.isFinite(value) && value >= 1 && value <= 24 ? value : DEFAULT_BUFFER_MONTHS;
}

const pad = (n: number) => String(n).padStart(2, '0');

function previousMonths(today: string, count: number) {
  const base = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, i) => {
    const index = base - (count - i);
    const month = `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    return { month, from: `${month}-01`, to: `${month}-${pad(last)}` };
  });
}

// What a normal month looks like, from the last three full months.
//
// When the books come from imported statements, only a month that a bank
// statement covers from its first day to its last is used: a month with one
// card cycle, or half a statement, would understate spending and so the buffer.
// Without imports (typed in by hand), a month counts if it has any activity.
export function monthlyPattern(db: Db, today: string) {
  const months = previousMonths(today, 3);
  const rows = periodSummary(db, { from: months[0]!.from, to: months.at(-1)!.to, period: 'month' });

  const statements = db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.status, 'committed'), eq(importBatches.accountKind, 'bank')))
    .all()
    .filter((b) => b.periodStart && b.periodEnd);
  const covered = (month: string) => {
    const first = `${month}-01`;
    const last = months.find((m) => m.month === month)!.to;
    return statements.some((b) => b.periodStart! <= first && b.periodEnd! >= last);
  };
  const used = rows.filter((row, i) =>
    statements.length > 0 ? covered(months[i]!.month) : row.expenses > 0 || row.income > 0,
  );
  const count = used.length;
  const average = (pick: (r: (typeof rows)[number]) => number) => (count === 0 ? null : Math.round(used.reduce((s, r) => s + pick(r), 0) / count));

  const perCategory = new Map<string, number>();
  for (const row of used) {
    const month = months[rows.indexOf(row)]!;
    for (const c of spendingByCategory(db, { from: month.from, to: month.to })) perCategory.set(c.name, (perCategory.get(c.name) ?? 0) + c.total);
  }
  const categories = [...perCategory]
    .map(([name, total]) => ({ name, monthly: Math.round(total / Math.max(count, 1)) }))
    .sort((a, b) => b.monthly - a.monthly)
    .slice(0, 8);

  const spending = average((r) => r.expenses);
  const income = average((r) => r.income);
  return {
    monthsOfData: count,
    spending,
    income,
    savingsRate: spending !== null && income !== null && income > 0 ? (income - spending) / income : null,
    topCategories: categories,
    // True when months were chosen by statement coverage rather than by activity.
    fromStatements: statements.length > 0,
  };
}

// Money that is idle, worked out by code so the numbers never depend on a model:
// what is in the bank and cash, less card balances already owed, less a buffer
// of several months' spending, less bills expected in the next 30 days.
export function surplusCash(db: Db, input: { today?: string; bufferMonths?: number } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const bufferMonths = input.bufferMonths ?? getBufferMonths(db);

  const balances = getBalances(db).filter((b) => !b.isArchived);
  const liquid = balances
    .filter((b) => b.type === 'asset' && (b.subtype === 'bank' || b.subtype === 'cash' || b.subtype === 'wallet'))
    .reduce((sum, b) => sum + b.balance, 0);
  const cardsOwed = balances.filter((b) => b.type === 'liability' && b.subtype === 'credit_card').reduce((s, b) => s + Math.max(b.balance, 0), 0);
  const loansOwed = balances.filter((b) => b.type === 'liability' && b.subtype === 'loan').reduce((s, b) => s + Math.max(b.balance, 0), 0);

  const pattern = monthlyPattern(db, today);
  const billsDue = summarizeRecurring(recurringPayments(db, { today })).dueSoon.amount;

  if (pattern.spending === null) {
    return { status: 'unknown' as const, today, bufferMonths, liquid, cardsOwed, loansOwed, billsDue, buffer: null, surplus: null, monthsCovered: null, pattern };
  }

  const buffer = pattern.spending * bufferMonths;
  const free = liquid - cardsOwed - billsDue;
  const surplus = free - buffer;
  return {
    status: surplus > 0 ? ('surplus' as const) : ('short' as const),
    today,
    bufferMonths,
    liquid,
    cardsOwed,
    loansOwed,
    billsDue,
    buffer,
    // Negative means the buffer is not yet full: the shortfall.
    surplus,
    // How many months of spending the free cash covers.
    monthsCovered: pattern.spending > 0 ? Math.round((free / pattern.spending) * 10) / 10 : null,
    pattern,
  };
}

export type Surplus = ReturnType<typeof surplusCash>;
