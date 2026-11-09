import { applyPrices, DomainError, getSetting, parseAmfiNav, setSetting } from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import type { Config } from './config.ts';

const AUTO_KEY = 'prices.auto';
const LAST_KEY = 'prices.lastAuto';

export const autoPricesOn = (db: Db) => getSetting(db, AUTO_KEY) === 'on';
export const setAutoPrices = (db: Db, on: boolean) => setSetting(db, AUTO_KEY, on ? 'on' : 'off');
export const lastAutoPrices = (db: Db) => getSetting(db, LAST_KEY) ?? null;

// Fetches AMFI's public daily price file and revalues the funds you hold.
// Nothing about you is sent.
export async function refreshPrices(db: Db, config: Config, fetcher: typeof fetch = fetch) {
  let text: string;
  try {
    const response = await fetcher(config.amfiUrl, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Ledgerly' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    text = await response.text();
  } catch {
    throw new DomainError('invalid', "Couldn't reach AMFI for prices. Check your internet connection and try again.");
  }
  const prices = parseAmfiNav(text);
  if (prices.size === 0) throw new DomainError('invalid', 'AMFI returned something unexpected, so no prices were changed');
  return applyPrices(db, prices);
}

// Once a day, if you turned it on and the last run is over 20 hours old.
export async function tickPrices(db: Db, config: Config, log: (message: string) => void, fetcher: typeof fetch = fetch) {
  if (config.demoMode || !autoPricesOn(db)) return;
  const last = lastAutoPrices(db);
  if (last && Date.now() - Date.parse(last) < 20 * 3600_000) return;
  try {
    const result = await refreshPrices(db, config, fetcher);
    setSetting(db, LAST_KEY, new Date().toISOString());
    log(`Prices updated: ${result.updated} funds`);
  } catch (error) {
    log(`Price update failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
