import { accounts, investmentTransactions, manualAssets, positions, type Db } from '@ledgerly/db';
import { depositValue } from './assets.ts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from './errors.ts';
import { payslipTotals } from './payslips.ts';
import { getSetting, setSetting } from './settings.ts';

// Indian rules as they stand for sales from 23 July 2024. They change, so the
// figures here are an estimate to plan with, never a tax return.
export const RATES = {
  equityShortTerm: 0.2,
  equityLongTerm: 0.125,
  equityLongTermExemption: 125_000_00,
  equityLongTermDays: 365,
};

// Equity funds sold before 23 July 2024 were taxed at the old rates, and the yearly
// exemption was ₹1 lakh until 2023-24. A year can hold sales under both.
export const RATE_CHANGE = '2024-07-23';
export const EARLIER_RATES = { equityShortTerm: 0.15, equityLongTerm: 0.1, equityLongTermExemption: 100_000_00 };
const exemptionFor = (fy: string) => (Number(fy.slice(0, 4)) >= 2024 ? RATES.equityLongTermExemption : EARLIER_RATES.equityLongTermExemption);

export const SECTIONS = {
  '80C': { label: 'Section 80C (PPF, ELSS, life insurance, tuition and similar)', limit: 150_000_00 },
  '80CCD1B': { label: 'Section 80CCD(1B) (extra NPS)', limit: 50_000_00 },
  '80D': { label: 'Section 80D (health insurance)', limit: null },
  '80G': { label: 'Section 80G (donations)', limit: null },
  '24b': { label: 'Section 24(b) (home loan interest)', limit: 200_000_00 },
} as const;
export type Section = keyof typeof SECTIONS;

