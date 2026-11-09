import { createHash } from 'node:crypto';
import {
  accounts,
  documents,
  importBatches,
  postings,
  stagedTransactions,
  transactions,
  type Db,
} from '@ledgerly/db';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from '../errors.ts';
import { adoptAlertTransaction } from '../bank-alerts.ts';
import { createTransaction, setTransactionCategory } from '../transactions.ts';
import { builtinCategory } from './categorize.ts';
import { parseNarration } from './narration.ts';
import { payeeAliaser } from '../payees.ts';
import { learnedAdapters, listLearned } from './learned.ts';
import { ADAPTERS, detectAdapter } from './registry.ts';
import { activeRules, createRule, firstMatchingRule } from './rules.ts';
import type { ParsedRow } from './types.ts';

export type StoredFile = {
  sha256: string;
  filename: string;
  mimeType: string;
  size: number;
  storedName: string;
};

const bankOf = (db: Db, adapterId: string) => ADAPTERS.find((a) => a.id === adapterId)?.bank ?? listLearned(db).find((l) => l.id === adapterId)?.recipe.bank ?? null;

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

// A transaction keeps one fingerprint across statement layouts, so the same
// payment seen in two overlapping statements is recognised. Identical payments
// on one day get a counter, so a second coffee is not mistaken for the first.
function fingerprints(rows: ParsedRow[], references: (string | undefined)[]) {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const identity = references[index] ?? normalise(row.description).slice(0, 40);
    const base = `${row.date}|${row.amount}|${identity}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return createHash('sha1').update(`${base}#${count}`).digest('hex');
  });
}

type Direction = 'in' | 'out';

// What you chose for each payee before, from the ledger itself, so a category
// picked here, in an earlier import, or on the Transactions page is remembered.
function learnHistory(db: Db) {
  const rows = db.all<{ payee: string; categoryId: number; type: string; count: number }>(sql`
    SELECT lower(t.payee) AS payee, a.id AS categoryId, a.type AS type, COUNT(*) AS count
    FROM transactions t
    JOIN postings p ON p.transaction_id = t.id
    JOIN accounts a ON a.id = p.account_id
    WHERE t.payee IS NOT NULL AND a.type IN ('income', 'expense')
      AND a.name NOT IN ('Uncategorized', 'Other Income')
    GROUP BY lower(t.payee), a.id`);
  const index = new Map<string, { categoryId: number; count: number }[]>();
  for (const { payee, categoryId, type, count } of rows) {
    const key = `${payee}|${type}`;
    index.set(key, [...(index.get(key) ?? []), { categoryId, count }]);
  }
  return index;
}

// Only when most of the earlier choices agree, so a payee used for two things is left to you.
function learnedCategory(
  history: ReturnType<typeof learnHistory>,
  payee: string,
  direction: 'in' | 'out',
) {
  const choices = history.get(`${payee.toLowerCase()}|${direction === 'in' ? 'income' : 'expense'}`);
  if (!choices) return undefined;
  const total = choices.reduce((sum, choice) => sum + choice.count, 0);
  const best = choices.reduce((top, choice) => (choice.count > top.count ? choice : top));
  return best.count / total >= 0.7 ? best.categoryId : undefined;
}

function lookups(db: Db) {
  const all = db.select().from(accounts).where(eq(accounts.isArchived, false)).all();
  const byName = (name: string, type: string) =>
    all.find((a) => a.name === name && a.type === type)?.id;
  const cards = all.filter((a) => a.subtype === 'credit_card');
  return { all, byName, cards, history: learnHistory(db) };
}

