import { investmentTransactions, positions, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const DAY = 86_400_000;
const day = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function nextMonth(date: string) {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(Number(date.slice(8, 10)), last)).padStart(2, '0')}`;
}

// Systematic investment plans seen in your fund statements: the same fund,
// bought with a fixed amount about once a month. Each instalment is looked for
// in your bank transactions, so you can see the money really left, and the
// next one is worked out so it can be counted in the cash-flow forecast.
export function sipPlans(db: Db, input: { today?: string } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const rows = db
    .select({ positionId: investmentTransactions.positionId, name: positions.name, date: investmentTransactions.date, amount: investmentTransactions.amount })
    .from(investmentTransactions)
    .innerJoin(positions, eq(positions.id, investmentTransactions.positionId))
    .where(eq(investmentTransactions.kind, 'sip'))
    .orderBy(investmentTransactions.date)
    .all();

  // Money that left a bank or cash account, by day, to match against.
  const debits = db.all<{ date: string; amount: number }>(sql`
    SELECT t.date AS date, -p.amount AS amount
    FROM postings p JOIN accounts a ON a.id = p.account_id JOIN transactions t ON t.id = p.transaction_id
    WHERE a.type = 'asset' AND a.subtype IN ('bank', 'cash', 'wallet') AND p.amount < 0`);

  const byFund = new Map<number, typeof rows>();
  for (const row of rows) byFund.set(row.positionId, [...(byFund.get(row.positionId) ?? []), row]);

  const plans = [];
  for (const [positionId, list] of byFund) {
    const months = new Set(list.map((r) => r.date.slice(0, 7)));
    if (months.size < 2) continue;
    const amount = median(list.map((r) => r.amount));
    const last = list.at(-1)!.date;
    const matched = list.filter((r) => debits.some((d) => d.amount === r.amount && Math.abs(day(d.date) - day(r.date)) <= 4)).length;
    const next = nextMonth(last);
    const active = day(today) - day(last) <= 45;
    plans.push({
      positionId,
      fund: list[0]!.name,
      amount,
      instalments: list.length,
      firstDate: list[0]!.date,
      lastDate: last,
      nextDue: active ? next : null,
      active,
      inBankStatement: matched,
    });
  }
  plans.sort((a, b) => Number(b.active) - Number(a.active) || b.amount - a.amount);
  return { plans, monthlyTotal: plans.filter((p) => p.active).reduce((s, p) => s + p.amount, 0) };
}

export type SipPlans = ReturnType<typeof sipPlans>;
