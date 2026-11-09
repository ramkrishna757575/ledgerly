import { createHash } from 'node:crypto';
import {
  accounts,
  documents,
  importBatches,
  investmentImports,
  investmentTransactions,
  positions,
  transactions,
  valuations,
  type AssetClass,
  type Db,
} from '@ledgerly/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { createAccount } from '../accounts.ts';
import { DomainError } from '../errors.ts';
import type { StoredFile } from '../imports/batches.ts';
import { formatAmount } from '../money.ts';
import { createTransaction } from '../transactions.ts';
import { valueOf } from './numbers.ts';
import { INVESTMENT_ADAPTERS, detectInvestmentAdapter } from './registry.ts';
import type { ParsedHolding, ParsedInvestmentStatement } from './types.ts';
import { xirr } from './xirr.ts';

const GAINS_ACCOUNT = 'Unrealised Gains';

type Position = typeof positions.$inferSelect;

// ---- Finding the same fund again -------------------------------------------

// Scripbox leaves off what follows the slash in a folio, so compare the part before it.
const baseFolio = (folio?: string | null) => (folio ?? '').split('/')[0]!.replace(/\D/g, '');
const fullFolio = (folio?: string | null) => (folio ?? '').replace(/[^0-9/]/g, '');

const FILLER = new Set(['fund', 'plan', 'growth', 'regular', 'direct', 'option', 'the', 'and']);
const words = (name: string) =>
  new Set(name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !FILLER.has(w)));
function similarity(a: string, b: string) {
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const total = new Set([...left, ...right]).size;
  return total === 0 ? 0 : shared / total;
}

// The ISIN names a scheme, and the folio names where you hold it. Scripbox gives
// no ISIN, so it is matched by folio and then by name.
function matchPosition(all: Position[], holding: ParsedHolding) {
  const best = (candidates: Position[]) =>
    candidates
      .map((p) => ({ p, score: (fullFolio(p.folio) === fullFolio(holding.folio) ? 1 : 0) + similarity(p.name, holding.name) }))
      .sort((a, b) => b.score - a.score)[0];

  if (holding.isin) {
    const same = all.filter((p) => p.isin === holding.isin);
    if (same.length === 1) return same[0];
    if (same.length > 1) return best(same)?.p;
  }
  const folio = baseFolio(holding.folio);
  if (!folio) return undefined;
  const sameFolio = all.filter((p) => baseFolio(p.folio) === folio);
  if (sameFolio.length === 1) return sameFolio[0];
  const closest = best(sameFolio);
  return closest && closest.score >= 0.4 ? closest.p : undefined;
}

function defaultInvestmentAccount(db: Db) {
  const assets = db.select().from(accounts).where(and(eq(accounts.type, 'asset'), eq(accounts.isArchived, false))).all();
  const investments = assets.filter((a) => a.subtype === 'investment');
  if (investments.length === 1) return investments[0]!;
  return (
    assets.find((a) => a.name.toLowerCase().includes('mutual fund')) ??
    createAccount(db, { name: 'Mutual funds', type: 'asset', subtype: 'investment' })
  );
}

// ---- Staging and review -----------------------------------------------------

export function stageInvestmentStatement(db: Db, input: { text: string; file: StoredFile }) {
  const adapter = detectInvestmentAdapter(input.text);
  if (!adapter) throw new DomainError('invalid', 'This is not an investment statement Ledgerly can read yet');
  let parsed: ParsedInvestmentStatement;
  try {
    parsed = adapter.parse(input.text);
  } catch (error) {
    throw new DomainError('invalid', error instanceof Error ? error.message : 'This statement could not be read');
  }
  if (parsed.holdings.length === 0) throw new DomainError('invalid', 'No holdings were found in this statement');

  const id = db.transaction((tx) => {
    const store = tx as unknown as Db;
    let document = store.select().from(documents).where(eq(documents.sha256, input.file.sha256)).get();
    if (document) {
      const live = store
        .select()
        .from(investmentImports)
        .where(and(eq(investmentImports.documentId, document.id), inArray(investmentImports.status, ['staged', 'committed'])))
        .get();
      const bank = store.select().from(importBatches).where(eq(importBatches.documentId, document.id)).get();
      if (live || bank) throw new DomainError('conflict', 'This file was already imported');
    } else {
      document = store.insert(documents).values(input.file).returning().get();
    }
    return store
      .insert(investmentImports)
      .values({ documentId: document.id, source: parsed.source, asOf: parsed.asOf, payload: parsed, warnings: parsed.warnings })
      .returning({ id: investmentImports.id })
      .get().id;
  });
  return getInvestmentImport(db, id);
}

