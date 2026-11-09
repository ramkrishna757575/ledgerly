import {
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  accounts,
  postings,
  transactions,
  type AccountType,
  type Db,
} from '@ledgerly/db';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from './errors.ts';
import { createTransaction, dateSchema } from './transactions.ts';

const OPENING_BALANCES = 'Opening Balances';
// Imports, rules and the findings look for this category by name, so it stays.
export const UNCATEGORIZED = 'Uncategorized';

export function assertNotProtected(account: { type: string; name: string }, doing: string) {
  if (account.type === 'expense' && account.name === UNCATEGORIZED) {
    throw new DomainError('conflict', `"${UNCATEGORIZED}" is where unsorted spending goes, so it cannot be ${doing}`);
  }
}

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(ACCOUNT_TYPES),
  subtype: z.enum(ACCOUNT_SUBTYPES).optional(),
  currency: z.string().length(3).default('INR'),
  institution: z.string().trim().max(100).optional(),
  numberLast4: z.string().regex(/^\d{4}$/).optional(),
  // In the account's natural sign: money held for assets, money owed for liabilities.
  openingBalance: z.number().int().safe().optional(),
  openingDate: dateSchema.optional(),
});

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  institution: z.string().trim().max(100).nullable().optional(),
  numberLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
});

// Assets and expenses grow with debits, everything else grows with credits.
function naturalSign(type: AccountType) {
  return type === 'asset' || type === 'expense' ? 1 : -1;
}

function isUniqueViolation(error: unknown) {
  const code = (error as { cause?: { code?: string }; code?: string }).cause?.code;
  return (code ?? (error as { code?: string }).code) === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function listAccounts(db: Db) {
  return db.select().from(accounts).orderBy(asc(accounts.type), asc(accounts.name)).all();
}

export function getAccount(db: Db, id: number) {
  const account = db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account) throw new DomainError('not_found', `Account ${id} not found`);
  return account;
}

export function createAccount(db: Db, input: z.input<typeof createAccountSchema>) {
  const { openingBalance, openingDate, ...fields } = createAccountSchema.parse(input);

  if (openingBalance && fields.type !== 'asset' && fields.type !== 'liability') {
    throw new DomainError('invalid', 'Only asset and liability accounts have an opening balance');
  }

  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    let account;
    try {
      account = tx.insert(accounts).values(fields).returning().get();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError('conflict', `An ${fields.type} account named "${fields.name}" exists`);
      }
      throw error;
    }

    if (openingBalance) {
      const equity = getOrCreateOpeningBalances(store);
      const amount = openingBalance * naturalSign(fields.type);
      createTransaction(store, {
        date: openingDate ?? new Date().toISOString().slice(0, 10),
        description: `Opening balance for ${fields.name}`,
        source: 'opening_balance',
        postings: [
          { accountId: account.id, amount },
          { accountId: equity.id, amount: -amount },
        ],
      });
    }
    return account;
  });
}

export function getOrCreateOpeningBalances(db: Db) {
  const existing = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.type, 'equity'), eq(accounts.name, OPENING_BALANCES)))
    .get();
  return (
    existing ??
    db.insert(accounts).values({ name: OPENING_BALANCES, type: 'equity' }).returning().get()
  );
}

export function updateAccount(db: Db, id: number, input: z.input<typeof updateAccountSchema>) {
  const fields = updateAccountSchema.parse(input);
  const existing = getAccount(db, id);
  if (fields.name !== undefined && fields.name !== existing.name) assertNotProtected(existing, 'renamed');
  if (Object.keys(fields).length === 0) return getAccount(db, id);
  try {
    return db.update(accounts).set(fields).where(eq(accounts.id, id)).returning().get();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainError('conflict', `An account named "${fields.name}" exists`);
    }
    throw error;
  }
}

