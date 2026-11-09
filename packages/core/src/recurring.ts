import type { Db } from '@ledgerly/db';
import { sql } from 'drizzle-orm';
import { dismiss, dismissedKeys, undismiss } from './settings.ts';

export const CADENCES = {
  weekly: { days: [5, 9], months: 0, perMonth: 52 / 12, min: 3 },
  monthly: { days: [26, 35], months: 1, perMonth: 1, min: 3 },
  quarterly: { days: [84, 98], months: 3, perMonth: 1 / 3, min: 3 },
  yearly: { days: [350, 380], months: 12, perMonth: 1 / 12, min: 2 },
} as const;

export type Cadence = keyof typeof CADENCES;
export type RecurringStatus = 'upcoming' | 'overdue' | 'lapsed';

const DAY = 86_400_000;
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

function addMonths(date: string, months: number) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 + months;
  const last = new Date(Date.UTC(year + Math.floor(month / 12), (month % 12) + 1, 0)).getUTCDate();
  const day = Math.min(Number(date.slice(8, 10)), last);
  return new Date(Date.UTC(year + Math.floor(month / 12), month % 12, day)).toISOString().slice(0, 10);
}

const addDays = (date: string, days: number) => new Date((dayNumber(date) + days) * DAY).toISOString().slice(0, 10);

// The same payee written the same way, or the same narration with the changing
// numbers (references, dates) taken out.
export function keyOf(payee: string | null, description: string) {
  const text = (payee?.trim() || description).toLowerCase().replace(/[\d\W_]+/g, ' ').trim();
  return text.slice(0, 60);
}

type Row = { date: string; payee: string | null; description: string; category: string; amount: number };

function detect(rows: Row[]) {
  const byDate = new Map<string, number>();
  for (const row of rows) byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.amount);
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return null;

  const gaps = dates.slice(1).map((date, i) => dayNumber(date) - dayNumber(dates[i]!));
  const typical = median(gaps);
  const found = (Object.entries(CADENCES) as [Cadence, (typeof CADENCES)[Cadence]][]).find(
    ([, c]) => typical >= c.days[0] && typical <= c.days[1],
  );
  if (!found) return null;
  const [cadence, spec] = found;

  const steady = gaps.filter((gap) => gap >= spec.days[0] && gap <= spec.days[1]).length;
  if (dates.length < spec.min || steady / gaps.length < 0.7) return null;

  const amounts = dates.map((date) => byDate.get(date)!);
  const amount = median(amounts);
  const last = dates.at(-1)!;
  const latest = rows.filter((row) => row.date === last)[0]!;
  const categories = new Map<string, number>();
  for (const row of rows) categories.set(row.category, (categories.get(row.category) ?? 0) + 1);

  return {
    cadence,
    amount,
    varies: amounts.some((a) => Math.abs(a - amount) > amount * 0.25),
    occurrences: dates.length,
    lastDate: last,
    nextDue: spec.months ? addMonths(last, spec.months) : addDays(last, 7),
    cycleDays: Math.round((spec.days[0] + spec.days[1]) / 2),
    monthly: Math.round(amount * spec.perMonth),
    label: latest.payee?.trim() || latest.description,
    category: [...categories.entries()].sort((a, b) => b[1] - a[1])[0]![0],
  };
}

// Payments that keep coming back on a rhythm, found from the books themselves:
// the same payee at about the same interval, three times or more (twice for an
// annual one). Nothing is stored, so they follow the data as it changes.
export function recurringPayments(db: Db, input: { today?: string; includeHidden?: boolean; income?: boolean } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const hidden = dismissedKeys(db);

  const rows = db.all<Row & { id: number }>(sql`
    SELECT t.id AS id, t.date AS date, t.payee AS payee, t.description AS description, a.name AS category,
      ${input.income ? sql`-p.amount` : sql`p.amount`} AS amount
    FROM postings p
    JOIN accounts a ON a.id = p.account_id
    JOIN transactions t ON t.id = p.transaction_id
    WHERE a.type = ${input.income ? 'income' : 'expense'} AND ${input.income ? sql`p.amount < 0` : sql`p.amount > 0`} AND t.date <= ${today}`);

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row.payee, row.description);
    if (key.length < 3) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const items = [];
  for (const [key, group] of groups) {
    const found = detect(group);
    if (!found) continue;

    const dueIn = dayNumber(found.nextDue) - dayNumber(today);
    const late = -dueIn;
    // Well past due means it has most likely stopped: drop it after two cycles.
    if (late > found.cycleDays * 2) continue;
    const status: RecurringStatus = late <= 0 ? 'upcoming' : late <= Math.max(5, found.cycleDays * 0.2) ? 'overdue' : 'lapsed';
    const isHidden = hidden.has(`recurring:${key}`);
    if (isHidden && !input.includeHidden) continue;

    const { cycleDays: _cycle, ...rest } = found;
    items.push({ key, ...rest, dueIn, status, hidden: isHidden });
  }

  return items.sort(
    (a, b) => Number(a.status === 'lapsed') - Number(b.status === 'lapsed') || a.dueIn - b.dueIn || a.label.localeCompare(b.label),
  );
}

export type RecurringPayment = ReturnType<typeof recurringPayments>[number];

export function summarizeRecurring(items: RecurringPayment[], days = 30) {
  const active = items.filter((item) => item.status !== 'lapsed');
  const soon = active.filter((item) => item.dueIn <= days);
  return {
    monthly: active.reduce((total, item) => total + item.monthly, 0),
    dueSoon: { days, count: soon.length, amount: soon.reduce((total, item) => total + item.amount, 0) },
  };
}

export const hideRecurring = (db: Db, key: string) => dismiss(db, `recurring:${key}`);
export const showRecurring = (db: Db, key: string) => undismiss(db, `recurring:${key}`);
