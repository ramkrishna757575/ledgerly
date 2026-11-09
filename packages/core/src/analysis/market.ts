import type { Db } from '@ledgerly/db';
import { DomainError } from '../errors.ts';
import { getHoldings } from '../investments/portfolio.ts';
import { getSetting, setSetting } from '../settings.ts';

// A broad index fund stands in for "the market", since a free, steady source of
// index levels does not exist. UTI Nifty 50 Index Fund, Direct, Growth.
export const BENCHMARK = { code: '120716', name: 'Nifty 50 (through an index fund)' };
const MARKET_KEY = 'analysis.market';

export type NavPoint = { date: string; nav: number };

// mfapi.in lists newest first, with dates written dd-mm-yyyy.
export function parseNavHistory(data: unknown): NavPoint[] {
  const rows = (data as { data?: { date?: string; nav?: string }[] })?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(row.date ?? '');
    const nav = Number(row.nav);
    return match && Number.isFinite(nav) && nav > 0 ? [{ date: `${match[3]}-${match[2]}-${match[1]}`, nav }] : [];
  });
}

// scheme code by ISIN, from AMFI's daily file
export function parseAmfiCodes(text: string) {
  const codes = new Map<string, string>();
  for (const line of text.split('\n')) {
    const cells = line.trim().split(';');
    if (cells.length < 6 || !/^\d+$/.test(cells[0]!)) continue;
    for (const isin of [cells[1], cells[2]]) {
      if (isin && /^IN[A-Z0-9]{10}$/.test(isin.trim())) codes.set(isin.trim(), cells[0]!);
    }
  }
  return codes;
}

const shiftYears = (date: string, years: number) => `${Number(date.slice(0, 4)) - years}${date.slice(4)}`;

// The NAV on a date, or the last one before it, from a newest-first history.
function navOn(history: NavPoint[], date: string) {
  return history.find((point) => point.date <= date);
}

export function trailingReturns(history: NavPoint[]) {
  const latest = history[0];
  if (!latest) return null;
  const back = (years: number) => {
    const target = shiftYears(latest.date, years);
    const point = navOn(history, target);
    // Only trust it when the history really reaches back that far.
    return point && history.at(-1)!.date <= target ? point : undefined;
  };
  const oneYear = back(1);
  const threeYear = back(3);
  const lastYear = history.filter((p) => p.date >= shiftYears(latest.date, 1));
  const high = lastYear.reduce((m, p) => Math.max(m, p.nav), 0);
  return {
    asOf: latest.date,
    return1y: oneYear ? latest.nav / oneYear.nav - 1 : null,
    cagr3y: threeYear ? (latest.nav / threeYear.nav) ** (1 / 3) - 1 : null,
    fromHigh1y: high > 0 ? latest.nav / high - 1 : null,
  };
}

export type Market = {
  fetchedAt: string;
  benchmark: ({ name: string } & NonNullable<ReturnType<typeof trailingReturns>>) | null;
  funds: { name: string; return1y: number | null; cagr3y: number | null; fromHigh1y: number | null }[];
  unmatched: number;
};

type Fetcher = (url: string) => Promise<string>;

export const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Ledgerly' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};

// Public history for the funds you hold, and for the market. The only thing
// sent out is a list of public scheme codes: nothing about you or your amounts.
export async function fetchMarket(
  db: Db,
  options: { amfiUrl: string; mfapiUrl: string; fetcher?: Fetcher; now?: string },
): Promise<Market> {
  const get = options.fetcher ?? defaultFetcher;
  let codes: Map<string, string>;
  try {
    codes = parseAmfiCodes(await get(options.amfiUrl));
  } catch {
    throw new DomainError('invalid', "Couldn't reach AMFI to look up your funds. Check your internet connection and try again.");
  }

  const history = async (code: string) => {
    try {
      return trailingReturns(parseNavHistory(JSON.parse(await get(`${options.mfapiUrl}/mf/${code}`))));
    } catch {
      return null;
    }
  };

  const holdings = getHoldings(db).holdings;
  const jobs = holdings.map((h) => ({ name: h.name, code: h.isin ? codes.get(h.isin) : undefined }));
  const [benchmark, ...results] = await Promise.all([history(BENCHMARK.code), ...jobs.map((job) => (job.code ? history(job.code) : Promise.resolve(null)))]);
  if (!benchmark && results.every((r) => r === null)) {
    throw new DomainError('invalid', "Couldn't fetch fund history. Check your internet connection and try again.");
  }

  const market: Market = {
    fetchedAt: options.now ?? new Date().toISOString(),
    benchmark: benchmark ? { name: BENCHMARK.name, ...benchmark } : null,
    funds: jobs.flatMap((job, i) => {
      const r = results[i];
      return r ? [{ name: job.name, return1y: r.return1y, cagr3y: r.cagr3y, fromHigh1y: r.fromHigh1y }] : [];
    }),
    unmatched: jobs.filter((_, i) => results[i] === null).length,
  };
  setSetting(db, MARKET_KEY, JSON.stringify(market));
  return market;
}

export function getMarket(db: Db): Market | null {
  const raw = getSetting(db, MARKET_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Market;
  } catch {
    return null;
  }
}