export function archiveAccount(db: Db, id: number) {
  const account = getAccount(db, id);
  assertNotProtected(account, 'archived');
  const isBalanceSheet = account.type === 'asset' || account.type === 'liability';
  if (isBalanceSheet && accountBalance(db, id) !== 0) {
    throw new DomainError('conflict', 'Only an account with a zero balance can be archived. Settle or move the balance first.');
  }
  return db
    .update(accounts)
    .set({ isArchived: true })
    .where(eq(accounts.id, id))
    .returning()
    .get();
}

export function unarchiveAccount(db: Db, id: number) {
  getAccount(db, id);
  return db.update(accounts).set({ isArchived: false }).where(eq(accounts.id, id)).returning().get();
}

// An account that has transactions cannot go without leaving them one-sided, so
// it can only be archived. Delete its transactions first to remove it for good.
export function deleteAccount(db: Db, id: number) {
  const account = getAccount(db, id);
  assertNotProtected(account, 'deleted');
  if (account.type === 'equity') {
    throw new DomainError('conflict', 'This account is used by the app and cannot be deleted');
  }

  const used = db
    .select({ total: sql<number>`count(*)` })
    .from(postings)
    .where(eq(postings.accountId, id))
    .get();
  if (used?.total) {
    throw new DomainError(
      'conflict',
      `"${account.name}" has ${used.total} ${used.total === 1 ? 'entry' : 'entries'} in your books. Archive it once its balance is zero, or delete its transactions first.`,
    );
  }
  db.delete(accounts).where(eq(accounts.id, id)).run();
}

function accountBalance(db: Db, id: number) {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${postings.amount}), 0)` })
    .from(postings)
    .where(eq(postings.accountId, id))
    .get();
  return row?.total ?? 0;
}

export function getBalances(db: Db, options: { asOf?: string } = {}) {
  const asOf = options.asOf ? dateSchema.parse(options.asOf) : undefined;
  const rows = db
    .select({
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      currency: accounts.currency,
      institution: accounts.institution,
      numberLast4: accounts.numberLast4,
      isArchived: accounts.isArchived,
      total: sql<number>`coalesce(sum(${postings.amount}), 0)`,
    })
    .from(accounts)
    .leftJoin(
      db
        .select({ accountId: postings.accountId, amount: postings.amount })
        .from(postings)
        .innerJoin(transactions, eq(transactions.id, postings.transactionId))
        .where(asOf ? lte(transactions.date, asOf) : undefined)
        .as('postings'),
      eq(postings.accountId, accounts.id),
    )
    .groupBy(accounts.id)
    .orderBy(asc(accounts.type), asc(accounts.name))
    .all();

  return rows.map(({ total, ...row }) => ({
    ...row,
    balance: total === 0 ? 0 : total * naturalSign(row.type),
  }));
}

export function getNetWorth(db: Db, options: { asOf?: string } = {}) {
  const balances = getBalances(db, options);
  const sumOf = (type: AccountType) =>
    balances.filter((b) => b.type === type).reduce((sum, b) => sum + b.balance, 0);

  const assets = sumOf('asset');
  const liabilities = sumOf('liability');
  return { assets, liabilities, netWorth: assets - liabilities };
}

export function getCashFlow(db: Db, range: { from: string; to: string }) {
  const from = dateSchema.parse(range.from);
  const to = dateSchema.parse(range.to);
  const rows = db
    .select({ type: accounts.type, total: sql<number>`sum(${postings.amount})` })
    .from(postings)
    .innerJoin(accounts, eq(accounts.id, postings.accountId))
    .innerJoin(transactions, eq(transactions.id, postings.transactionId))
    .where(sql`${transactions.date} BETWEEN ${from} AND ${to}
      AND ${accounts.type} IN ('income', 'expense')`)
    .groupBy(accounts.type)
    .all();

  const totalOf = (type: AccountType) => rows.find((r) => r.type === type)?.total ?? 0;
  const income = totalOf('income') === 0 ? 0 : -totalOf('income');
  const expenses = totalOf('expense');
  return { income, expenses, net: income - expenses };
}