function suggest(
  db: Db,
  ctx: ReturnType<typeof lookups>,
  rulesList: ReturnType<typeof activeRules>,
  row: { description: string; payee?: string | null; channel: string; direction: Direction; amount?: number; accountId?: number | null },
) {
  const rule = firstMatchingRule(rulesList, row);
  if (rule) return { categoryId: rule.categoryId, source: 'rule' as const };

  // The bank's narration carries the card's last four digits. With a single
  // card there is nothing to choose between.
  if (row.channel === 'card_payment' && row.direction === 'out') {
    const named = ctx.cards.filter(
      (c) => c.numberLast4 && new RegExp(`\\b${c.numberLast4}\\b`).test(row.description),
    );
    const pick = named.length === 1 ? named[0] : named.length === 0 && ctx.cards.length === 1 ? ctx.cards[0] : undefined;
    if (pick) return { categoryId: pick.id, source: 'builtin' as const };
  }

  if (row.payee) {
    const learned = learnedCategory(ctx.history, row.payee, row.direction);
    if (learned) return { categoryId: learned, source: 'history' as const };
  }

  const name = builtinCategory(
    { channel: row.channel as never, payee: row.payee ?? undefined },
    row.description,
    row.direction,
  );
  if (name) {
    const id = ctx.byName(name, row.direction === 'in' ? 'income' : 'expense');
    if (id) return { categoryId: id, source: 'builtin' as const };
  }
  return { categoryId: null, source: null };
}

export function stageStatement(
  db: Db,
  input: { text: string; file: StoredFile; accountId?: number; createAccount?: boolean },
) {
  const adapter = detectAdapter(input.text, learnedAdapters(db));
  if (!adapter) {
    throw new DomainError('invalid', 'This statement format is not supported yet');
  }
  const parsed = adapter.parse(input.text);
  if (parsed.rows.length === 0) {
    throw new DomainError('invalid', 'No transactions were found in this statement');
  }

  const sumOfRows = parsed.rows.reduce((total, row) => total + row.amount, 0);
  const reconciliation =
    parsed.inconsistent || (parsed.statedNet !== undefined && parsed.statedNet !== sumOfRows)
      ? 'mismatch'
      : parsed.statedNet === undefined
        ? 'unchecked'
        : 'ok';
  const warnings = [...parsed.warnings];
  if (reconciliation === 'mismatch') {
    warnings.push("The transactions don't add up to the statement's own totals, so some may be missing or misread");
  }

  const batchId = db.transaction((tx) => {
    const store = tx as unknown as Db;

    let document = store.select().from(documents).where(eq(documents.sha256, input.file.sha256)).get();
    if (document) {
      const live = store
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.documentId, document.id), ne(importBatches.status, 'undone')))
        .get();
      if (live) throw new DomainError('conflict', `This file was already imported (import ${live.id})`);
    } else {
      document = store.insert(documents).values(input.file).returning().get();
    }

    let accountId = input.accountId ?? null;
    if (accountId === null && parsed.accountLast4) {
      const wanted = parsed.accountKind === 'credit_card' ? 'liability' : 'asset';
      const matches = store
        .select()
        .from(accounts)
        .where(and(eq(accounts.numberLast4, parsed.accountLast4), eq(accounts.type, wanted), eq(accounts.isArchived, false)))
        .all();
      if (matches.length === 1) accountId = matches[0]!.id;
      else if (matches.length === 0 && input.createAccount) {
        // A statement for an account that is not set up yet: make it, named
        // after the bank and the last digits, so a pile of statements needs no
        // account set-up first. It can be renamed on the Accounts page.
        const isCard = parsed.accountKind === 'credit_card';
        const name = `${adapter.bank} ${isCard ? 'Credit Card' : 'Savings'} ${parsed.accountLast4}`;
        const type = isCard ? ('liability' as const) : ('asset' as const);
        const existing = store.select().from(accounts).where(and(eq(accounts.name, name), eq(accounts.type, type))).get();
        accountId =
          existing?.id ??
          store
            .insert(accounts)
            .values({ name, type, subtype: isCard ? 'credit_card' : 'bank', institution: adapter.bank, numberLast4: parsed.accountLast4 })
            .returning()
            .get().id;
      }
    }

    const batch = store
      .insert(importBatches)
      .values({
        documentId: document.id,
        accountId: null,
        adapterId: adapter.id,
        accountKind: parsed.accountKind,
        accountLast4: parsed.accountLast4,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        openingBalance: parsed.openingBalance,
        closingBalance: parsed.closingBalance,
        dueDate: parsed.dueDate,
        minimumDue: parsed.minimumDue,
        reconciliation,
        warnings,
      })
      .returning()
      .get();

    const alias = payeeAliaser(store);
    const narrations = parsed.rows.map((row) => {
      const narration = parseNarration(row.description);
      return { ...narration, payee: alias(narration.payee) };
    });
    const prints = fingerprints(parsed.rows, narrations.map((n) => n.reference));
    const ctx = lookups(store);
    const rulesList = activeRules(store);

    store
      .insert(stagedTransactions)
      .values(
        parsed.rows.map((row, index) => {
          const narration = narrations[index]!;
          const direction: Direction = row.amount > 0 ? 'in' : 'out';
          const guess = suggest(store, ctx, rulesList, {
            description: row.description,
            payee: narration.payee,
            channel: narration.channel,
            direction,
            amount: row.amount,
            accountId,
          });
          return {
            batchId: batch.id,
            position: index,
            date: row.date,
            description: row.description,
            amount: row.amount,
            balance: row.balance,
            channel: narration.channel,
            payee: narration.payee,
            reference: narration.reference,
            fingerprint: prints[index]!,
            categoryId: guess.categoryId,
            categorySource: guess.source,
            // The bank statement already records a card payment as a transfer,
            // so counting it again on the card would pay the bill twice.
            status:
              parsed.accountKind === 'credit_card' && narration.channel === 'card_payment' && row.amount > 0
                ? ('skipped' as const)
                : ('pending' as const),
          };
        }),
      )
      .run();

    if (accountId !== null) setAccount(store, batch.id, accountId);
    return batch.id;
  });

  return getImportBatch(db, batchId);
}