function payloadOf(row: typeof investmentImports.$inferSelect) {
  return row.payload as ParsedInvestmentStatement | null;
}

export function getInvestmentImport(db: Db, id: number) {
  const row = db
    .select({ import: investmentImports, filename: documents.filename })
    .from(investmentImports)
    .leftJoin(documents, eq(documents.id, investmentImports.documentId))
    .where(eq(investmentImports.id, id))
    .get();
  if (!row) throw new DomainError('not_found', `Import ${id} not found`);

  const parsed = payloadOf(row.import);
  const known = db.select().from(positions).all();
  const holdings = (parsed?.holdings ?? []).map((holding) => ({
    name: holding.name,
    folio: holding.folio ?? null,
    assetClass: holding.assetClass ?? 'other',
    units: holding.units,
    nav: holding.nav,
    value: holding.value,
    invested: holding.invested ?? null,
    xirrBps: holding.xirrBps ?? null,
    isNew: !matchPosition(known, holding),
  }));
  const total = holdings.reduce((sum, h) => sum + h.value, 0);
  const label = INVESTMENT_ADAPTERS.find((a) => a.source === row.import.source)?.label ?? 'Price update';

  return {
    id: row.import.id,
    status: row.import.status,
    source: row.import.source,
    label,
    filename: row.filename ?? 'Price update',
    asOf: row.import.asOf,
    warnings: row.import.warnings,
    statedTotal: parsed?.statedTotal ?? null,
    total,
    transactions: parsed?.blocks.reduce((sum, block) => sum + block.rows.length, 0) ?? 0,
    holdings,
    createdAt: row.import.createdAt,
    committedAt: row.import.committedAt,
  };
}

export function listInvestmentImports(db: Db) {
  const imports = db
    .select({ import: investmentImports, filename: documents.filename })
    .from(investmentImports)
    .leftJoin(documents, eq(documents.id, investmentImports.documentId))
    .orderBy(sql`${investmentImports.id} DESC`)
    .all();
  const counts = db
    .select({ importId: valuations.importId, count: sql<number>`count(*)`, total: sql<number>`sum(${valuations.value})` })
    .from(valuations)
    .groupBy(valuations.importId)
    .all();
  return imports.map(({ import: row, filename }) => {
    const parsed = payloadOf(row);
    const stored = counts.find((c) => c.importId === row.id);
    return {
      id: row.id,
      source: row.source,
      filename: filename ?? 'Price update',
      asOf: row.asOf,
      status: row.status,
      funds: stored?.count ?? parsed?.holdings.length ?? 0,
      total: stored?.total ?? parsed?.holdings.reduce((sum, h) => sum + h.value, 0) ?? 0,
      createdAt: row.createdAt,
    };
  });
}

// ---- Committing --------------------------------------------------------------

