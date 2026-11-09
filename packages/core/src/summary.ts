import type { Db } from '@ledgerly/db';
import { getCashFlow, getNetWorth } from './accounts.ts';
import { statementCoverage } from './coverage.ts';
import { computeInsights } from './insights.ts';
import { formatAmount } from './money.ts';
import { spendingByCategory } from './reports.ts';
import { getSetting, setSetting } from './settings.ts';

const ENABLED = 'summary.monthly';
const LAST_SENT = 'summary.lastSent';

export const monthlySummaryEnabled = (db: Db) => getSetting(db, ENABLED) === 'on';
export const setMonthlySummary = (db: Db, on: boolean) => setSetting(db, ENABLED, on ? 'on' : 'off');
export const lastSummarySent = (db: Db) => getSetting(db, LAST_SENT) ?? null;
export const markSummarySent = (db: Db, month: string) => setSetting(db, LAST_SENT, month);

const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The month before the one `today` is in, as "2026-10".
export function previousMonth(today: string) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

export function monthlySummary(db: Db, month: string) {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const range = { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
  const flow = getCashFlow(db, range);
  const categories = spendingByCategory(db, range)
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map((c) => ({ name: c.name, total: c.total }));
  return {
    month,
    label: `${NAMES[number - 1]} ${year}`,
    income: flow.income,
    expenses: flow.expenses,
    saved: flow.net,
    topCategories: categories,
    netWorth: getNetWorth(db, { asOf: range.to }).netWorth,
    missingStatements: statementCoverage(db).reduce((n, a) => n + a.missing.length, 0),
    needAttention: computeInsights(db).filter((i) => i.severity === 'attention').length,
  };
}

// The text of the mail. The subject carries no amounts, and nothing here is advice.
export function summaryEmail(summary: ReturnType<typeof monthlySummary>, link: string) {
  const lines = [
    `Your money in ${summary.label}`,
    '',
    `Income:   ${formatAmount(summary.income)}`,
    `Spending: ${formatAmount(summary.expenses)}`,
    `Saved:    ${formatAmount(summary.saved)}`,
    `Net worth at the end of the month: ${formatAmount(summary.netWorth)}`,
  ];
  if (summary.topCategories.length > 0) {
    lines.push('', 'Where most of it went:');
    for (const c of summary.topCategories) lines.push(`  ${c.name}: ${formatAmount(c.total)}`);
  }
  if (summary.missingStatements > 0) lines.push('', `${summary.missingStatements} month${summary.missingStatements === 1 ? '' : 's'} of statements are missing, so some figures may be incomplete.`);
  if (summary.needAttention > 0) lines.push('', `${summary.needAttention} thing${summary.needAttention === 1 ? '' : 's'} need${summary.needAttention === 1 ? 's' : ''} your attention.`);
  lines.push('', `Open Ledgerly: ${link}`, '', 'You get this because you turned on the monthly summary in Settings. Turn it off there at any time.');
  return { subject: `Your Ledgerly summary for ${summary.label}`, text: lines.join('\n') };
}