function assertAccountFits(db: Db, kind: 'bank' | 'credit_card', accountId: number) {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account || account.isArchived) throw new DomainError('invalid', 'Choose one of your accounts');
  const expected = kind === 'credit_card' ? 'liability' : 'asset';
  if (account.type !== expected) {
    throw new DomainError(
      'invalid',
      kind === 'credit_card'
        ? 'A credit card statement belongs to a credit card account'
        : 'A bank statement belongs to a bank account',
    );
  }
}

function getStagedBatch(db: Db, batchId: number) {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
  if (!batch) throw new DomainError('not_found', `Import ${batchId} not found`);
  if (batch.status !== 'staged') throw new DomainError('conflict', 'This import is already finished');
  return batch;
}

// Rows already imported for the same account are marked so they are not added twice.
function markDuplicates(db: Db, batchId: number, accountId: number) {
  db.update(stagedTransactions)
    .set({ status: 'pending' })
    .where(and(eq(stagedTransactions.batchId, batchId), eq(stagedTransactions.status, 'duplicate')))
    .run();

  const mine = db
    .select({ id: stagedTransactions.id, fingerprint: stagedTransactions.fingerprint })
    .from(stagedTransactions)
    .where(and(eq(stagedTransactions.batchId, batchId), eq(stagedTransactions.status, 'pending')))
    .all();
  if (mine.length === 0) return;

  const known = new Set<string>();
  for (let start = 0; start < mine.length; start += 500) {
    const chunk = mine.slice(start, start + 500).map((row) => row.fingerprint);
    db.select({ fingerprint: stagedTransactions.fingerprint })
      .from(stagedTransactions)
      .innerJoin(importBatches, eq(importBatches.id, stagedTransactions.batchId))
      .where(
        and(
          eq(importBatches.accountId, accountId),
          eq(stagedTransactions.status, 'committed'),
          inArray(stagedTransactions.fingerprint, chunk),
        ),
      )
      .all()
      .forEach((row) => known.add(row.fingerprint));
  }

  const duplicateIds = mine.filter((row) => known.has(row.fingerprint)).map((row) => row.id);
  for (let start = 0; start < duplicateIds.length; start += 500) {
    db.update(stagedTransactions)
      .set({ status: 'duplicate' })
      .where(inArray(stagedTransactions.id, duplicateIds.slice(start, start + 500)))
      .run();
  }
}

function setAccount(db: Db, batchId: number, accountId: number) {
  const batch = getStagedBatch(db, batchId);
  assertAccountFits(db, batch.accountKind, accountId);
  db.update(importBatches).set({ accountId }).where(eq(importBatches.id, batchId)).run();
  markDuplicates(db, batchId, accountId);
}

