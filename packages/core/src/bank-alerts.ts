import { createHash } from 'node:crypto';
import { accounts, alertEntries, postings, transactions, type Db } from '@ledgerly/db';
import { and, between, desc, eq, like, or, sql } from 'drizzle-orm';
import { createTransaction } from './transactions.ts';
import { DomainError } from './errors.ts';
import { builtinCategory } from './imports/categorize.ts';
import { parseNarration } from './imports/narration.ts';
import { getSetting, setSetting } from './settings.ts';

// What a bank's "you spent ..." or "... was debited" email says, read out of its text.
export type ParsedAlert = { amount: number; direction: 'out' | 'in'; kind: 'card' | 'account'; last4: string; date: string; description: string; reference: string | null };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function readDate(text: string): string | null {
  const numeric = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/);
  if (numeric) {
    const [, d, m, y] = numeric;
    const year = y!.length === 2 ? 2000 + Number(y) : Number(y);
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) return `${year}-${pad(Number(m))}-${pad(Number(d))}`;
  }
  const named = text.match(/\b(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(\d{4}|\d{2})\b/);
  if (named) {
    const month = MONTHS.indexOf(named[2]!.toLowerCase());
    if (month >= 0) return `${named[3]!.length === 2 ? 2000 + Number(named[3]) : Number(named[3])}-${pad(month + 1)}-${pad(Number(named[1]))}`;
  }
  return null;
}

// Returns null unless the message clearly says how much, which way, and on which account or
// card (by its last four digits). A message that is ambiguous is better left unread than guessed.
export function parseAlertEmail(subject: string, body: string, received = new Date().toISOString().slice(0, 10)): ParsedAlert | null {
  const text = `${subject}. ${body}`.replace(/\s+/g, ' ').slice(0, 4000);
  if (/\bOTP\b|one[- ]time password|\bCVV\b|verification code/i.test(text)) return null;

  const amount = text.match(/(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!amount) return null;
  const paise = Math.round(Number(amount[1]!.replace(/,/g, '')) * 100);
  if (!Number.isFinite(paise) || paise <= 0) return null;

  const out = /\b(debited|spent|withdrawn|purchase|paid|payment of|used for)\b/i.test(text);
  const into = /\b(credited|received|deposited|refund(?:ed)?)\b/i.test(text);
  // Both at once, as in a transfer between two accounts, cannot be told apart safely.
  if (out === into) return null;

  const account = text.match(/(credit card|card|a\/c|acct|account)(?:\s*(?:no\.?|number|ending(?: with)?))?\s*[:.-]?\s*(?:[xX*•#]+\s*)?(\d{4})\b/i);
  if (!account) return null;
  const kind = /card/i.test(account[1]!) ? 'card' : 'account';

  const info = text.match(/\bInfo[:\s-]+(.{3,90}?)(?=\.\s|\s{2}|\sAvl\b|\sAvailable\b|\sBal\b|\sIf not\b|$)/i)?.[1]?.trim();
  const merchant = text.match(/\b(?:at|towards|to)\s+([A-Za-z0-9][A-Za-z0-9 &.*@_/-]{2,40}?)(?=\s+on\b|\s+at\b|\.|,|\s+Avl|\s+Available|$)/)?.[1]?.trim();
  const description = (info || merchant || (out ? 'Card or account debit' : 'Credit')).slice(0, 120);
  const reference = text.match(/\b(?:UPI|IMPS|NEFT|RTGS|Ref(?:erence)?(?: No\.?)?)\b.{0,20}?\b(\d{9,14})\b/i)?.[1] ?? null;

  return { amount: paise, direction: out ? 'out' : 'in', kind, last4: account[2]!, date: readDate(text) ?? received, description, reference };
}

// ---- Keeping what was read ----------------------------------------------------------

const AUTO = 'alerts.autoAdd';
export const getAutoAdd = (db: Db) => getSetting(db, AUTO) === 'on';
export const setAutoAdd = (db: Db, on: boolean) => setSetting(db, AUTO, on ? 'on' : 'off');

// The ledger's sign for the account: money out of a bank account, or a charge on a card, is negative.
const signed = (alert: ParsedAlert) => (alert.direction === 'out' ? -alert.amount : alert.amount);

function accountFor(db: Db, alert: ParsedAlert) {
  const matches = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.numberLast4, alert.last4), eq(accounts.isArchived, false)))
    .all()
    .filter((a) => (alert.kind === 'card' ? a.subtype === 'credit_card' : a.type === 'asset'));
  return matches.length === 1 ? matches[0]! : null;
}

export function recordAlert(db: Db, alert: ParsedAlert, sender: string) {
  const fingerprint = createHash('sha1')
    .update([alert.date, alert.amount, alert.direction, alert.last4, alert.reference ?? alert.description.toLowerCase().slice(0, 30)].join('|'))
    .digest('hex');
  const account = accountFor(db, alert);
  const added = db
    .insert(alertEntries)
    .values({ accountId: account?.id ?? null, date: alert.date, description: alert.description, amount: signed(alert), last4: alert.last4, reference: alert.reference, fingerprint, sender })
    .onConflictDoNothing()
    .returning()
    .get();
  if (!added) return { entry: null, added: false };
  if (account && getAutoAdd(db)) return { entry: addAlert(db, added.id), added: true };
  return { entry: added, added: false };
}

// Puts a read alert into the books now, filed the way the same payee was filed before. The
// statement that later brings the same transaction adopts it instead of adding it again.
export function addAlert(db: Db, id: number, accountId?: number) {
  const entry = db.select().from(alertEntries).where(eq(alertEntries.id, id)).get();
  if (!entry) throw new DomainError('not_found', 'No such alert');
  if (entry.status !== 'new') throw new DomainError('conflict', 'That one has already been dealt with');
  const target = accountId ?? entry.accountId;
  if (!target) throw new DomainError('invalid', 'Choose which account this belongs to');
  const account = db.select().from(accounts).where(eq(accounts.id, target)).get();
  if (!account || !['asset', 'liability'].includes(account.type)) throw new DomainError('invalid', 'Choose a bank account or a card');

  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    const direction = entry.amount < 0 ? 'out' : 'in';
    const narration = parseNarration(entry.description);
    const guess = builtinCategory(narration, entry.description, direction);
    const byName = (name: string, type: 'income' | 'expense') => store.select().from(accounts).where(and(eq(accounts.name, name), eq(accounts.type, type))).get()?.id;
    const counter = (guess && byName(guess, direction === 'in' ? 'income' : 'expense')) || byName(direction === 'in' ? 'Other Income' : 'Uncategorized', direction === 'in' ? 'income' : 'expense');
    if (!counter) throw new DomainError('invalid', 'The starter categories are missing');
    const created = createTransaction(store, {
      date: entry.date,
      description: (narration.payee ?? entry.description).slice(0, 500),
      payee: narration.payee ?? undefined,
      notes: `From a bank alert: ${entry.description}`.slice(0, 2000),
      source: `alert:${entry.id}`,
      postings: [
        { accountId: target, amount: entry.amount },
        { accountId: counter, amount: -entry.amount },
      ],
    });
    store.update(alertEntries).set({ status: 'added', accountId: target, transactionId: created.id }).where(eq(alertEntries.id, id)).run();
    return store.select().from(alertEntries).where(eq(alertEntries.id, id)).get()!;
  });
}

