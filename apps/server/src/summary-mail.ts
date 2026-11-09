import { lastSummarySent, markSummarySent, monthlySummary, monthlySummaryEnabled, previousMonth, summaryEmail } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { Config } from './config.ts';
import { canSendMail, sendMail } from './mailer.ts';

// On or after the second of the month, once, for the month just ended, to people who asked for it.
// The second, not the first, so statements that arrive in the first days are counted.
export async function tickSummary(db: Db, config: Config, email: string | null | undefined, log: (message: string) => void, today = new Date().toISOString().slice(0, 10)) {
  if (config.demoMode || !email || !canSendMail(config) || !monthlySummaryEnabled(db)) return;
  if (Number(today.slice(8, 10)) < 2) return;
  const month = previousMonth(today);
  if (lastSummarySent(db) === month) return;
  try {
    const mail = summaryEmail(monthlySummary(db, month), config.publicUrl ?? '');
    await sendMail(config, { to: email, ...mail });
    markSummarySent(db, month);
  } catch (error) {
    log(`Monthly summary not sent: ${error instanceof Error ? error.message : String(error)}`);
  }
}