export function commitInvestmentImport(db: Db, id: number, options: { accountId?: number } = {}) {
  const affected = new Set<number>();

  db.transaction((tx) => {
    const store = tx as unknown as Db;
    const row = store.select().from(investmentImports).where(eq(investmentImports.id, id)).get();
    if (!row) throw new DomainError('not_found', `Import ${id} not found`);
    if (row.status !== 'staged') throw new DomainError('conflict', 'This import is already finished');
    const parsed = payloadOf(row);
    if (!parsed) throw new DomainError('invalid', 'There is nothing to import');

    let account = options.accountId
      ? store.select().from(accounts).where(eq(accounts.id, options.accountId)).get()
      : undefined;
    if (options.accountId && (!account || account.type !== 'asset' || account.isArchived)) {
      throw new DomainError('invalid', 'Choose an asset account to hold these investments');
    }
    account ??= defaultInvestmentAccount(store);

    const heldPositions = new Map<number, ParsedHolding>();
    for (const holding of parsed.holdings) {
      const all = store.select().from(positions).all();
      let position = matchPosition(all, holding);
      if (!position) {
        position = store
          .insert(positions)
          .values({
            name: holding.name,
            isin: holding.isin,
            folio: holding.folio,
            schemeCode: holding.schemeCode,
            assetClass: holding.assetClass ?? 'other',
            accountId: account.id,
          })
          .returning()
          .get();
      } else {
        // Later statements fill in what an earlier one lacked.
        const changes: Partial<typeof positions.$inferInsert> = {};
        if (!position.isin && holding.isin) changes.isin = holding.isin;
        if (!position.schemeCode && holding.schemeCode) changes.schemeCode = holding.schemeCode;
        if (!position.accountId) changes.accountId = account.id;
        const explicit = holding.assetClass && holding.assetClass !== 'other' ? holding.assetClass : undefined;
        if (explicit && (parsed.source === 'scripbox' || position.assetClass === 'other')) changes.assetClass = explicit as AssetClass;
        if (Object.keys(changes).length > 0) {
          position = store.update(positions).set(changes).where(eq(positions.id, position.id)).returning().get();
        }
      }
      if (heldPositions.has(position.id)) continue;
      heldPositions.set(position.id, holding);
      if (position.accountId) affected.add(position.accountId);

      store
        .insert(valuations)
        .values({
          importId: id,
          positionId: position.id,
          asOf: parsed.asOf,
          units: holding.units,
          nav: holding.nav,
          value: holding.value,
          invested: holding.invested,
          xirrBps: holding.xirrBps,
        })
        .run();
    }

    // Each scheme's transactions belong to the holding with the same scheme code,
    // or failing that the one whose units they end on.
    for (const block of parsed.blocks) {
      const held = [...heldPositions.entries()];
      const target =
        held.find(([, h]) => block.schemeCode && h.schemeCode?.toLowerCase() === block.schemeCode.toLowerCase()) ??
        held.find(([, h]) => block.closingUnits !== undefined && h.units === block.closingUnits);
      if (!target) continue;
      const [positionId] = target;

      for (const txn of block.rows) {
        const fingerprint = createHash('sha1')
          .update(`${positionId}|${txn.date}|${txn.kind}|${txn.amount}|${txn.units}`)
          .digest('hex');
        if (store.select().from(investmentTransactions).where(eq(investmentTransactions.fingerprint, fingerprint)).get()) continue;
        store
          .insert(investmentTransactions)
          .values({ importId: id, positionId, date: txn.date, kind: txn.kind, amount: txn.amount, units: txn.units, nav: txn.nav, description: txn.description.slice(0, 300), fingerprint })
          .run();
      }

      // Starting from nothing, the whole history is known, so a return can be worked out.
      const earliest = block.rows.map((r) => r.date).sort()[0];
      if (block.openingUnits === 0 && earliest) {
        const position = store.select().from(positions).where(eq(positions.id, positionId)).get()!;
        if (!position.historyFrom || earliest < position.historyFrom) {
          store.update(positions).set({ historyFrom: earliest }).where(eq(positions.id, positionId)).run();
        }
      }
    }

    store.update(investmentImports).set({ status: 'committed', committedAt: new Date().toISOString() }).where(eq(investmentImports.id, id)).run();
  });

  for (const accountId of affected) rebuildValuations(db, accountId);
  return getInvestmentImport(db, id);
}

