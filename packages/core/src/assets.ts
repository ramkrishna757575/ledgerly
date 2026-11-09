import { accounts, ASSET_KINDS, manualAssets, postings, transactions, type AssetKind, type Db } from '@ledgerly/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getOrCreateOpeningBalances } from './accounts.ts';
import { dateSchema, createTransaction } from './transactions.ts';
import { DomainError } from './errors.ts';

const GAINS = 'Unrealised Gains';
const today = () => new Date().toISOString().slice(0, 10);

export const assetSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ASSET_KINDS),
  value: z.number().int().safe().min(0),
  asOf: dateSchema.default(today),
  invested: z.number().int().safe().min(0).optional(),
  rateBps: z.number().int().min(0).max(5000).optional(),
  startDate: dateSchema.optional(),
  maturityDate: dateSchema.optional(),
  note: z.string().trim().max(500).optional(),
});

function gainsAccount(db: Db) {
  return (
    db.select().from(accounts).where(and(eq(accounts.type, 'equity'), eq(accounts.name, GAINS))).get() ??
    db.insert(accounts).values({ name: GAINS, type: 'equity' }).returning().get()
  );
}

function balanceOn(db: Db, accountId: number, date: string, exceptSource?: string) {
  return (
    db.all<{ total: number }>(sql`
      SELECT COALESCE(SUM(p.amount), 0) AS total FROM postings p JOIN transactions t ON t.id = p.transaction_id
      WHERE p.account_id = ${accountId} AND t.date <= ${date} ${exceptSource ? sql`AND t.source IS NOT ${exceptSource}` : sql``}`)[0]?.total ?? 0
  );
}

// Sets the asset's worth on a date, against Unrealised Gains so the change is
// never counted as income.
function revalue(db: Db, accountId: number, value: number, date: string, source: string) {
  db.delete(transactions).where(eq(transactions.source, source)).run();
  const adjustment = value - balanceOn(db, accountId, date);
  if (adjustment === 0) return;
  const gains = gainsAccount(db);
  createTransaction(db, {
    date,
    description: `Valued at ${(value / 100).toLocaleString('en-IN')} on ${date}`,
    source,
    postings: [
      { accountId, amount: adjustment },
      { accountId: gains.id, amount: -adjustment },
    ],
  });
}

export function createAsset(db: Db, input: z.input<typeof assetSchema>) {
  const data = assetSchema.parse(input);
  if (data.kind === 'fd' && data.rateBps !== undefined && (data.invested === undefined || !data.startDate)) {
    throw new DomainError('invalid', 'A deposit that grows by itself needs the amount put in and the start date');
  }
  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    const exists = store.select().from(accounts).where(and(eq(accounts.name, data.name), eq(accounts.type, 'asset'))).get();
    if (exists) throw new DomainError('conflict', `An asset account named "${data.name}" exists`);
    const account = store.insert(accounts).values({ name: data.name, type: 'asset', subtype: 'investment' }).returning().get();

    const put = data.invested ?? data.value;
    if (put > 0) {
      const equity = getOrCreateOpeningBalances(store);
      createTransaction(store, {
        date: data.startDate ?? data.asOf,
        description: `Opening balance for ${data.name}`,
        source: 'opening_balance',
        postings: [
          { accountId: account.id, amount: put },
          { accountId: equity.id, amount: -put },
        ],
      });
    }
    store
      .insert(manualAssets)
      .values({ accountId: account.id, kind: data.kind, invested: data.invested ?? null, rateBps: data.rateBps ?? null, startDate: data.startDate ?? null, maturityDate: data.maturityDate ?? null, note: data.note ?? null })
      .run();
    if (data.rateBps === undefined) revalue(store, account.id, data.value, data.asOf, `asset:${account.id}`);
    else accrueDeposits(store, data.asOf, account.id);
    return account.id;
  });
}

export const valueSchema = z.object({ value: z.number().int().safe().min(0), asOf: dateSchema.default(today) });

export function updateAssetValue(db: Db, accountId: number, input: z.input<typeof valueSchema>) {
  const { value, asOf } = valueSchema.parse(input);
  const asset = db.select().from(manualAssets).where(eq(manualAssets.accountId, accountId)).get();
  if (!asset) throw new DomainError('not_found', 'No such asset');
  if (asset.rateBps !== null) throw new DomainError('invalid', 'This deposit grows by itself from its rate. Change the details instead of the value.');
  revalue(db, accountId, value, asOf, `asset:${accountId}`);
}

