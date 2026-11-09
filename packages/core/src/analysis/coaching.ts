import type { Db } from '@ledgerly/db';
import { periodSummary, spendingByCategory } from '../reports.ts';

const pad = (n: number) => String(n).padStart(2, '0');

// The last `count` complete months before today's, oldest first.
function completedMonths(today: string, count: number) {
  const base = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, i) => {
    const index = base - (count - i);
    const month = `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
    return { month, from: `${month}-01`, to: `${month}-${pad(last)}` };
  });
}

const rupees = (paise: number) => Math.round(paise / 100);

// What changed, worked out by code so a model can explain it instead of
// calculating it: the last six months side by side, which categories moved most
// against the three months before, and how much of the picture is unreliable
// because spending has not been sorted into categories.
export function coachingFacts(db: Db, today: string) {
  const months = completedMonths(today, 6);
  const rows = periodSummary(db, { from: months[0]!.from, to: months.at(-1)!.to, period: 'month' });
  const trend = months
    .map((m, i) => ({ month: m.month, income: rupees(rows[i]!.income), spending: rupees(rows[i]!.expenses) }))
    .filter((m) => m.income > 0 || m.spending > 0)
    .map((m) => ({ ...m, savedPercent: m.income > 0 ? Math.round(((m.income - m.spending) / m.income) * 100) : null }));

  const last = months.at(-1)!;
  const lastByCategory = new Map(spendingByCategory(db, last).map((c) => [c.name, c.total]));
  const before = months.slice(-4, -1);
  const earlier = new Map<string, number>();
  for (const m of before) for (const c of spendingByCategory(db, m)) earlier.set(c.name, (earlier.get(c.name) ?? 0) + c.total);
  const names = new Set([...lastByCategory.keys(), ...earlier.keys()]);
  const moves = [...names]
    .filter((name) => name !== 'Uncategorized')
    .map((name) => {
      const now = lastByCategory.get(name) ?? 0;
      const usual = Math.round((earlier.get(name) ?? 0) / before.length);
      return { category: name, lastMonthRupees: rupees(now), usualMonthlyRupees: rupees(usual), changeRupees: rupees(now - usual) };
    })
    .filter((m) => Math.abs(m.changeRupees) >= 1000 && trend.length >= 3);
  const up = moves.filter((m) => m.changeRupees > 0).sort((a, b) => b.changeRupees - a.changeRupees).slice(0, 3);
  const down = moves.filter((m) => m.changeRupees < 0).sort((a, b) => a.changeRupees - b.changeRupees).slice(0, 2);

  const recent = months.slice(-3);
  let all = 0;
  let sorted = 0;
  for (const m of recent) for (const c of spendingByCategory(db, m)) {
    all += c.total;
    if (c.name !== 'Uncategorized') sorted += c.total;
  }

  return {
    lastSixMonths: trend,
    lastFullMonth: last.month,
    categoriesUpVsUsual: up,
    categoriesDownVsUsual: down,
    uncategorizedSharePercent: all > 0 ? Math.round(((all - sorted) / all) * 100) : null,
  };
}
