import { readFileSync } from 'node:fs';
import { accounts, investmentTransactions, openDb, positions, transactions, type Db } from '@ledgerly/db';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, createSimpleTransaction, getBalances, getCashFlow, getNetWorth, seedDefaults } from '../index.ts';
import {
  applyPrices,
  commitInvestmentImport,
  discardInvestmentImport,
  getHoldings,
  getInvestmentImport,
  listInvestmentImports,
  parseAmfiNav,
  rebuildValuations,
  stageInvestmentStatement,
  undoInvestmentImport,
} from './portfolio.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const file = (sha256: string) => ({ sha256, filename: `${sha256}.pdf`, mimeType: 'application/pdf', size: 1, storedName: `${sha256}.pdf` });

const CAS_TOTAL = 17733250;
const SCRIPBOX_TOTAL = 17857500;

let db: Db;

const stageCas = (sha = 'cas') => stageInvestmentStatement(db, { text: fixture('cdsl-cas.txt'), file: file(sha) });
const stageScripbox = (sha = 'scripbox') => stageInvestmentStatement(db, { text: fixture('scripbox-portfolio.txt'), file: file(sha) });
const balanceOf = (name: string, asOf?: string) => getBalances(db, { asOf }).find((b) => b.name === name)?.balance;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
});

describe('reviewing a statement before it is imported', () => {
  it('shows what it found, and that nothing has changed yet', () => {
    const staged = stageCas();
    expect(staged).toMatchObject({ status: 'staged', source: 'cdsl', asOf: '2026-09-30', total: CAS_TOTAL, statedTotal: CAS_TOTAL, transactions: 3, warnings: [] });
    expect(staged.holdings).toHaveLength(3);
    expect(staged.holdings.every((h) => h.isNew)).toBe(true);
    expect(db.select().from(positions).all()).toEqual([]);
    expect(getBalances(db).filter((b) => b.type === 'asset')).toEqual([]);
  });

  it('refuses something that is not an investment statement', () => {
    expect(() => stageInvestmentStatement(db, { text: 'Dear customer', file: file('x') })).toThrow(/not an investment statement/);
  });

  it('refuses the same file twice, but allows it again once undone', () => {
    const staged = stageCas();
    expect(() => stageCas()).toThrow(/already imported/);
    commitInvestmentImport(db, staged.id);
    expect(() => stageCas()).toThrow(/already imported/);
    undoInvestmentImport(db, staged.id);
    expect(stageCas().status).toBe('staged');
  });

  it('can be thrown away, and says which stored file to delete', () => {
    const staged = stageCas();
    expect(discardInvestmentImport(db, staged.id)).toBe('cas.pdf');
    expect(listInvestmentImports(db)).toEqual([]);
    const done = stageCas();
    commitInvestmentImport(db, done.id);
    expect(() => discardInvestmentImport(db, done.id)).toThrow(/already finished/);
  });
});

describe('importing a statement', () => {
  it('values the investments in the ledger without counting it as income or spending', () => {
    commitInvestmentImport(db, stageCas().id);

    expect(balanceOf('Mutual funds')).toBe(CAS_TOTAL);
    expect(db.select().from(accounts).where(eq(accounts.name, 'Mutual funds')).get()).toMatchObject({ type: 'asset', subtype: 'investment' });
    expect(getBalances(db).find((b) => b.name === 'Unrealised Gains')).toMatchObject({ type: 'equity' });
    expect(getNetWorth(db)).toEqual({ assets: CAS_TOTAL, liabilities: 0, netWorth: CAS_TOTAL });
    expect(getCashFlow(db, { from: '2000-01-01', to: '2100-01-01' })).toEqual({ income: 0, expenses: 0, net: 0 });
  });

  it('lines an existing investment account up with market value, whatever it held before', () => {
    const funds = createAccount(db, { name: 'My Funds', type: 'asset', subtype: 'investment', openingBalance: 10000000, openingDate: '2026-01-01' });
    commitInvestmentImport(db, stageCas().id);
    expect(balanceOf('My Funds')).toBe(CAS_TOTAL);
    expect(db.select().from(accounts).where(eq(accounts.name, 'Mutual funds')).get()).toBeUndefined();
    expect(getBalances(db, { asOf: '2026-09-29' }).find((b) => b.id === funds.id)?.balance).toBe(10000000);
  });

  it('can be told which account to use, and only an asset account', () => {
    const card = createAccount(db, { name: 'Card', type: 'liability', subtype: 'credit_card' });
    const target = createAccount(db, { name: 'Brokerage', type: 'asset', subtype: 'investment' });
    const staged = stageCas();
    expect(() => commitInvestmentImport(db, staged.id, { accountId: card.id })).toThrow(/asset account/);
    commitInvestmentImport(db, staged.id, { accountId: target.id });
    expect(balanceOf('Brokerage')).toBe(CAS_TOTAL);
  });

  it('keeps what you invested, what it is worth, and how it is split', () => {
    commitInvestmentImport(db, stageCas().id);
    const { holdings, summary, allocation } = getHoldings(db);

    expect(holdings.map((h) => [h.value, h.invested])).toEqual([[12193250, 10000000], [4040000, 4200000], [1500000, 1400000]]);
    expect(summary).toMatchObject({ value: CAS_TOTAL, invested: 15600000, gain: 2133250, complete: true, asOf: '2026-09-30' });
    expect(summary.gainRatio).toBeCloseTo(2133250 / 15600000, 6);
    expect(allocation.reduce((sum, a) => sum + a.share, 0)).toBeCloseTo(1, 9);
    expect(holdings.every((h) => h.xirrBps === null)).toBe(true);
  });

  it('records the transactions in the statement, once', () => {
    const first = stageCas('one');
    commitInvestmentImport(db, first.id);
    expect(db.select().from(investmentTransactions).all()).toHaveLength(3);

    // The same period again, from another file, adds no duplicates.
    commitInvestmentImport(db, stageCas('two').id);
    expect(db.select().from(investmentTransactions).all()).toHaveLength(3);
    expect(getHoldings(db).holdings).toHaveLength(3);
  });

  it('cannot be committed twice', () => {
    const staged = stageCas();
    commitInvestmentImport(db, staged.id);
    expect(() => commitInvestmentImport(db, staged.id)).toThrow(/already finished/);
  });
});

