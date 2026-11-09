import type { Db } from '@ledgerly/db';
import { sql } from 'drizzle-orm';
import { monthlyPattern } from './analysis/surplus.ts';
import { formatAmount } from './money.ts';
import { keyOf, recurringPayments } from './recurring.ts';

const DAY = 86_400_000;
const day = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const rupees = (paise: number) => formatAmount(paise).replace(/\.00$/, '');

export type Anomaly = {
  key: string;
  kind: 'unusual' | 'duplicate' | 'price_rise' | 'spike';
  title: string;
  detail: string;
  amount: number;
  date: string;
};

type Row = { id: number; date: string; payee: string | null; description: string; amount: number };

// Things in your own spending that look off, found by comparing it with your
// own habits. They are prompts to look, not accusations: a big one-off purchase
// is normal. Nothing here is sent anywhere.
export function anomalies(db: Db, input: { today?: string } = {}): Anomaly[] {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const rows = db.all<Row>(sql`
    SELECT t.id AS id, t.date AS date, t.payee AS payee, t.description AS description, p.amount AS amount
    FROM postings p
    JOIN accounts a ON a.id = p.account_id
    JOIN transactions t ON t.id = p.transaction_id
    WHERE a.type = 'expense' AND p.amount > 0 AND t.date <= ${today}
      AND (SELECT COUNT(*) FROM postings q WHERE q.transaction_id = t.id) = 2`);

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row.payee, row.description);
    if (key.length < 3) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const found: Anomaly[] = [];
  const label = (r: Row) => r.payee?.trim() || r.description;

  for (const group of groups.values()) {
    group.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const recent = group.filter((r) => day(today) - day(r.date) <= 14);

    // A charge far above what this payee usually costs.
    for (const r of recent) {
      const before = group.filter((x) => x.date < r.date && x.id !== r.id).map((x) => x.amount);
      if (before.length < 3) continue;
      const usual = median(before);
      if (r.amount >= 2_000_00 && r.amount >= usual * 4) {
        found.push({ key: `unusual:${r.id}`, kind: 'unusual', title: `${label(r)}: ${rupees(r.amount)} is far above the usual ${rupees(usual)}`, detail: `On ${r.date}. You have paid this payee ${before.length} times before.`, amount: r.amount, date: r.date });
      }
    }

    // The same payee and amount twice within two days.
    const last30 = group.filter((r) => day(today) - day(r.date) <= 30 && r.amount >= 100_00);
    for (let i = 1; i < last30.length; i++) {
      const a = last30[i - 1]!;
      const b = last30[i]!;
      if (a.amount === b.amount && day(b.date) - day(a.date) <= 2) {
        found.push({ key: `duplicate:${a.id}:${b.id}`, kind: 'duplicate', title: `${label(b)} charged ${rupees(b.amount)} twice`, detail: `On ${a.date}${a.date === b.date ? '' : ` and ${b.date}`}. If it was not meant to be, ask for a refund.`, amount: b.amount, date: b.date });
      }
    }
  }

  // A subscription or bill that has become dearer.
  for (const item of recurringPayments(db, { today }).filter((i) => i.status !== 'lapsed')) {
    const group = groups.get(item.key);
    if (!group) continue;
    const byDate = new Map<string, number>();
    for (const r of group) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.amount);
    const amounts = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (amounts.length < 3) continue;
    const [lastDate, last] = amounts.at(-1)!;
    const earlier = amounts.slice(0, -1).map(([, v]) => v);
    const usual = median(earlier);
    // Only a bill that used to be steady: one that always moves about is not a price rise.
    if (earlier.some((v) => Math.abs(v - usual) > usual * 0.05)) continue;
    if (day(today) - day(lastDate) <= 45 && last > usual * 1.1 && last - usual >= 10_00) {
      found.push({ key: `price_rise:${item.key}:${lastDate}`, kind: 'price_rise', title: `${item.label} went up from ${rupees(usual)} to ${rupees(last)}`, detail: `A ${Math.round((last / usual - 1) * 100)}% rise, charged on ${lastDate}. Check whether you agreed to it.`, amount: last - usual, date: lastDate });
    }
  }

  // This month's spending, once it is well under way, far above a normal month.
  const month = today.slice(0, 7);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysIn = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const pattern = monthlyPattern(db, today);
  if (pattern.spending && pattern.monthsOfData >= 2 && dayOfMonth / daysIn >= 0.5) {
    const so = rows.filter((r) => r.date.startsWith(month)).reduce((s, r) => s + r.amount, 0);
    if (so > pattern.spending * 1.5 && so - pattern.spending >= 5_000_00) {
      found.push({ key: `spike:${month}`, kind: 'spike', title: `Spending this month is already ${rupees(so)}, against a usual ${rupees(pattern.spending)}`, detail: `${dayOfMonth} days in. Look at the biggest items on Reports.`, amount: so - pattern.spending, date: today });
    }
  }

  return found.sort((a, b) => b.amount - a.amount);
}
