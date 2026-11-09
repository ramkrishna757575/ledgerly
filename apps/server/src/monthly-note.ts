import { getSetting, listAnalyses, runAnalysis, setSetting } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { Config } from './config.ts';

const KEY = 'ai.monthly';
// Statements for the month just ended mostly land in the first days of the next one.
const FROM_DAY = 5;

export const monthlyOn = (db: Db) => getSetting(db, KEY) === 'on';
export const setMonthlyOn = (db: Db, on: boolean) => setSetting(db, KEY, on ? 'on' : 'off');

// Once a month, writes a fresh money check-in by itself, so it is waiting on the
// Dashboard without anyone pressing a button. Sends the same summary a manual review
// does, only for people who turned this on.
export async function tickMonthlyNote(db: Db, config: Config, log: (m: string) => void, now = new Date()) {
  if (!config.ai || config.demoMode || !monthlyOn(db) || now.getDate() < FROM_DAY) return;
  const latest = listAnalyses(db, 1)[0];
  if (latest && latest.createdAt.slice(0, 7) === now.toISOString().slice(0, 7)) return;
  try {
    await runAnalysis(db, config.ai, { includeMarket: false });
    log('Wrote this month\'s money check-in');
  } catch (error) {
    log(`Could not write this month's check-in: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
