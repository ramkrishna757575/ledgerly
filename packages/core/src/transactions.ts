import {
  accounts,
  postings,
  tags,
  transactions,
  transactionTags,
  type Db,
} from '@ledgerly/db';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { attachmentCounts } from './attachments.ts';
import { DomainError } from './errors.ts';

export const dateSchema = z.iso.date();

const postingSchema = z.object({
  accountId: z.number().int().positive(),
  amount: z.number().int().safe().refine((n) => n !== 0, 'Amount cannot be zero'),
  memo: z.string().trim().max(500).optional(),
});

const detailsSchema = z.object({
  date: dateSchema,
  description: z.string().trim().min(1).max(500),
  payee: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).optional(),
});

export const transactionSchema = detailsSchema.extend({
  source: z.string().default('manual'),
  postings: z.array(postingSchema).min(2, 'A transaction needs at least two postings'),
});

export const simpleTransactionSchema = detailsSchema.extend({
  kind: z.enum(['expense', 'income', 'transfer']),
  accountId: z.number().int().positive(),
  // The category for expenses and income, the destination for transfers.
  counterAccountId: z.number().int().positive(),
  amount: z.number().int().safe().positive(),
});

export const listTransactionsSchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function assertValidPostings(db: Db, entries: z.output<typeof transactionSchema>['postings']) {
  const total = entries.reduce((sum, p) => sum + p.amount, 0);
  if (total !== 0) {
    throw new DomainError('invalid', `Postings must sum to zero, but they sum to ${total}`);
  }

  const ids = [...new Set(entries.map((p) => p.accountId))];
  const found = db.select().from(accounts).where(inArray(accounts.id, ids)).all();
  const missing = ids.filter((id) => !found.some((a) => a.id === id));
  if (missing.length > 0) {
    throw new DomainError('invalid', `Unknown account: ${missing.join(', ')}`);
  }

  const archived = found.find((a) => a.isArchived);
  if (archived) throw new DomainError('invalid', `Account "${archived.name}" is archived`);

  if (new Set(found.map((a) => a.currency)).size > 1) {
    throw new DomainError('invalid', 'All postings in a transaction must share a currency');
  }
}

function saveTags(db: Db, transactionId: number, names: string[]) {
  db.delete(transactionTags).where(eq(transactionTags.transactionId, transactionId)).run();
  for (const name of new Set(names)) {
    db.insert(tags).values({ name }).onConflictDoNothing().run();
    const tag = db.select().from(tags).where(eq(tags.name, name)).get();
    if (tag) db.insert(transactionTags).values({ transactionId, tagId: tag.id }).run();
  }
}

export function createTransaction(db: Db, input: z.input<typeof transactionSchema>) {
  const { postings: entries, tags: tagNames, ...fields } = transactionSchema.parse(input);
  assertValidPostings(db, entries);

  const id = db.transaction((tx) => {
    const created = tx.insert(transactions).values(fields).returning().get();
    tx.insert(postings)
      .values(entries.map((p) => ({ ...p, transactionId: created.id })))
      .run();
    saveTags(tx as unknown as Db, created.id, tagNames ?? []);
    return created.id;
  });
  return getTransaction(db, id);
}

export function createSimpleTransaction(db: Db, input: z.input<typeof simpleTransactionSchema>) {
  const { kind, accountId, counterAccountId, amount, ...details } =
    simpleTransactionSchema.parse(input);

  if (accountId === counterAccountId) {
    throw new DomainError('invalid', 'Choose two different accounts');
  }

  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  const counter = db.select().from(accounts).where(eq(accounts.id, counterAccountId)).get();
  if (!account || !counter) throw new DomainError('invalid', 'Unknown account');

  const isMoneyAccount = (type: string) => type === 'asset' || type === 'liability';
  const counterIsValid = kind === 'transfer' ? isMoneyAccount(counter.type) : counter.type === kind;
  if (!isMoneyAccount(account.type) || !counterIsValid) {
    throw new DomainError('invalid', `These accounts cannot be used for a ${kind}`);
  }

  const accountAmount = kind === 'income' ? amount : -amount;
  return createTransaction(db, {
    ...details,
    postings: [
      { accountId, amount: accountAmount },
      { accountId: counterAccountId, amount: -accountAmount },
    ],
  });
}

