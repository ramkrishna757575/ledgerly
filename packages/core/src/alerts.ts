import type { Db } from '@ledgerly/db';
import { computeInsights, type Insight } from './insights.ts';
import { getSetting, setSetting } from './settings.ts';

// Findings worth a message when you are not looking at the app. Tidying jobs
// (sort these, review that) stay on the dashboard.
export const ALERT_KINDS = {
  bills: 'Bills due in the next 7 days',
  budgets: 'A budget is over or close to its limit',
  forecast: 'The bank balance is on course to run out',
  assets: 'A deposit is about to mature',
  cards: 'A credit card bill is due soon or overdue',
  anomalies: 'Something in your spending looks off (an odd charge, a duplicate, a price rise)',
  policies: 'An insurance premium is due within 2 weeks',
  balance: 'A balance disagrees with its statement',
} as const;
export type AlertKind = keyof typeof ALERT_KINDS;

const KINDS_KEY = 'alerts.kinds';
const SENT = 'alerts.sent:';
const LOG_KEY = 'alerts.log';

export function getAlertKinds(db: Db): AlertKind[] {
  const raw = getSetting(db, KINDS_KEY);
  if (raw === undefined) return Object.keys(ALERT_KINDS) as AlertKind[];
  try {
    return (JSON.parse(raw) as string[]).filter((k): k is AlertKind => k in ALERT_KINDS);
  } catch {
    return [];
  }
}

export function setAlertKinds(db: Db, kinds: AlertKind[]) {
  setSetting(db, KINDS_KEY, JSON.stringify(kinds.filter((k) => k in ALERT_KINDS)));
}

// Insights not yet sent. Each is keyed by what it is about (a bill and its
// date, a budget and its month), so the same one is sent once, and tomorrow's
// is a new message.
export function pendingAlerts(db: Db): Insight[] {
  const wanted = new Set<string>(getAlertKinds(db));
  return computeInsights(db).filter(
    (i) =>
      wanted.has(i.kind) &&
      // Of the balance findings only a disagreement with a statement is worth a message; a card showing a credit is a prompt to look, not an emergency.
      (i.kind !== 'balance' || i.key.startsWith('statement_balance')) &&
      getSetting(db, SENT + i.key) === undefined,
  );
}

export function markSent(db: Db, insights: Insight[], now = new Date().toISOString()) {
  for (const insight of insights) setSetting(db, SENT + insight.key, now);
}

export type AlertLogEntry = { at: string; titles: string[]; channels: string[]; ok: boolean; error?: string };

export function getAlertLog(db: Db): AlertLogEntry[] {
  try {
    return JSON.parse(getSetting(db, LOG_KEY) ?? '[]') as AlertLogEntry[];
  } catch {
    return [];
  }
}

export function appendAlertLog(db: Db, entry: AlertLogEntry) {
  setSetting(db, LOG_KEY, JSON.stringify([entry, ...getAlertLog(db)].slice(0, 20)));
}

export function formatDigest(insights: Insight[]) {
  return {
    title: insights.length === 1 ? 'Ledgerly: something needs a look' : `Ledgerly: ${insights.length} things need a look`,
    message: insights.map((i) => `• ${i.title}${i.detail ? `\n  ${i.detail}` : ''}`).join('\n'),
  };
}