export function fyOf(date: string) {
  const year = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
export const fyRange = (fy: string) => {
  const start = Number(fy.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
};
export const fySchema = z.string().regex(/^\d{4}-\d{2}$/, 'Use a year like 2026-27');

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

type Lot = { date: string; units: number; cost: number };
export type Sale = {
  fund: string;
  isin: string | null;
  boughtOn: string;
  assetClass: string;
  date: string;
  units: number;
  proceeds: number;
  cost: number;
  gain: number;
  heldDays: number;
  term: 'short' | 'long';
};

// First in, first out, per fund, from the purchases and sales in your imported
// statements. A sale that reaches back past the first known purchase has part
// of its cost missing; that part is counted separately and left out of the gain.
export function capitalGains(db: Db, fy: string) {
  fySchema.parse(fy);
  const { from, to } = fyRange(fy);

  const rows = db
    .select({ tx: investmentTransactions, name: positions.name, isin: positions.isin, assetClass: positions.assetClass })
    .from(investmentTransactions)
    .innerJoin(positions, sql`${positions.id} = ${investmentTransactions.positionId}`)
    .orderBy(investmentTransactions.positionId, investmentTransactions.date, investmentTransactions.id)
    .all();

  const lots = new Map<number, Lot[]>();
  const sales: Sale[] = [];
  let unmatchedProceeds = 0;

  for (const { tx, name, isin, assetClass } of rows) {
    const queue = lots.get(tx.positionId) ?? [];
    lots.set(tx.positionId, queue);
    const buying = tx.kind === 'purchase' || tx.kind === 'sip' || tx.kind === 'switch_in';
    const selling = tx.kind === 'redemption' || tx.kind === 'switch_out';
    if (buying && tx.units > 0) {
      queue.push({ date: tx.date, units: tx.units, cost: tx.amount });
    } else if (selling && tx.units !== 0) {
      let remaining = Math.abs(tx.units);
      const total = remaining;
      while (remaining > 0 && queue.length > 0) {
        const lot = queue[0]!;
        const used = Math.min(lot.units, remaining);
        const cost = Math.round((lot.cost * used) / lot.units);
        const proceeds = Math.round((tx.amount * used) / total);
        if (tx.date >= from && tx.date <= to) {
          const heldDays = days(lot.date, tx.date);
          sales.push({
            fund: name,
            isin,
            boughtOn: lot.date,
            assetClass,
            date: tx.date,
            units: used,
            proceeds,
            cost,
            gain: proceeds - cost,
            heldDays,
            term: heldDays > RATES.equityLongTermDays ? 'long' : 'short',
          });
        }
        lot.cost -= cost;
        lot.units -= used;
        remaining -= used;
        if (lot.units === 0) queue.shift();
      }
      if (remaining > 0 && tx.date >= from && tx.date <= to) unmatchedProceeds += Math.round((tx.amount * remaining) / total);
    }
  }

  const sum = (list: Sale[]) => list.reduce((s, x) => s + x.gain, 0);
  const equity = sales.filter((s) => s.assetClass === 'equity');
  const others = sales.filter((s) => s.assetClass !== 'equity');
  let stcg = sum(equity.filter((s) => s.term === 'short'));
  let ltcg = sum(equity.filter((s) => s.term === 'long'));
  // A short-term loss can reduce a long-term gain; a long-term loss only reduces long-term gains.
  if (stcg < 0) {
    ltcg += stcg;
    stcg = 0;
  }
  const lossToCarry = ltcg < 0 ? -ltcg : 0;
  ltcg = Math.max(0, ltcg);
  const exemption = exemptionFor(fy);
  const taxableLtcg = Math.max(0, ltcg - exemption);

  // A year with sales on both sides of the rate change is taxed at a blend, weighted by
  // how much of the gain came from each side.
  const blended = (list: Sale[], now: number, before: number) => {
    const gain = (after: boolean) => list.filter((s) => (s.date >= RATE_CHANGE) === after).reduce((t, s) => t + Math.max(0, s.gain), 0);
    const [late, early] = [gain(true), gain(false)];
    return late + early === 0 ? now : (late * now + early * before) / (late + early);
  };
  const shortRate = blended(equity.filter((s) => s.term === 'short'), RATES.equityShortTerm, EARLIER_RATES.equityShortTerm);
  const longRate = blended(equity.filter((s) => s.term === 'long'), RATES.equityLongTerm, EARLIER_RATES.equityLongTerm);

  return {
    fy,
    sales,
    complete: unmatchedProceeds === 0,
    unmatchedProceeds,
    equity: {
      shortTermGain: stcg,
      longTermGain: ltcg,
      longTermExempt: Math.min(ltcg, exemption),
      exemption,
      shortTermRate: shortRate,
      longTermRate: longRate,
      lossToCarryForward: lossToCarry,
      estimatedTax: Math.round(stcg * shortRate + taxableLtcg * longRate),
    },
    // Debt, gold, hybrid and other funds are taxed in ways that depend on when
    // they were bought and what they hold, so only the gain is shown.
    other: { gain: sum(others), proceeds: others.reduce((s, x) => s + x.proceeds, 0) },
  };
}

// For filing: every sale with the fund's ISIN, when it was bought and sold, and what it cost,
// which is what the capital gains schedule of a return asks for. Plain numbers, so a
// spreadsheet can total them.
export function capitalGainsCsv(db: Db, fy: string) {
  const g = capitalGains(db, fy);
  const cell = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  const rupees = (paise: number) => `${paise < 0 ? '-' : ''}${Math.floor(Math.abs(paise) / 100)}.${String(Math.abs(paise) % 100).padStart(2, '0')}`;
  const lines = [['Fund', 'ISIN', 'Fund type', 'Bought on', 'Sold on', 'Units', 'Cost (INR)', 'Sale value (INR)', 'Gain (INR)', 'Days held', 'Term'].join(',')];
  for (const sale of g.sales) {
    lines.push(
      [cell(sale.fund), sale.isin ?? '', sale.assetClass, sale.boughtOn, sale.date, (sale.units / 1_000_000).toFixed(3), rupees(sale.cost), rupees(sale.proceeds), rupees(sale.gain), sale.heldDays, sale.term === 'long' ? 'Long term' : 'Short term'].join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ---- Deductions --------------------------------------------------------------

const MAP_KEY = 'tax.sections';
export function getSectionMap(db: Db): Record<string, Section> {
  try {
    return JSON.parse(getSetting(db, MAP_KEY) ?? '{}') as Record<string, Section>;
  } catch {
    return {};
  }
}

export function setSectionMap(db: Db, map: Record<string, Section | null>) {
  const clean: Record<string, Section> = {};
  for (const [id, section] of Object.entries(map)) {
    if (section === null) continue;
    if (!(section in SECTIONS)) throw new DomainError('invalid', `Unknown section: ${section}`);
    clean[id] = section;
  }
  setSetting(db, MAP_KEY, JSON.stringify(clean));
}

// What counts toward each deduction this year: the spending categories you
// have assigned to a section, plus purchases of tax-saving (ELSS) funds for
// 80C. Only the old regime allows these, and each section has its own limit.
export function deductions(db: Db, fy: string) {
  fySchema.parse(fy);
  const { from, to } = fyRange(fy);
  const map = getSectionMap(db);

  const spent = db.all<{ id: number; name: string; total: number }>(sql`
    SELECT a.id AS id, a.name AS name, COALESCE(SUM(p.amount), 0) AS total
    FROM accounts a JOIN postings p ON p.account_id = a.id JOIN transactions t ON t.id = p.transaction_id
    WHERE a.type = 'expense' AND t.date BETWEEN ${from} AND ${to}
    GROUP BY a.id`);
  const elss = db
    .select({ amount: investmentTransactions.amount, name: positions.name, kind: investmentTransactions.kind, date: investmentTransactions.date })
    .from(investmentTransactions)
    .innerJoin(positions, sql`${positions.id} = ${investmentTransactions.positionId}`)
    .all()
    .filter((r) => (r.kind === 'purchase' || r.kind === 'sip') && r.date >= from && r.date <= to && /elss|tax ?saver/i.test(r.name))
    .reduce((s, r) => s + r.amount, 0);

  return (Object.keys(SECTIONS) as Section[]).map((section) => {
    const parts = spent.filter((c) => map[String(c.id)] === section && c.total > 0).map((c) => ({ source: c.name, amount: c.total }));
    if (section === '80C' && elss > 0) parts.push({ source: 'Tax-saving (ELSS) fund purchases', amount: elss });
    const total = parts.reduce((s, p) => s + p.amount, 0);
    const { limit, label } = SECTIONS[section];
    return { section, label, limit, total, counted: limit === null ? total : Math.min(total, limit), room: limit === null ? null : Math.max(0, limit - total), parts };
  });
}

// Interest a fixed deposit earned in the year, worked out from its rate the same
// way its value grows. It is taxed as income at your slab rate, whether or not
// the bank has paid it out yet. Banks deduct TDS once a year's interest passes a
// limit; that limit is shown, and the TDS itself is not tracked.
export const TDS_LIMIT = 40_000_00;

export function fdInterest(db: Db, fy: string, input: { today?: string } = {}) {
  fySchema.parse(fy);
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const { from, to } = fyRange(fy);
  const rows = db
    .select({ asset: manualAssets, name: accounts.name })
    .from(manualAssets)
    .innerJoin(accounts, sql`${accounts.id} = ${manualAssets.accountId}`)
    .all();

  const items = rows.flatMap(({ asset, name }) => {
    if (asset.rateBps === null || asset.invested === null || !asset.startDate) return [];
    // Interest runs from the later of the start and the start of the year, to the earliest of maturity, year end and today.
    const begin = asset.startDate > from ? asset.startDate : from;
    let end = to < today ? to : today;
    if (asset.maturityDate && asset.maturityDate < end) end = asset.maturityDate;
    if (begin >= end) return [];
    const interest = depositValue(asset.invested, asset.rateBps, asset.startDate, end) - depositValue(asset.invested, asset.rateBps, asset.startDate, begin);
    return interest > 0 ? [{ name, principal: asset.invested, rateBps: asset.rateBps, from: begin, to: end, interest }] : [];
  });
  const total = items.reduce((sum, i) => sum + i.interest, 0);
  return { items, total, tdsLimit: TDS_LIMIT, overTdsLimit: total > TDS_LIMIT, upToToday: to >= today };
}

export function taxSummary(db: Db, fy = fyOf(new Date().toISOString().slice(0, 10))) {
  const spendCategories = db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(sql`${accounts.type} = 'expense' AND ${accounts.isArchived} = 0`)
    .all();
  return { fy, gains: capitalGains(db, fy), fdInterest: fdInterest(db, fy), deductions: deductions(db, fy), map: getSectionMap(db), categories: spendCategories };
}

// ---- Everything for the accountant -----------------------------------------------

type Line = { date: string; description: string; category: string; amount: number };

// Transactions in a category over the year, one line each.
function categoryLines(db: Db, fy: string, categoryIds: number[]): Line[] {
  if (categoryIds.length === 0) return [];
  const { from, to } = fyRange(fy);
  return db.all<Line>(sql`
    SELECT t.date AS date, t.description AS description, a.name AS category, ABS(p.amount) AS amount
    FROM postings p JOIN accounts a ON a.id = p.account_id JOIN transactions t ON t.id = p.transaction_id
    WHERE a.id IN (${sql.join(categoryIds.map((id) => sql`${id}`), sql`, `)}) AND t.date BETWEEN ${from} AND ${to}
    ORDER BY t.date, t.id`);
}

const idsNamed = (db: Db, type: 'income' | 'expense', name: string) =>
  db.all<{ id: number }>(sql`SELECT id FROM accounts WHERE type = ${type} AND name = ${name}`).map((r) => r.id);

// What a return is worked out from, for one financial year, with the lines behind each total.
export function taxPack(db: Db, fy: string) {
  fySchema.parse(fy);
  const map = getSectionMap(db);
  const sections = deductions(db, fy).map((d) => ({
    ...d,
    lines: categoryLines(db, fy, Object.entries(map).filter(([, s]) => s === d.section).map(([id]) => Number(id))),
  }));
  const interest = categoryLines(db, fy, idsNamed(db, 'income', 'Interest'));
  const taxesPaid = categoryLines(db, fy, idsNamed(db, 'expense', 'Taxes'));
  return {
    fy,
    gains: capitalGains(db, fy),
    fdInterest: fdInterest(db, fy),
    interestReceived: { lines: interest, total: interest.reduce((s, l) => s + l.amount, 0) },
    taxesPaid: { lines: taxesPaid, total: taxesPaid.reduce((s, l) => s + l.amount, 0) },
    deductions: sections,
    salary: payslipTotals(db, fyRange(fy).from, fyRange(fy).to).rows,
  };
}
