import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDigest, createAccount, digestDue, digestPeriod, ensureStarterCategories, getDigestMode, seedDefaults, setDigestMode, commitInvestmentImport, getInvestmentSample, stageInvestmentStatement } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { loadChannels, sendDigestIfDue } from './notify.ts';
import { autoPricesOn, lastAutoPrices, refreshPrices, setAutoPrices } from './prices.ts';

function books() {
  const db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  createAccount(db, { name: 'Axis Savings 4821', type: 'asset', subtype: 'bank', openingBalance: 5_00_000_00, openingDate: '2026-01-01' });
  return db;
}
const recorder = () => {
  const calls: { url: string; body: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body ?? '') });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

describe('periodic summary', () => {
  it('works out which period a day is in, and when one is due', () => {
    expect(digestPeriod('weekly', '2026-11-04')).toBe('week-2026-11-02');
    expect(digestPeriod('weekly', '2026-11-02')).toBe('week-2026-11-02');
    expect(digestPeriod('weekly', '2026-11-08')).toBe('week-2026-11-02');
    expect(digestPeriod('monthly', '2026-11-20')).toBe('2026-11');
    const db = books();
    expect(getDigestMode(db)).toBe('off');
    expect(digestDue(db, '2026-11-04')).toBeNull();
    setDigestMode(db, 'weekly');
    expect(digestDue(db, '2026-11-04')).toEqual({ mode: 'weekly', period: 'week-2026-11-02' });
  });

  it('is built from totals only, with no account or payee names', () => {
    const db = books();
    const { message } = buildDigest(db, { today: '2026-11-10' });
    expect(message).toMatch(/Net worth ₹5,00,000/);
    expect(message).not.toMatch(/Axis|4821/);
  });

  it('goes out once per period, and again in the next', async () => {
    const db = books();
    setDigestMode(db, 'weekly');
    const channels = loadChannels({ NOTIFY_NTFY_URL: 'https://ntfy.sh/mine' });
    const { calls, fetcher } = recorder();
    expect(await sendDigestIfDue(db, channels, fetcher, '2026-11-04')).toMatchObject({ ok: true });
    expect(await sendDigestIfDue(db, channels, fetcher, '2026-11-06')).toBeNull();
    expect(await sendDigestIfDue(db, channels, fetcher, '2026-11-09')).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatch(/Net worth/);
    expect(await sendDigestIfDue(books(), [], fetcher, '2026-11-04')).toBeNull();
  });

  it('is tried again if it could not be delivered', async () => {
    const db = books();
    setDigestMode(db, 'monthly');
    const channels = loadChannels({ NOTIFY_NTFY_URL: 'https://ntfy.sh/mine' });
    const down = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(await sendDigestIfDue(db, channels, down, '2026-11-01')).toMatchObject({ ok: false });
    expect(await sendDigestIfDue(db, channels, recorder().fetcher, '2026-11-01')).toMatchObject({ ok: true });
  });
});

describe('daily prices', () => {
  const config = { ...loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'ledgerly-prices-')), AMFI_URL: 'https://amfi.test/NAVAll.txt' }) };

  it('is off until you turn it on, and refreshes prices from the public file', async () => {
    const db = books();
    commitInvestmentImport(db, stageInvestmentStatement(db, getInvestmentSample('cdsl')!).id);
    expect(autoPricesOn(db)).toBe(false);
    setAutoPrices(db, true);
    expect(autoPricesOn(db)).toBe(true);
    expect(lastAutoPrices(db)).toBeNull();

    const file = 'Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date\n111111;INF000D01AA1;-;Demo Liquid Fund;105.0000;10-Nov-2026\n';
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      seen.push(url);
      return new Response(file, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await refreshPrices(db, config, fetcher)).toMatchObject({ updated: 1 });
    expect(seen).toEqual(['https://amfi.test/NAVAll.txt']);

    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(refreshPrices(db, config, down)).rejects.toThrow(/reach AMFI/);
  });
});