export function assignAccount(db: Db, batchId: number, accountId: number) {
  db.transaction((tx) => {
    setAccount(tx as unknown as Db, batchId, accountId);
    // Rules can depend on the account, which is only known now.
    reapplyRules(tx as unknown as Db, batchId);
  });
  return getImportBatch(db, batchId);
}

export const stagedPatchSchema = z.object({
  categoryId: z.number().int().positive().nullable().optional(),
  status: z.enum(['pending', 'skipped']).optional(),
  // Remember this choice for future statements and apply it to similar rows now.
  createRule: z.boolean().optional(),
});

export function updateStagedRow(db: Db, rowId: number, input: z.input<typeof stagedPatchSchema>) {
  const patch = stagedPatchSchema.parse(input);

  db.transaction((tx) => {
    const store = tx as unknown as Db;
    const row = store.select().from(stagedTransactions).where(eq(stagedTransactions.id, rowId)).get();
    if (!row) throw new DomainError('not_found', `Row ${rowId} not found`);
    getStagedBatch(store, row.batchId);

    if (patch.categoryId) {
      const category = store.select().from(accounts).where(eq(accounts.id, patch.categoryId)).get();
      if (!category || category.isArchived || category.type === 'equity') {
        throw new DomainError('invalid', 'Choose a category or an account');
      }
    }

    const changes: Partial<typeof stagedTransactions.$inferInsert> = {};
    if (patch.categoryId !== undefined) {
      changes.categoryId = patch.categoryId;
      changes.categorySource = patch.categoryId === null ? null : 'manual';
    }
    if (patch.status && row.status !== 'duplicate') changes.status = patch.status;
    if (Object.keys(changes).length > 0) {
      store.update(stagedTransactions).set(changes).where(eq(stagedTransactions.id, rowId)).run();
    }

    if (patch.createRule && patch.categoryId) {
      createRule(store, {
        pattern: row.payee ?? row.description.slice(0, 40),
        categoryId: patch.categoryId,
      });
      reapplyRules(store, row.batchId);
    }
  });

  return getStagedRow(db, rowId);
}

// Fills in suggestions for rows nobody has decided yet. This picks up accounts
// and rules added since the statement was read, such as a new credit card.
export function refreshSuggestions(db: Db, batchId: number) {
  db.transaction((tx) => {
    const store = tx as unknown as Db;
    getStagedBatch(store, batchId);
    const ctx = lookups(store);
    const rulesList = activeRules(store);
    const batchAccount = store.select().from(importBatches).where(eq(importBatches.id, batchId)).get()?.accountId ?? null;
    const rows = store
      .select()
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.batchId, batchId),
          eq(stagedTransactions.status, 'pending'),
          isNull(stagedTransactions.categoryId),
        ),
      )
      .all();
    for (const row of rows) {
      const guess = suggest(store, ctx, rulesList, {
        description: row.description,
        payee: row.payee,
        channel: row.channel ?? 'other',
        direction: row.amount > 0 ? 'in' : 'out',
        amount: row.amount,
        accountId: batchAccount,
      });
      if (guess.categoryId) {
        store
          .update(stagedTransactions)
          .set({ categoryId: guess.categoryId, categorySource: guess.source })
          .where(eq(stagedTransactions.id, row.id))
          .run();
      }
    }
  });
  return getImportBatch(db, batchId);
}

// Re-runs the rules over rows that have not been decided by hand.
function reapplyRules(db: Db, batchId: number) {
  const rulesList = activeRules(db);
  const batchAccount = db.select().from(importBatches).where(eq(importBatches.id, batchId)).get()?.accountId ?? null;
  const rows = db
    .select()
    .from(stagedTransactions)
    .where(and(eq(stagedTransactions.batchId, batchId), eq(stagedTransactions.status, 'pending')))
    .all();
  for (const row of rows) {
    if (row.categorySource === 'manual') continue;
    const rule = firstMatchingRule(rulesList, { ...row, accountId: batchAccount });
    if (rule && rule.categoryId !== row.categoryId) {
      db.update(stagedTransactions)
        .set({ categoryId: rule.categoryId, categorySource: 'rule' })
        .where(eq(stagedTransactions.id, row.id))
        .run();
    }
  }
}

