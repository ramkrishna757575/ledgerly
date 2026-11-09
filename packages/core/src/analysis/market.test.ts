import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { commitInvestmentImport, getInvestmentSample, stageInvestmentStatement } from '../investments/index.ts';
import { seedDefaults } from '../seed.ts';
import { BENCHMARK, fetchMarket, getMarket, parseAmfiCodes, parseNavHistory, trailingReturns } from './market.ts';

const history = (points: [string, number][]) => ({ data: points.map(([date, nav]) => ({ date, nav: String(nav) })) });

describe('market data', () => {
  it('reads mfapi history and AMFI scheme codes', () => {
    expect(parseNavHistory(history([['04-11-2026', 150], ['bad', 1]]))).toEqual([{ date: '2026-11-04', nav: 150 }]);
    expect(parseNavHistory('nonsense')).toEqual([]);
    const amfi = 'Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date\n120716;INF789F01XA0;-;UTI Nifty;168.7;04-Nov-2026\nOpen Ended;;;\n';
    expect(parseAmfiCodes(amfi).get('INF789F01XA0')).toBe('120716');
  });

  it('works out one and three year returns and the distance from the high', () => {
    const points: [string, number][] = [['04-11-2026', 150], ['01-06-2026', 160], ['04-11-2025', 120], ['04-11-2023', 100], ['01-11-2023', 99]];
    const r = trailingReturns(parseNavHistory(history(points)))!;
    expect(r.return1y).toBeCloseTo(0.25, 5);
    expect(r.cagr3y).toBeCloseTo(1.5 ** (1 / 3) - 1, 5);
    expect(r.fromHigh1y).toBeCloseTo(150 / 160 - 1, 5);
  });

  it('does not invent a return the history cannot support', () => {
    const r = trailingReturns(parseNavHistory(history([['04-11-2026', 150], ['04-09-2026', 140]])))!;
    expect(r.return1y).toBeNull();
    expect(r.cagr3y).toBeNull();
    expect(trailingReturns([])).toBeNull();
  });
});

describe('fetching market context', () => {
  let db: ReturnType<typeof openDb>;
  beforeEach(() => {
    db = openDb(':memory:');
    seedDefaults(db);
    commitInvestmentImport(db, stageInvestmentStatement(db, getInvestmentSample('cdsl')!).id);
  });

  it('sends only public scheme codes, and keeps funds it cannot match out of the results', async () => {
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      if (url.includes('amfi')) return 'Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date\n999;INF000000001;-;Nothing;1;04-Nov-2026\n';
      return JSON.stringify(history([['04-11-2026', 150], ['04-11-2025', 120]]));
    };
    const market = await fetchMarket(db, { amfiUrl: 'https://amfi.test/NAVAll.txt', mfapiUrl: 'https://mf.test', fetcher, now: '2026-11-05T00:00:00Z' });
    expect(market.benchmark).toMatchObject({ name: BENCHMARK.name, return1y: expect.closeTo(0.25, 5) });
    expect(market.funds).toEqual([]);
    expect(market.unmatched).toBe(3);
    expect(seen).toEqual(['https://amfi.test/NAVAll.txt', `https://mf.test/mf/${BENCHMARK.code}`]);
    expect(getMarket(db)?.fetchedAt).toBe('2026-11-05T00:00:00Z');
  });

  it('says so when nothing can be reached', async () => {
    const down = async () => { throw new Error('offline'); };
    await expect(fetchMarket(db, { amfiUrl: 'x', mfapiUrl: 'y', fetcher: down })).rejects.toThrow(/AMFI/);
    const noHistory = async (url: string) => { if (url === 'x') return ''; throw new Error('offline'); };
    await expect(fetchMarket(db, { amfiUrl: 'x', mfapiUrl: 'y', fetcher: noHistory })).rejects.toThrow(/fund history/);
  });
});