describe('a second statement for the same funds', () => {
  beforeEach(() => {
    commitInvestmentImport(db, stageCas().id);
  });

  it('is matched to the funds you already have, by folio', () => {
    const staged = stageScripbox();
    expect(staged.holdings.every((h) => !h.isNew)).toBe(true);
    commitInvestmentImport(db, staged.id);
    expect(db.select().from(positions).all()).toHaveLength(3);
  });

  it('revalues at each date, so the history follows the statements', () => {
    commitInvestmentImport(db, stageScripbox().id);
    expect(balanceOf('Mutual funds', '2026-09-30')).toBe(CAS_TOTAL);
    expect(balanceOf('Mutual funds')).toBe(SCRIPBOX_TOTAL);
    expect(getHoldings(db).summary).toMatchObject({ value: SCRIPBOX_TOTAL, asOf: '2026-11-09' });
    const revaluations = db.select().from(transactions).where(eq(transactions.source, `valuation:${db.select().from(accounts).where(eq(accounts.name, 'Mutual funds')).get()!.id}`)).all();
    expect(revaluations.map((t) => t.date)).toEqual(['2026-09-30', '2026-11-09']);
  });

  it('adds the return and the asset class that only this report knows', () => {
    commitInvestmentImport(db, stageScripbox().id);
    const index = getHoldings(db).holdings.find((h) => h.name.includes('Sample Index'))!;
    expect(index).toMatchObject({ assetClass: 'equity', invested: 10000000, xirrBps: 1820, xirrSource: 'reported', value: 12407500 });
    // The authoritative units and ISIN from the first statement are kept.
    expect(index.isin).toBe('INF000S02BB2');
  });

  it('can be undone, taking the ledger back to the earlier statement', () => {
    const staged = stageScripbox();
    commitInvestmentImport(db, staged.id);
    undoInvestmentImport(db, staged.id);
    expect(balanceOf('Mutual funds')).toBe(CAS_TOTAL);
    expect(getHoldings(db).summary.value).toBe(CAS_TOTAL);
    expect(getInvestmentImport(db, staged.id).status).toBe('undone');
  });

  it('keeps the funds when the older statement is undone, and drops them when none is left', () => {
    const scripbox = stageScripbox();
    commitInvestmentImport(db, scripbox.id);
    undoInvestmentImport(db, listInvestmentImports(db).find((i) => i.source === 'cdsl')!.id);
    expect(db.select().from(positions).all()).toHaveLength(3);
    expect(balanceOf('Mutual funds')).toBe(SCRIPBOX_TOTAL);

    undoInvestmentImport(db, scripbox.id);
    expect(db.select().from(positions).all()).toEqual([]);
    expect(balanceOf('Mutual funds')).toBe(0);
    expect(db.select().from(transactions).where(eq(transactions.source, 'valuation:1')).all()).toEqual([]);
  });
});