function getStagedRow(db: Db, rowId: number) {
  const row = db
    .select({
      id: stagedTransactions.id,
      batchId: stagedTransactions.batchId,
      date: stagedTransactions.date,
      description: stagedTransactions.description,
      amount: stagedTransactions.amount,
      channel: stagedTransactions.channel,
      payee: stagedTransactions.payee,
      categoryId: stagedTransactions.categoryId,
      categorySource: stagedTransactions.categorySource,
      status: stagedTransactions.status,
    })
    .from(stagedTransactions)
    .where(eq(stagedTransactions.id, rowId))
    .get();
  if (!row) throw new DomainError('not_found', `Row ${rowId} not found`);
  return row;
}

const batchColumns = {
  id: importBatches.id,
  status: importBatches.status,
  adapterId: importBatches.adapterId,
  accountKind: importBatches.accountKind,
  accountLast4: importBatches.accountLast4,
  accountId: importBatches.accountId,
  accountName: accounts.name,
  filename: documents.filename,
  periodStart: importBatches.periodStart,
  periodEnd: importBatches.periodEnd,
  openingBalance: importBatches.openingBalance,
  closingBalance: importBatches.closingBalance,
  reconciliation: importBatches.reconciliation,
  warnings: importBatches.warnings,
  createdAt: importBatches.createdAt,
  committedAt: importBatches.committedAt,
};

function batchQuery(db: Db) {
  return db
    .select(batchColumns)
    .from(importBatches)
    .innerJoin(documents, eq(documents.id, importBatches.documentId))
    .leftJoin(accounts, eq(accounts.id, importBatches.accountId));
}

export function listImportBatches(db: Db) {
  const batches = batchQuery(db).orderBy(desc(importBatches.id)).all();
  const rows = db
    .select({ batchId: stagedTransactions.batchId, status: stagedTransactions.status })
    .from(stagedTransactions)
    .all();
  return batches.map((batch) => {
    const mine = rows.filter((row) => row.batchId === batch.id);
    const count = (status: string) => mine.filter((row) => row.status === status).length;
    return {
      ...batch,
      bank: bankOf(db, batch.adapterId),
      counts: {
        total: mine.length,
        pending: count('pending'),
        duplicate: count('duplicate'),
        skipped: count('skipped'),
        committed: count('committed'),
      },
    };
  });
}

export function getImportBatch(db: Db, id: number) {
  const batch = batchQuery(db).where(eq(importBatches.id, id)).get();
  if (!batch) throw new DomainError('not_found', `Import ${id} not found`);

  const items = db
    .select({
      id: stagedTransactions.id,
      date: stagedTransactions.date,
      description: stagedTransactions.description,
      amount: stagedTransactions.amount,
      channel: stagedTransactions.channel,
      payee: stagedTransactions.payee,
      categoryId: stagedTransactions.categoryId,
      categorySource: stagedTransactions.categorySource,
      status: stagedTransactions.status,
    })
    .from(stagedTransactions)
    .where(eq(stagedTransactions.batchId, id))
    .orderBy(asc(stagedTransactions.position))
    .all();

  return { ...batch, bank: bankOf(db, batch.adapterId), items };
}