// ---- Undoing and discarding -------------------------------------------------

export function undoInvestmentImport(db: Db, id: number) {
  const affected = new Set<number>();
  db.transaction((tx) => {
    const store = tx as unknown as Db;
    const row = store.select().from(investmentImports).where(eq(investmentImports.id, id)).get();
    if (!row) throw new DomainError('not_found', `Import ${id} not found`);
    if (row.status !== 'committed') throw new DomainError('conflict', 'Only a finished import can be undone');

    const touched = store.select({ positionId: valuations.positionId }).from(valuations).where(eq(valuations.importId, id)).all().map((v) => v.positionId);
    store.delete(valuations).where(eq(valuations.importId, id)).run();
    store.delete(investmentTransactions).where(eq(investmentTransactions.importId, id)).run();
    store.update(investmentImports).set({ status: 'undone' }).where(eq(investmentImports.id, id)).run();

    // A fund that only this import knew about goes with it.
    for (const positionId of touched) {
      const position = store.select().from(positions).where(eq(positions.id, positionId)).get();
      if (!position) continue;
      if (position.accountId) affected.add(position.accountId);
      const stillHeld = store.select().from(valuations).where(eq(valuations.positionId, positionId)).get();
      const hasHistory = store.select().from(investmentTransactions).where(eq(investmentTransactions.positionId, positionId)).get();
      if (!stillHeld && !hasHistory) store.delete(positions).where(eq(positions.id, positionId)).run();
    }
  });
  for (const accountId of affected) rebuildValuations(db, accountId);
  return getInvestmentImport(db, id);
}

// Returns the stored file's name when nothing else uses it, so the caller can delete it.
export function discardInvestmentImport(db: Db, id: number) {
  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    const row = store.select().from(investmentImports).where(eq(investmentImports.id, id)).get();
    if (!row) throw new DomainError('not_found', `Import ${id} not found`);
    if (row.status !== 'staged') throw new DomainError('conflict', 'This import is already finished');
    store.delete(investmentImports).where(eq(investmentImports.id, id)).run();
    if (!row.documentId) return undefined;
    const used =
      store.select().from(investmentImports).where(eq(investmentImports.documentId, row.documentId)).get() ??
      store.select().from(importBatches).where(eq(importBatches.documentId, row.documentId)).get();
    if (used) return undefined;
    const document = store.select().from(documents).where(eq(documents.id, row.documentId)).get();
    store.delete(documents).where(eq(documents.id, row.documentId)).run();
    return document?.storedName;
  });
}

// ---- Keeping the ledger at market value ------------------------------------

type ValuationRow = { positionId: number; asOf: string; value: number; invested: number | null; xirrBps: number | null; units: number; nav: number; id: number; source: string };

function committedValuations(db: Db, accountId?: number): ValuationRow[] {
  const rows = db
    .select({
      id: valuations.id,
      positionId: valuations.positionId,
      asOf: valuations.asOf,
      value: valuations.value,
      invested: valuations.invested,
      xirrBps: valuations.xirrBps,
      units: valuations.units,
      nav: valuations.nav,
      source: investmentImports.source,
      accountId: positions.accountId,
    })
    .from(valuations)
    .innerJoin(investmentImports, eq(investmentImports.id, valuations.importId))
    .innerJoin(positions, eq(positions.id, valuations.positionId))
    .where(eq(investmentImports.status, 'committed'))
    .orderBy(asc(valuations.asOf), asc(valuations.id))
    .all();
  return accountId === undefined ? rows : rows.filter((row) => row.accountId === accountId);
}

function latestPerPosition(rows: ValuationRow[], upTo?: string) {
  const latest = new Map<number, ValuationRow>();
  for (const row of rows) if (!upTo || row.asOf <= upTo) latest.set(row.positionId, row);
  return latest;
}