describe('the ledger and the market value', () => {
  it('follows contributions between statements, and settles at the next one', () => {
    commitInvestmentImport(db, stageCas().id);
    const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 5000000 });
    const funds = db.select().from(accounts).where(eq(accounts.name, 'Mutual funds')).get()!;
    createSimpleTransaction(db, { kind: 'transfer', date: '2026-10-05', description: 'SIP', accountId: bank.id, counterAccountId: funds.id, amount: 1500000 });

    expect(balanceOf('Mutual funds')).toBe(CAS_TOTAL + 1500000);
    commitInvestmentImport(db, stageScripbox().id);
    expect(balanceOf('Mutual funds')).toBe(SCRIPBOX_TOTAL);
    expect(balanceOf('Bank')).toBe(3500000);
  });

  it('is rebuilt to the same result every time', () => {
    commitInvestmentImport(db, stageCas().id);
    commitInvestmentImport(db, stageScripbox().id);
    const funds = db.select().from(accounts).where(eq(accounts.name, 'Mutual funds')).get()!;
    const count = () => db.select().from(transactions).where(and(eq(transactions.source, `valuation:${funds.id}`))).all().length;
    const before = count();
    rebuildValuations(db, funds.id);
    rebuildValuations(db, funds.id);
    expect(count()).toBe(before);
    expect(balanceOf('Mutual funds')).toBe(SCRIPBOX_TOTAL);
  });
});

describe('working out a return', () => {
  it('uses the money in and out when the whole history is known, and says so', () => {
    commitInvestmentImport(db, stageCas().id);
    const index = db.select().from(positions).all().find((p) => p.name.includes('Sample Index'))!;
    const importId = listInvestmentImports(db)[0]!.id;
    db.update(positions).set({ historyFrom: '2025-11-05' }).where(eq(positions.id, index.id)).run();
    // 1,00,000 put in a year before the statement date, and the statement's own 23,456.70 SIP.
    db.insert(investmentTransactions).values({ importId, positionId: index.id, date: '2025-11-05', kind: 'purchase', amount: 10000000, units: 1_000_000_000, description: 'Lump sum', fingerprint: 'manual' }).run();

    const holding = getHoldings(db).holdings.find((h) => h.id === index.id)!;
    expect(holding.xirrSource).toBe('calculated');
    // 1,23,456.70 went in and it is worth 1,21,932.50, so a small loss over about 11 months.
    expect(holding.xirrBps).toBe(-167);
  });

  it('does not make one up when the history is incomplete', () => {
    commitInvestmentImport(db, stageCas().id);
    expect(getHoldings(db).holdings.every((h) => h.xirrSource === null)).toBe(true);
  });
});

describe('prices', () => {
  const amfi = `Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Large Cap Fund)

Demo Mutual Fund

111111;INF000D01AA1;-;Demo Liquid Fund;Regular Plan;Growth Option;105.0000;10-Nov-2026
222222;INF000S02BB2;INF000S02XX9;Sample Index Fund;Regular Plan;Growth Option;102.0000;10-Nov-2026
333333;INF000E03CC3;-;Example Debt Fund;Regular Plan;Growth Option;49.0000;05-Nov-2026
444444;INF000Z99ZZ9;-;Unrelated Fund;Regular Plan;Growth Option;10.0000;10-Nov-2026
555555;-;-;Fund without an ISIN;Regular Plan;Growth Option;10.0000;10-Nov-2026
`;

  it('reads the daily price file by ISIN, whichever column it is in', () => {
    const prices = parseAmfiNav(amfi);
    expect(prices.get('INF000D01AA1')).toEqual({ nav: 105_000_000, date: '2026-11-10' });
    expect(prices.get('INF000S02XX9')).toEqual({ nav: 102_000_000, date: '2026-11-10' });
    expect(prices.size).toBe(5);
  });

  it('revalues holdings at newer prices only, and leaves the rest alone', () => {
    commitInvestmentImport(db, stageCas().id);
    commitInvestmentImport(db, stageScripbox().id);

    const result = applyPrices(db, parseAmfiNav(amfi));
    expect(result).toEqual({ updated: 2, skipped: 1, asOf: '2026-11-10' });

    const holdings = getHoldings(db).holdings;
    // 150.00 units at 105 and 1,234.57 units at 102 are newer than the report. The third price is older, so it stays.
    expect(holdings.find((h) => h.name.includes('Liquid'))).toMatchObject({ value: 1575000, source: 'amfi', invested: 1400000 });
    expect(holdings.find((h) => h.name.includes('Sample Index'))?.value).toBe(12592614);
    expect(holdings.find((h) => h.name.includes('Example Debt'))?.source).toBe('scripbox');
    expect(balanceOf('Mutual funds')).toBe(getHoldings(db).summary.value);

    // The same prices again change nothing.
    expect(applyPrices(db, parseAmfiNav(amfi))).toEqual({ updated: 0, skipped: 3, asOf: null });
  });

  it('keeps the reported return after a price update', () => {
    commitInvestmentImport(db, stageCas().id);
    commitInvestmentImport(db, stageScripbox().id);
    applyPrices(db, parseAmfiNav(amfi));
    expect(getHoldings(db).holdings.find((h) => h.name.includes('Sample Index'))).toMatchObject({ xirrBps: 1820, xirrSource: 'reported' });
  });
});