export function commitBatch(db: Db, batchId: number, options: { acceptMismatch?: boolean } = {}) {
  db.transaction((tx) => {
    const store = tx as unknown as Db;
    const batch = getStagedBatch(store, batchId);
    if (batch.accountId === null) throw new DomainError('invalid', 'Choose the account first');
    if (batch.reconciliation === 'mismatch' && !options.acceptMismatch) {
      throw new DomainError('conflict', "The transactions don't match the statement totals. Confirm to import anyway.");
    }

    const { byName } = lookups(store);
    const rows = store
      .select()
      .from(stagedTransactions)
      .where(and(eq(stagedTransactions.batchId, batchId), eq(stagedTransactions.status, 'pending')))
      .orderBy(asc(stagedTransactions.position))
      .all();
    if (rows.length === 0) throw new DomainError('invalid', 'There are no transactions left to import');

    const fallbackOut = byName('Uncategorized', 'expense');
    const fallbackIn = byName('Other Income', 'income');

    for (const row of rows) {
      if (row.channel === 'card_payment' && row.categoryId === null) {
        throw new DomainError('invalid', 'Choose the account each card payment belongs to, or skip it');
      }
      const counter = row.categoryId ?? (row.amount < 0 ? fallbackOut : fallbackIn);
      if (!counter) throw new DomainError('invalid', 'Choose a category for every transaction');

      // The bank may already have announced this one by email, and it is in the books: take that over.
      const taken = adoptAlertTransaction(store, batch.accountId, { date: row.date, amount: row.amount });
      if (taken !== null) {
        // A payslip's split entry keeps its own wording; an alert's is replaced by the bank's.
        const fromAlert = taken.source.startsWith('alert:');
        store
          .update(transactions)
          .set({
            date: row.date,
            source: `import:${batchId}`,
            updatedAt: new Date().toISOString(),
            ...(fromAlert ? { description: (row.payee ?? row.description).slice(0, 500), payee: row.payee, notes: row.description.slice(0, 2000) } : {}),
          })
          .where(eq(transactions.id, taken.id))
          .run();
        // Filed by a rule or history now, where the alert could only guess.
        const current = store.select({ name: accounts.name }).from(accounts).innerJoin(postings, eq(postings.accountId, accounts.id)).where(and(eq(postings.transactionId, taken.id), inArray(accounts.name, ['Uncategorized', 'Other Income']))).get();
        if (fromAlert && current && row.categoryId !== null) setTransactionCategory(store, taken.id, row.categoryId);
        store.update(stagedTransactions).set({ status: 'committed', transactionId: taken.id }).where(eq(stagedTransactions.id, row.id)).run();
        continue;
      }
      const created = createTransaction(store, {
        date: row.date,
        description: (row.payee ?? row.description).slice(0, 500),
        payee: row.payee ?? undefined,
        notes: row.description.slice(0, 2000),
        source: `import:${batchId}`,
        postings: [
          { accountId: batch.accountId, amount: row.amount },
          { accountId: counter, amount: -row.amount },
        ],
      });
      store
        .update(stagedTransactions)
        .set({ status: 'committed', transactionId: created.id })
        .where(eq(stagedTransactions.id, row.id))
        .run();
    }

    store
      .update(importBatches)
      .set({ status: 'committed', committedAt: new Date().toISOString() })
      .where(eq(importBatches.id, batchId))
      .run();
  });
  return getImportBatch(db, batchId);
}

// Removes everything the import created, leaving the ledger as it was before.
export function undoBatch(db: Db, batchId: number) {
  db.transaction((tx) => {
    const store = tx as unknown as Db;
    const batch = store.select().from(importBatches).where(eq(importBatches.id, batchId)).get();
    if (!batch) throw new DomainError('not_found', `Import ${batchId} not found`);
    if (batch.status !== 'committed') throw new DomainError('conflict', 'Only a finished import can be undone');

    const rows = store
      .select()
      .from(stagedTransactions)
      .where(and(eq(stagedTransactions.batchId, batchId), eq(stagedTransactions.status, 'committed')))
      .all();
    const ids = rows.flatMap((row) => (row.transactionId ? [row.transactionId] : []));
    for (let start = 0; start < ids.length; start += 500) {
      store.delete(transactions).where(inArray(transactions.id, ids.slice(start, start + 500))).run();
    }
    store
      .update(stagedTransactions)
      .set({ status: 'undone', transactionId: null })
      .where(and(eq(stagedTransactions.batchId, batchId), eq(stagedTransactions.status, 'committed')))
      .run();
    store.update(importBatches).set({ status: 'undone' }).where(eq(importBatches.id, batchId)).run();
  });
  return getImportBatch(db, batchId);
}

// Throws away a batch that was never committed and returns the stored file's
// name when nothing else uses it, so the caller can delete the file.
export function discardBatch(db: Db, batchId: number) {
  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    const batch = getStagedBatch(store, batchId);
    store.delete(importBatches).where(eq(importBatches.id, batchId)).run();

    const stillUsed = store
      .select()
      .from(importBatches)
      .where(eq(importBatches.documentId, batch.documentId))
      .get();
    if (stillUsed) return undefined;

    const document = store.select().from(documents).where(eq(documents.id, batch.documentId)).get();
    store.delete(documents).where(eq(documents.id, batch.documentId)).run();
    return document?.storedName;
  });
}
