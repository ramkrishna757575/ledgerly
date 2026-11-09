import { importBatches, accounts, type Db } from '@ledgerly/db';
import { and, eq, isNotNull } from 'drizzle-orm';

export type CoverageState = 'covered' | 'partial' | 'gap';
export type AccountCoverage = {
  accountId: number;
  accountName: string;
  kind: 'bank' | 'credit_card';
  months: { month: string; state: CoverageState }[];
  // Months with no statement at all, between the first one imported and now.
  missing: string[];
  firstMonth: string;
  lastStatementEnd: string;
};

const DAY = 86_400_000;
const dayOf = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const monthKey = (day: number) => new Date(day * DAY).toISOString().slice(0, 7);
const monthStart = (key: string) => dayOf(`${key}-01`);
const nextMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

// Which months each account has statements for, built from the periods of the
// statements already imported. A card's cycle does not follow the calendar, so a month
// counts as covered only when the periods together cover every day of it.
export function statementCoverage(db: Db, today = new Date().toISOString().slice(0, 10)): AccountCoverage[] {
  const rows = db
    .select({
      accountId: importBatches.accountId,
      name: accounts.name,
      kind: importBatches.accountKind,
      start: importBatches.periodStart,
      end: importBatches.periodEnd,
    })
    .from(importBatches)
    .innerJoin(accounts, eq(accounts.id, importBatches.accountId))
    .where(and(eq(importBatches.status, 'committed'), isNotNull(importBatches.accountId), isNotNull(importBatches.periodStart), isNotNull(importBatches.periodEnd)))
    .all();

  const byAccount = new Map<number, { name: string; kind: 'bank' | 'credit_card'; spans: [number, number][] }>();
  for (const row of rows) {
    const entry = byAccount.get(row.accountId!) ?? { name: row.name, kind: row.kind, spans: [] };
    entry.spans.push([dayOf(row.start!), dayOf(row.end!)]);
    byAccount.set(row.accountId!, entry);
  }

  const thisMonth = today.slice(0, 7);
  const result: AccountCoverage[] = [];
  for (const [accountId, entry] of byAccount) {
    const spans = entry.spans.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
      else merged.push([span[0], span[1]]);
    }
    const firstMonth = monthKey(merged[0]![0]);
    const lastEnd = merged[merged.length - 1]![1];
    // Up to the latest of: the last statement, and last month (this month's is not out yet).
    const lastShown = [monthKey(lastEnd), prevMonth(thisMonth)].sort().pop()!;

    const months: AccountCoverage['months'] = [];
    for (let m = firstMonth; m <= lastShown; m = nextMonth(m)) {
      const first = monthStart(m);
      const last = monthStart(nextMonth(m)) - 1;
      let covered = 0;
      for (const [a, b] of merged) covered += Math.max(0, Math.min(b, last) - Math.max(a, first) + 1);
      const total = last - first + 1;
      months.push({ month: m, state: covered >= total ? 'covered' : covered > 0 ? 'partial' : 'gap' });
    }
    result.push({
      accountId,
      accountName: entry.name,
      kind: entry.kind,
      months: months.slice(-36),
      missing: months.filter((month) => month.state === 'gap').map((month) => month.month),
      firstMonth,
      lastStatementEnd: new Date(lastEnd * DAY).toISOString().slice(0, 10),
    });
  }
  return result.sort((a, b) => a.accountName.localeCompare(b.accountName));
}

function prevMonth(key: string) {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