// Lines the ledger up with what the holdings are worth, as a transaction against
// an equity account, so net worth is right and the change is neither income nor
// spending. It is rebuilt from scratch each time, which keeps undo simple.
export function rebuildValuations(db: Db, accountId: number) {
  db.transaction((tx) => {
    const store = tx as unknown as Db;
    const source = `valuation:${accountId}`;
    store.delete(transactions).where(eq(transactions.source, source)).run();

    const rows = committedValuations(store, accountId);
    const dates = [...new Set(rows.map((row) => row.asOf))].sort();
    if (dates.length === 0) return;

    let gains = store.select().from(accounts).where(and(eq(accounts.type, 'equity'), eq(accounts.name, GAINS_ACCOUNT))).get();
    gains ??= store.insert(accounts).values({ name: GAINS_ACCOUNT, type: 'equity' }).returning().get();

    for (const date of dates) {
      const worth = [...latestPerPosition(rows, date).values()].reduce((sum, row) => sum + row.value, 0);
      const balance =
        store.all<{ total: number }>(sql`
          SELECT COALESCE(SUM(p.amount), 0) AS total FROM postings p JOIN transactions t ON t.id = p.transaction_id
          WHERE p.account_id = ${accountId} AND t.date <= ${date}`)[0]?.total ?? 0;
      const adjustment = worth - balance;
      if (adjustment === 0) continue;
      createTransaction(store, {
        date,
        description: `Revalued to ${formatAmount(worth)} (market value on ${date})`,
        source,
        postings: [
          { accountId, amount: adjustment },
          { accountId: gains.id, amount: -adjustment },
        ],
      });
    }
  });
}

// ---- What you hold ----------------------------------------------------------

export function positionXirr(db: Db, position: Position, value: number, asOf: string) {
  if (!position.historyFrom) return undefined;
  const flows = db
    .select()
    .from(investmentTransactions)
    .where(eq(investmentTransactions.positionId, position.id))
    .all()
    .filter((t) => t.date >= position.historyFrom!)
    .map((t) => ({
      date: t.date,
      // Money going in is negative, and money coming out positive.
      amount: t.kind === 'redemption' || t.kind === 'switch_out' || t.kind === 'dividend' ? t.amount : -t.amount,
    }));
  const rate = xirr([...flows, { date: asOf, amount: value }]);
  return rate === undefined ? undefined : Math.round(rate * 10_000);
}

export function getHoldings(db: Db) {
  const rows = committedValuations(db);
  const latest = latestPerPosition(rows);
  const all = db.select().from(positions).all();
  const accountNames = new Map(db.select().from(accounts).all().map((a) => [a.id, a.name]));

  const holdings = all.flatMap((position) => {
    const current = latest.get(position.id);
    if (!current) return [];
    const mine = rows.filter((row) => row.positionId === position.id);
    // A price update has no cost or return of its own, so carry the last known ones.
    const invested = [...mine].reverse().find((row) => row.invested !== null)?.invested ?? null;
    const reported = [...mine].reverse().find((row) => row.xirrBps !== null)?.xirrBps ?? null;
    const calculated = positionXirr(db, position, current.value, current.asOf);
    const gain = invested === null ? null : current.value - invested;
    return [
      {
        id: position.id,
        name: position.name,
        isin: position.isin,
        folio: position.folio,
        assetClass: position.assetClass,
        account: position.accountId ? (accountNames.get(position.accountId) ?? null) : null,
        units: current.units,
        nav: current.nav,
        value: current.value,
        asOf: current.asOf,
        source: current.source,
        invested,
        gain,
        gainRatio: invested ? (gain ?? 0) / invested : null,
        xirrBps: calculated ?? reported,
        xirrSource: calculated !== undefined ? ('calculated' as const) : reported !== null ? ('reported' as const) : null,
      },
    ];
  });
  holdings.sort((a, b) => b.value - a.value);

  const value = holdings.reduce((sum, h) => sum + h.value, 0);
  const costed = holdings.filter((h) => h.invested !== null);
  const invested = costed.reduce((sum, h) => sum + h.invested!, 0);
  const costedValue = costed.reduce((sum, h) => sum + h.value, 0);
  const classes: AssetClass[] = ['equity', 'debt', 'hybrid', 'gold', 'other'];

  return {
    holdings,
    summary: {
      value,
      invested: costed.length === 0 ? null : invested,
      gain: costed.length === 0 ? null : costedValue - invested,
      gainRatio: invested > 0 ? (costedValue - invested) / invested : null,
      // True only when every holding's cost is known, so the totals can be compared.
      complete: costed.length === holdings.length,
      asOf: holdings.map((h) => h.asOf).sort().at(-1) ?? null,
    },
    allocation: classes
      .map((assetClass) => {
        const part = holdings.filter((h) => h.assetClass === assetClass);
        const partValue = part.reduce((sum, h) => sum + h.value, 0);
        return { assetClass, value: partValue, share: value > 0 ? partValue / value : 0, funds: part.length };
      })
      .filter((entry) => entry.funds > 0),
  };
}

