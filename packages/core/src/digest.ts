import type { Db } from '@ledgerly/db';
import { getNetWorth } from './accounts.ts';
import { surplusCash } from './analysis/surplus.ts';
import { budgetStatus } from './budgets.ts';
import { cardDues } from './cards.ts';
import { forecast } from './forecast.ts';
import { formatAmount } from './money.ts';
import { recurringPayments } from './recurring.ts';
import { getSetting, setSetting } from './settings.ts';

export const DIGEST_MODES = ['off', 'weekly', 'monthly'] as const;
export type DigestMode = (typeof DIGEST_MODES)[number];
const MODE_KEY = 'alerts.digest';
const SENT_KEY = 'alerts.digest.sent';

export function getDigestMode(db: Db): DigestMode {
  const value = getSetting(db, MODE_KEY);
  return (DIGEST_MODES as readonly string[]).includes(value ?? '') ? (value as DigestMode) : 'off';
}
export const setDigestMode = (db: Db, mode: DigestMode) => setSetting(db, MODE_KEY, mode);

const rupees = (paise: number) => formatAmount(paise).replace(/\.00$/, '');
const daysAgo = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

// Which period a digest belongs to, so one goes out per week or per month.
export function digestPeriod(mode: DigestMode, date: string) {
  if (mode === 'monthly') return date.slice(0, 7);
  const d = new Date(`${date}T00:00:00Z`);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
  return `week-${monday.toISOString().slice(0, 10)}`;
}

// Whether one is due: weekly digests go out on Mondays and monthly ones on the
// first, or on the next check after that if the machine was off.
export function digestDue(db: Db, date: string) {
  const mode = getDigestMode(db);
  if (mode === 'off') return null;
  const period = digestPeriod(mode, date);
  return getSetting(db, SENT_KEY) === `${mode}:${period}` ? null : { mode, period };
}
export const markDigestSent = (db: Db, mode: DigestMode, period: string) => setSetting(db, SENT_KEY, `${mode}:${period}`);

// A short summary with totals only: no payee or account names.
export function buildDigest(db: Db, input: { today?: string } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = [];

  const now = getNetWorth(db, { asOf: today }).netWorth;
  const before = getNetWorth(db, { asOf: daysAgo(today, 30) }).netWorth;
  lines.push(`Net worth ${rupees(now)}${before !== 0 ? ` (${now >= before ? '+' : '−'}${rupees(Math.abs(now - before))} in 30 days)` : ''}`);

  const idle = surplusCash(db, { today });
  if (idle.status === 'surplus') lines.push(`Idle cash ${rupees(idle.surplus!)} above your ${idle.bufferMonths}-month buffer`);
  else if (idle.status === 'short') lines.push(`${rupees(-idle.surplus!)} short of your ${idle.bufferMonths}-month buffer`);

  const soon = recurringPayments(db, { today }).filter((b) => b.status === 'upcoming' && b.dueIn <= 7);
  const cards = cardDues(db, { today }).filter((c) => c.daysToDue <= 7);
  const due = soon.reduce((t, b) => t + b.amount, 0) + cards.reduce((t, c) => t + c.remaining, 0);
  if (soon.length + cards.length > 0) lines.push(`${soon.length + cards.length} payment${soon.length + cards.length === 1 ? '' : 's'} due this week, ${rupees(due)}`);

  const budgets = budgetStatus(db, { today });
  const over = budgets.items.filter((i) => i.state === 'over').length;
  const close = budgets.items.filter((i) => i.state === 'watch').length;
  if (over + close > 0) lines.push(`Budgets: ${over} over, ${close} close to the limit`);

  const ahead = forecast(db, { today, days: 30 });
  if (ahead.firstBelowZero) lines.push(`Bank balance is on course to run out around ${ahead.firstBelowZero}`);
  else if (ahead.includesEverydaySpending || ahead.events.length > 0) lines.push(`Lowest bank balance in the next 30 days: ${rupees(ahead.lowest.balance)}`);

  return { title: 'Ledgerly summary', message: lines.map((l) => `• ${l}`).join('\n') };
}