export function updateTransaction(db: Db, id: number, input: z.input<typeof transactionSchema>) {
  const { postings: entries, tags: tagNames, ...fields } = transactionSchema.parse(input);
  getTransaction(db, id);
  assertValidPostings(db, entries);

  db.transaction((tx) => {
    tx.update(transactions)
      .set({ ...fields, updatedAt: new Date().toISOString() })
      .where(eq(transactions.id, id))
      .run();
    tx.delete(postings).where(eq(postings.transactionId, id)).run();
    tx.insert(postings)
      .values(entries.map((p) => ({ ...p, transactionId: id })))
      .run();
    saveTags(tx as unknown as Db, id, tagNames ?? []);
  });
  return getTransaction(db, id);
}

const FALLBACK_CATEGORIES = ['Uncategorized', 'Other Income'];

function categoryTarget(db: Db, categoryId: number) {
  const target = db.select().from(accounts).where(eq(accounts.id, categoryId)).get();
  if (!target || target.isArchived || target.type === 'equity') {
    throw new DomainError('invalid', 'Choose a category or an account');
  }
  return target;
}

// A transaction with one money side and one category can change category. A
// transfer has no category, so it is left to be deleted and entered again.
function editableCategoryPosting(db: Db, id: number) {
  const transaction = getTransaction(db, id);
  const categorised = transaction.postings.filter((p) => p.accountType === 'income' || p.accountType === 'expense');
  if (transaction.postings.length !== 2 || categorised.length !== 1) {
    throw new DomainError('invalid', "This transaction has no single category to change. Delete it and enter it again instead.");
  }
  return { transaction, posting: categorised[0]!, moneySide: transaction.postings.find((p) => p !== categorised[0])! };
}

// Other transactions from the same payee that nobody has sorted yet.
function similarPostings(db: Db, transaction: { id: number; payee: string | null }, positive: boolean) {
  if (!transaction.payee) return [];
  return db.all<{ postingId: number }>(sql`
    SELECT p.id AS postingId
    FROM transactions t
    JOIN postings p ON p.transaction_id = t.id
    JOIN accounts a ON a.id = p.account_id
    WHERE lower(t.payee) = lower(${transaction.payee}) AND t.id <> ${transaction.id}
      AND a.type IN ('income', 'expense') AND a.name IN ('Uncategorized', 'Other Income')
      AND ((p.amount > 0) = ${positive ? 1 : 0})
      AND (SELECT COUNT(*) FROM postings q WHERE q.transaction_id = t.id) = 2`);
}

// What changing the category would do, without doing it. Used to check a
// suggestion when it is made and again when it is approved.
export function previewCategoryChange(db: Db, id: number, categoryId: number) {
  const target = categoryTarget(db, categoryId);
  const { transaction, posting, moneySide } = editableCategoryPosting(db, id);
  if (target.id === moneySide.accountId) throw new DomainError('invalid', 'Choose a different category');
  return {
    transaction,
    moneySide,
    from: { id: posting.accountId, name: posting.accountName },
    to: { id: target.id, name: target.name },
  };
}

export function setTransactionCategory(db: Db, id: number, categoryId: number) {
  const target = categoryTarget(db, categoryId);
  const { transaction, posting, moneySide } = editableCategoryPosting(db, id);
  if (target.id === moneySide.accountId) throw new DomainError('invalid', 'Choose a different category');

  db.transaction((tx) => {
    tx.update(postings).set({ accountId: target.id }).where(eq(postings.id, posting.id)).run();
    tx.update(transactions).set({ updatedAt: new Date().toISOString() }).where(eq(transactions.id, id)).run();
  });
  return {
    transaction: getTransaction(db, id),
    similar: similarPostings(db, transaction, posting.amount > 0).length,
  };
}

export function applyCategoryToSimilar(db: Db, id: number, categoryId: number) {
  const target = categoryTarget(db, categoryId);
  const { transaction, posting } = editableCategoryPosting(db, id);
  const matches = similarPostings(db, transaction, posting.amount > 0);
  db.transaction((tx) => {
    for (const { postingId } of matches) {
      tx.update(postings).set({ accountId: target.id }).where(eq(postings.id, postingId)).run();
    }
  });
  return { updated: matches.length };
}

export function deleteTransaction(db: Db, id: number) {
  const { changes } = db.delete(transactions).where(eq(transactions.id, id)).run();
  if (changes === 0) throw new DomainError('not_found', `Transaction ${id} not found`);
}