// ---- Prices -----------------------------------------------------------------

// AMFI's daily file: scheme code; ISIN (growth); ISIN (reinvestment); name; plan; option; NAV; date.
export function parseAmfiNav(text: string) {
  const prices = new Map<string, { nav: number; date: string }>();
  for (const line of text.split('\n')) {
    const cells = line.trim().split(';');
    if (cells.length < 6) continue;
    const date = parseAmfiDate(cells.at(-1)!);
    const nav = Number(cells.at(-2));
    if (!date || !Number.isFinite(nav) || nav <= 0) continue;
    const micro = Math.round(nav * 1_000_000);
    for (const isin of [cells[1], cells[2]]) {
      if (isin && /^IN[A-Z0-9]{10}$/.test(isin.trim())) prices.set(isin.trim(), { nav: micro, date });
    }
  }
  return prices;
}

function parseAmfiDate(text: string) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(text.trim());
  if (!match) return undefined;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[2]!.toLowerCase()) + 1;
  return month === 0 ? undefined : `${match[3]}-${String(month).padStart(2, '0')}-${match[1]}`;
}

// Revalues each holding at the newest price. The units are the ones from your
// last statement, so units bought since then are not counted until the next one.
export function applyPrices(db: Db, prices: Map<string, { nav: number; date: string }>) {
  const latest = latestPerPosition(committedValuations(db));
  const fresh: { positionId: number; date: string; nav: number; row: ValuationRow }[] = [];
  let skipped = 0;
  for (const position of db.select().from(positions).all()) {
    const current = latest.get(position.id);
    const price = position.isin ? prices.get(position.isin) : undefined;
    if (!current || !price) continue;
    if (price.date <= current.asOf) {
      skipped += 1;
      continue;
    }
    fresh.push({ positionId: position.id, date: price.date, nav: price.nav, row: current });
  }
  if (fresh.length === 0) return { updated: 0, skipped, asOf: null as string | null };

  const asOf = fresh.map((f) => f.date).sort().at(-1)!;
  const affected = new Set<number>();
  db.transaction((tx) => {
    const store = tx as unknown as Db;
    const { id } = store.insert(investmentImports).values({ source: 'amfi', asOf, status: 'committed', committedAt: new Date().toISOString() }).returning({ id: investmentImports.id }).get();
    for (const item of fresh) {
      store
        .insert(valuations)
        .values({ importId: id, positionId: item.positionId, asOf: item.date, units: item.row.units, nav: item.nav, value: valueOf(item.row.units, item.nav), invested: item.row.invested })
        .run();
      const position = store.select().from(positions).where(eq(positions.id, item.positionId)).get();
      if (position?.accountId) affected.add(position.accountId);
    }
  });
  for (const accountId of affected) rebuildValuations(db, accountId);
  return { updated: fresh.length, skipped, asOf };
}