// Interest on a deposit, compounded quarterly as Indian banks do, from the
// start date until maturity, then held at the maturity value. One adjustment
// per deposit, rewritten each time, so running it again changes nothing.
export function depositValue(principal: number, rateBps: number, start: string, end: string) {
  const years = Math.max(0, (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (365 * 86_400_000));
  return Math.round(principal * (1 + rateBps / 10_000 / 4) ** (4 * years));
}

export function accrueDeposits(db: Db, on = today(), accountId?: number) {
  for (const row of db.select().from(manualAssets).all()) {
    if (accountId !== undefined && row.accountId !== accountId) continue;
    if (row.rateBps === null || row.invested === null || !row.startDate) continue;
    const until = row.maturityDate && row.maturityDate < on ? row.maturityDate : on;
    revalue(db, row.accountId, depositValue(row.invested, row.rateBps, row.startDate, until), on, `accrual:${row.accountId}`);
  }
}

export function listAssets(db: Db, input: { today?: string } = {}) {
  const now = input.today ?? today();
  const rows = db
    .select({ asset: manualAssets, name: accounts.name, archived: accounts.isArchived })
    .from(manualAssets)
    .innerJoin(accounts, eq(accounts.id, manualAssets.accountId))
    .all();
  const items = rows.map(({ asset, name }) => {
    const value = balanceOn(db, asset.accountId, '9999-12-31');
    const days = asset.maturityDate ? Math.round((Date.parse(asset.maturityDate) - Date.parse(now)) / 86_400_000) : null;
    return {
      accountId: asset.accountId,
      name,
      kind: asset.kind as AssetKind,
      value,
      invested: asset.invested,
      gain: asset.invested === null ? null : value - asset.invested,
      rateBps: asset.rateBps,
      startDate: asset.startDate,
      maturityDate: asset.maturityDate,
      daysToMaturity: days,
      grows: asset.rateBps !== null,
      note: asset.note,
    };
  });
  items.sort((a, b) => b.value - a.value);
  return { items, total: items.reduce((s, i) => s + i.value, 0) };
}

export function deleteAsset(db: Db, accountId: number) {
  const asset = db.select().from(manualAssets).where(eq(manualAssets.accountId, accountId)).get();
  if (!asset) throw new DomainError('not_found', 'No such asset');
  const others = db
    .select({ id: transactions.id })
    .from(postings)
    .innerJoin(transactions, eq(transactions.id, postings.transactionId))
    .where(and(eq(postings.accountId, accountId), sql`${transactions.source} IS NOT NULL`, sql`NOT (${transactions.source} = 'opening_balance' OR ${transactions.source} LIKE 'asset:%' OR ${transactions.source} LIKE 'accrual:%')`))
    .all();
  const typed = db.select({ id: transactions.id }).from(postings).innerJoin(transactions, eq(transactions.id, postings.transactionId)).where(and(eq(postings.accountId, accountId), sql`${transactions.source} IS NULL`)).all();
  if (others.length + typed.length > 0) throw new DomainError('conflict', 'This account has transactions of its own, so it cannot be deleted here.');
  db.transaction((tx) => {
    const store = tx as unknown as Db;
    const own = store.select({ id: postings.transactionId }).from(postings).where(eq(postings.accountId, accountId)).all();
    for (const { id } of own) store.delete(transactions).where(eq(transactions.id, id)).run();
    store.delete(accounts).where(eq(accounts.id, accountId)).run();
  });
}

// The mix a kind of asset belongs to when looking at how your money is spread.
// Property is left out, as it is not something you rebalance.
export const ASSET_CLASS_OF: Record<AssetKind, 'equity' | 'debt' | 'hybrid' | 'gold' | 'other' | null> = {
  fd: 'debt',
  rd: 'debt',
  ppf: 'debt',
  epf: 'debt',
  nps: 'hybrid',
  stocks: 'equity',
  gold: 'gold',
  property: null,
  other: 'other',
};

// What a deposit is worth on its maturity date.
export function maturityValue(db: Db, accountId: number) {
  const row = db.select().from(manualAssets).where(eq(manualAssets.accountId, accountId)).get();
  if (!row?.maturityDate) return null;
  if (row.rateBps !== null && row.invested !== null && row.startDate) {
    return depositValue(row.invested, row.rateBps, row.startDate, row.maturityDate);
  }
  return balanceOn(db, accountId, '9999-12-31');
}