function withDetails(db: Db, rows: (typeof transactions.$inferSelect)[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const lines = db
    .select({
      id: postings.id,
      transactionId: postings.transactionId,
      accountId: postings.accountId,
      accountName: accounts.name,
      accountType: accounts.type,
      amount: postings.amount,
      memo: postings.memo,
    })
    .from(postings)
    .innerJoin(accounts, eq(accounts.id, postings.accountId))
    .where(inArray(postings.transactionId, ids))
    .all();

  const labels = db
    .select({ transactionId: transactionTags.transactionId, name: tags.name })
    .from(transactionTags)
    .innerJoin(tags, eq(tags.id, transactionTags.tagId))
    .where(inArray(transactionTags.transactionId, ids))
    .all();

  const attached = attachmentCounts(db, ids);
  return rows.map((row) => ({
    ...row,
    postings: lines.filter((l) => l.transactionId === row.id),
    tags: labels.filter((l) => l.transactionId === row.id).map((l) => l.name),
    attachments: attached.get(row.id) ?? 0,
  }));
}

export function getTransaction(db: Db, id: number) {
  const row = db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!row) throw new DomainError('not_found', `Transaction ${id} not found`);
  return withDetails(db, [row])[0]!;
}

export function listTransactions(db: Db, input: z.input<typeof listTransactionsSchema> = {}) {
  const { accountId, from, to, search, limit, offset } = listTransactionsSchema.parse(input);

  const where = and(
    from ? gte(transactions.date, from) : undefined,
    to ? lte(transactions.date, to) : undefined,
    search
      ? sql`(instr(lower(${transactions.description}), lower(${search})) > 0
          OR instr(lower(coalesce(${transactions.payee}, '')), lower(${search})) > 0)`
      : undefined,
    // A list of ids first, so the work depends on the account's own rows and not on every transaction.
    accountId
      ? inArray(transactions.id, db.select({ id: postings.transactionId }).from(postings).where(eq(postings.accountId, accountId)))
      : undefined,
  );

  const rows = db
    .select()
    .from(transactions)
    .where(where)
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(limit)
    .offset(offset)
    .all();

  const count = db
    .select({ total: sql<number>`count(*)` })
    .from(transactions)
    .where(where)
    .get();

  return { items: withDetails(db, rows), total: count?.total ?? 0 };
}

export const splitSchema = z.array(z.object({ categoryId: z.number().int().positive(), amount: z.number().int().safe().positive() })).min(1).max(30);

// Spreads one purchase or receipt across several categories, such as a shop
// that was part groceries and part household. The money side is not touched, so
// balances stay exactly as they were; only how the amount is sorted changes.
export function splitTransaction(db: Db, id: number, input: z.input<typeof splitSchema>) {
  const parts = splitSchema.parse(input);
  const transaction = getTransaction(db, id);
  const money = transaction.postings.filter((p) => p.accountType === 'asset' || p.accountType === 'liability');
  const sorted = transaction.postings.filter((p) => p.accountType === 'income' || p.accountType === 'expense');
  if (money.length !== 1 || sorted.length === 0 || money.length + sorted.length !== transaction.postings.length) {
    throw new DomainError('invalid', 'Only a purchase or a receipt, with one account and its categories, can be split');
  }
  const m = money[0]!.amount;
  const total = parts.reduce((sum, p) => sum + p.amount, 0);
  if (total !== Math.abs(m)) {
    throw new DomainError('invalid', `The parts add up to ${total / 100}, but the transaction is ${Math.abs(m) / 100}`);
  }
  const wanted = m < 0 ? 'expense' : 'income';
  const found = db.select().from(accounts).where(inArray(accounts.id, [...new Set(parts.map((p) => p.categoryId))])).all();
  for (const part of parts) {
    const category = found.find((a) => a.id === part.categoryId);
    if (!category || category.type !== wanted || category.isArchived) {
      throw new DomainError('invalid', `Choose ${wanted === 'expense' ? 'spending' : 'income'} categories for this transaction`);
    }
  }

  db.transaction((tx) => {
    tx.delete(postings).where(inArray(postings.id, sorted.map((p) => p.id))).run();
    // Same category twice becomes one line.
    const byCategory = new Map<number, number>();
    for (const part of parts) byCategory.set(part.categoryId, (byCategory.get(part.categoryId) ?? 0) + part.amount);
    for (const [categoryId, amount] of byCategory) {
      tx.insert(postings).values({ transactionId: id, accountId: categoryId, amount: m < 0 ? amount : -amount }).run();
    }
  });
  return getTransaction(db, id);
}