export function dismissAlert(db: Db, id: number) {
  db.update(alertEntries).set({ status: 'dismissed' }).where(and(eq(alertEntries.id, id), eq(alertEntries.status, 'new'))).run();
}

export function listAlertEntries(db: Db) {
  return db
    .select({ entry: alertEntries, account: accounts.name })
    .from(alertEntries)
    .leftJoin(accounts, eq(accounts.id, alertEntries.accountId))
    .where(sql`${alertEntries.status} != 'dismissed'`)
    .orderBy(desc(alertEntries.date), desc(alertEntries.id))
    .limit(100)
    .all()
    .map(({ entry, account }) => ({ ...entry, accountName: account }));
}

// ---- Meeting the statement ---------------------------------------------------------------

const DAY = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

// When a statement brings a transaction the bank had already announced, the transaction already
// in the books (from an alert, or a payslip) is taken over (keeping the category you chose and any receipts), and not added
// a second time. An alert not yet added is simply marked as covered. Returns the id taken over.
export function adoptAlertTransaction(db: Db, accountId: number, row: { date: string; amount: number }): { id: number; source: string } | null {
  const near = [shift(row.date, -3), shift(row.date, 3)] as const;
  const found = db
    .select({ id: transactions.id, source: transactions.source })
    .from(transactions)
    .innerJoin(postings, eq(postings.transactionId, transactions.id))
    .where(and(or(like(transactions.source, 'alert:%'), like(transactions.source, 'payslip:%')), eq(postings.accountId, accountId), eq(postings.amount, row.amount), between(transactions.date, near[0], near[1])))
    .orderBy(sql`abs(julianday(${transactions.date}) - julianday(${row.date}))`)
    .limit(1)
    .get();
  if (found) return found;
  db.update(alertEntries)
    .set({ status: 'dismissed' })
    .where(and(eq(alertEntries.accountId, accountId), eq(alertEntries.amount, row.amount), eq(alertEntries.status, 'new'), between(alertEntries.date, near[0], near[1])))
    .run();
  return null;
}

