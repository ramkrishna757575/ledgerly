import type { Db } from '@ledgerly/db';
import { getBalances } from './accounts.ts';
import { loans as loansTable, manualAssets, accounts as accountsTable } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { cardDues } from './cards.ts';
import { listLoans, schedule } from './loans.ts';
import { addMonths as policyMonths, listPolicies } from './policies.ts';
import { maturityValue } from './assets.ts';
import { monthlyPattern } from './analysis/surplus.ts';
import { sipPlans } from './investments/sips.ts';
import { recurringPayments, type Cadence, type RecurringPayment } from './recurring.ts';

const DAY = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

function addMonths(date: string, months: number) {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(Number(date.slice(8, 10)), last))).toISOString().slice(0, 10);
}

const STEP: Record<Cadence, (date: string) => string> = {
  weekly: (d) => addDays(d, 7),
  monthly: (d) => addMonths(d, 1),
  quarterly: (d) => addMonths(d, 3),
  yearly: (d) => addMonths(d, 12),
};

export type ForecastEvent = { date: string; label: string; amount: number; kind: 'bill' | 'income' };

// Every date a recurring item falls due inside the window. One that is overdue
// is expected tomorrow, since it has not arrived yet.
function occurrences(item: RecurringPayment, from: string, to: string) {
  const dates: string[] = [];
  let date = item.nextDue;
  if (date < from) {
    dates.push(addDays(from, 1));
    while (date < from) date = STEP[item.cadence](date);
  }
  while (date <= to) {
    dates.push(date);
    date = STEP[item.cadence](date);
  }
  return dates;
}

// Whether a payment is already in the list as a recurring bill: about the same
// amount within a few days.
function alreadyABill(known: { date: string; amount: number }[], date: string, amount: number) {
  return known.some((k) => Math.abs(-k.amount - amount) <= amount * 0.02 && Math.abs(Date.parse(k.date) - Date.parse(date)) <= 5 * DAY);
}

// Where the bank balance is heading: today's money, plus recurring income and
// minus recurring bills on the days they fall due, minus an even daily amount
// for everything else you usually spend. A card bill counts on its due date.
export function forecast(db: Db, input: { today?: string; days?: number } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const days = Math.min(Math.max(input.days ?? 60, 7), 365);
  const end = addDays(today, days);

  const start = getBalances(db)
    .filter((b) => !b.isArchived && b.type === 'asset' && (b.subtype === 'bank' || b.subtype === 'cash' || b.subtype === 'wallet'))
    .reduce((sum, b) => sum + b.balance, 0);

  const bills = recurringPayments(db, { today }).filter((i) => i.status !== 'lapsed');
  const incomes = recurringPayments(db, { today, income: true }).filter((i) => i.status !== 'lapsed');

  const billEvents = bills.flatMap((i) => occurrences(i, today, end).map((date) => ({ date, label: i.label, amount: -i.amount, kind: 'bill' as const })));

  const events: ForecastEvent[] = [
    ...billEvents,
    ...incomes.flatMap((i) => occurrences(i, today, end).map((date) => ({ date, label: i.label, amount: i.amount, kind: 'income' as const }))),
    // Loan instalments and insurance premiums, unless the bank history has
    // already made them a recurring bill (so they are not counted twice).
    ...listLoans(db, { today }).flatMap((l) => {
      const loan = db.select().from(loansTable).where(eq(loansTable.id, l.id)).get()!;
      return schedule(loan)
        .filter((i) => i.date >= today && i.date <= end && !alreadyABill(billEvents, i.date, i.paid))
        .map((i) => ({ date: i.date, label: `EMI: ${l.name}`, amount: -i.paid, kind: 'bill' as const }));
    }),
    ...listPolicies(db, { today }).flatMap((p) => {
      const step = { monthly: 1, quarterly: 3, yearly: 12 }[p.frequency];
      const dates: string[] = [];
      for (let d = p.nextDue; d <= end; d = policyMonths(d, step)) if (!alreadyABill(billEvents, d, p.premium)) dates.push(d);
      return dates.map((date) => ({ date, label: `Premium: ${p.name}`, amount: -p.premium, kind: 'bill' as const }));
    }),
    // A card bill is paid from the bank on its due date; one already overdue is assumed paid tomorrow.
    ...cardDues(db, { today }).flatMap((d) => {
      const date = d.dueDate < today ? addDays(today, 1) : d.dueDate;
      return date <= end ? [{ date, label: `Card bill: ${d.name}`, amount: -d.remaining, kind: 'bill' as const }] : [];
    }),
    // A deposit that matures inside the window pays out into the bank. If you
    // renew it instead, the forecast is too high from that day.
    ...db
      .select({ accountId: manualAssets.accountId, maturity: manualAssets.maturityDate, name: accountsTable.name })
      .from(manualAssets)
      .innerJoin(accountsTable, eq(accountsTable.id, manualAssets.accountId))
      .all()
      .flatMap((a) => {
        if (!a.maturity || a.maturity < today || a.maturity > end) return [];
        const amount = maturityValue(db, a.accountId);
        return amount && amount > 0 ? [{ date: a.maturity, label: `Matures: ${a.name}`, amount, kind: 'income' as const }] : [];
      }),
    // Investment plans leave the bank as a transfer, not as spending.
    ...sipPlans(db, { today }).plans.filter((p) => p.nextDue).flatMap((p) => {
      const dates: string[] = [];
      for (let date = p.nextDue!; date <= end; date = addMonths(date, 1)) if (date >= today) dates.push(date);
      return dates.map((date) => ({ date, label: `SIP: ${p.fund}`, amount: -p.amount, kind: 'bill' as const }));
    }),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

  // What is left of a normal month once the recurring bills are taken out.
  const pattern = monthlyPattern(db, today);
  const billsPerMonth = bills.reduce((sum, i) => sum + i.monthly, 0);
  const everyday = pattern.spending === null ? 0 : Math.max(0, pattern.spending - billsPerMonth);
  const perDay = Math.round(everyday / 30);

  const points: { date: string; balance: number }[] = [{ date: today, balance: start }];
  let balance = start;
  for (let i = 1; i <= days; i++) {
    const date = addDays(today, i);
    balance += events.filter((e) => e.date === date).reduce((sum, e) => sum + e.amount, 0) - perDay;
    points.push({ date, balance });
  }

  const lowest = points.reduce((low, p) => (p.balance < low.balance ? p : low), points[0]!);
  return {
    today,
    days,
    start,
    end: points.at(-1)!.balance,
    points,
    events,
    everydaySpendingPerMonth: everyday,
    lowest,
    firstBelowZero: points.find((p) => p.balance < 0)?.date ?? null,
    // Without history the everyday part is left out, so the line is optimistic.
    includesEverydaySpending: pattern.spending !== null,
  };
}

export type Forecast = ReturnType<typeof forecast>;
