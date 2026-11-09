import { accounts, payslips, transactions, type Db } from '@ledgerly/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createAccount } from './accounts.ts';
import { DomainError } from './errors.ts';
import { createTransaction } from './transactions.ts';

export const DEDUCTION_KINDS = ['tax', 'pf', 'professional_tax', 'other'] as const;
export type DeductionKind = (typeof DEDUCTION_KINDS)[number];

const money = (text: string) => Math.round(Number(text.replace(/,/g, '')) * 100);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export type PayslipDraft = {
  month: string | null;
  gross: number | null;
  net: number | null;
  deductions: { label: string; kind: DeductionKind; amount: number }[];
  // What could not be read, so the person knows what to fill in.
  notes: string[];
};

const AMOUNT = String.raw`(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{1,2})?)`;
const first = (text: string, pattern: RegExp) => {
  const hit = text.match(pattern);
  return hit?.[1] ? money(hit[1]) : null;
};

// A payslip's layout is the employer's own, so this reads the common labels and returns a draft
// that a person confirms. Nothing is added to the books from it until they do.
export function parsePayslipText(text: string): PayslipDraft {
  const notes: string[] = [];
  const flat = text.replace(/\r/g, '');

  const monthHit = flat.match(/(?:month of|for the month|pay ?period|salary for|payslip for|pay slip for)[:\s-]*([A-Za-z]{3,9})[\s,.-]+(\d{4})/i) ?? flat.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)[\s,-]+(\d{4})\b/i);
  const monthIndex = monthHit ? MONTHS.indexOf(monthHit[1]!.slice(0, 3).toLowerCase()) : -1;
  const month = monthIndex >= 0 ? `${monthHit![2]}-${String(monthIndex + 1).padStart(2, '0')}` : null;
  if (!month) notes.push('Could not find the month');

  const gross = first(flat, new RegExp(String.raw`(?:gross\s+(?:salary|earnings|pay|total)|total\s+earnings|total\s+gross)\D{0,40}?` + AMOUNT, 'i'));
  if (gross === null) notes.push('Could not find the gross pay');
  const net = first(flat, new RegExp(String.raw`(?:net\s+(?:pay|salary|amount|payable|take[- ]?home)|take[- ]?home(?:\s+pay)?|net\s+payable)\D{0,40}?` + AMOUNT, 'i'));
  if (net === null) notes.push('Could not find the net pay');

  const deductions: PayslipDraft['deductions'] = [];
  const add = (label: string, kind: DeductionKind, pattern: RegExp) => {
    const amount = first(flat, pattern);
    if (amount && amount > 0) deductions.push({ label, kind, amount });
  };
  add('Income tax (TDS)', 'tax', new RegExp(String.raw`(?:income\s+tax|tax\s+deducted(?:\s+at\s+source)?|\bTDS\b)\D{0,40}?` + AMOUNT, 'i'));
  // The employee's share only: a line that names the employer is not taken out of pay.
  add('Provident fund (employee)', 'pf', new RegExp(String.raw`(?<!employer\s)(?<!employer's\s)(?:provident\s+fund|\bE?PF\b)(?!\s*(?:\(?employer|contribution\s+by\s+employer))\D{0,40}?` + AMOUNT, 'i'));
  add('Professional tax', 'professional_tax', new RegExp(String.raw`(?:professional\s+tax|\bPT\b)\D{0,40}?` + AMOUNT, 'i'));

  // Whatever the total of deductions says beyond those, as one line to be named.
  const total = first(flat, new RegExp(String.raw`total\s+deductions?\D{0,40}?` + AMOUNT, 'i'));
  if (total !== null) {
    const known = deductions.reduce((s, d) => s + d.amount, 0);
    if (total > known) deductions.push({ label: 'Other deductions', kind: 'other', amount: total - known });
  } else if (gross !== null && net !== null) {
    const known = deductions.reduce((s, d) => s + d.amount, 0);
    if (gross - net > known) deductions.push({ label: 'Other deductions', kind: 'other', amount: gross - net - known });
  }
  return { month, gross, net, deductions, notes };
}

const inputSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  employer: z.string().trim().min(1).max(100),
  accountId: z.number().int().positive(),
  gross: z.number().int().positive(),
  deductions: z.array(z.object({ label: z.string().trim().min(1).max(80), kind: z.enum(DEDUCTION_KINDS), amount: z.number().int().positive() })).max(20),
  // The day it was paid, if not the last day of the month.
  paidOn: z.iso.date().optional(),
});

function named(db: Db, name: string, type: 'income' | 'expense' | 'asset') {
  const found = db.select().from(accounts).where(and(eq(accounts.name, name), eq(accounts.type, type))).get();
  if (found) return found.id;
  return createAccount(db, type === 'asset' ? { name, type, subtype: 'investment' } : { name, type }).id;
}

// Records the full salary with its deductions split out, as what reaches the bank. The bank
// statement that later shows the credit takes this over, so the salary is not counted twice.
export function createPayslip(db: Db, raw: z.input<typeof inputSchema>) {
  const input = inputSchema.parse(raw);
  const taken = input.deductions.reduce((s, d) => s + d.amount, 0);
  const net = input.gross - taken;
  if (net <= 0) throw new DomainError('invalid', 'The deductions come to more than the gross pay');
  if (db.select().from(payslips).where(and(eq(payslips.month, input.month), eq(payslips.employer, input.employer))).get()) {
    throw new DomainError('conflict', 'That month is already recorded for this employer');
  }
  const bank = db.select().from(accounts).where(eq(accounts.id, input.accountId)).get();
  if (!bank || bank.type !== 'asset') throw new DomainError('invalid', 'Choose the bank account the salary is paid into');

  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    const lastDay = new Date(Date.UTC(Number(input.month.slice(0, 4)), Number(input.month.slice(5, 7)), 0)).getUTCDate();
    const date = input.paidOn ?? `${input.month}-${String(lastDay).padStart(2, '0')}`;
    const target = (kind: DeductionKind) =>
      kind === 'pf' ? named(store, 'Provident Fund', 'asset') : kind === 'other' ? named(store, 'Salary deductions', 'expense') : named(store, 'Taxes', 'expense');

    const created = createTransaction(store, {
      date,
      description: `Salary ${input.month}`,
      payee: input.employer,
      notes: `Payslip: gross ${input.gross / 100}, deductions ${taken / 100}, net ${net / 100}`,
      source: `payslip:${input.month}`,
      postings: [
        { accountId: input.accountId, amount: net },
        { accountId: named(store, 'Salary', 'income'), amount: -input.gross },
        ...input.deductions.map((d) => ({ accountId: target(d.kind), amount: d.amount })),
      ],
    });
    return store
      .insert(payslips)
      .values({ month: input.month, employer: input.employer, accountId: input.accountId, gross: input.gross, net, deductions: input.deductions, transactionId: created.id })
      .returning()
      .get();
  });
}

export function listPayslips(db: Db) {
  return db.select().from(payslips).orderBy(desc(payslips.month)).all();
}

export function deletePayslip(db: Db, id: number) {
  const row = db.select().from(payslips).where(eq(payslips.id, id)).get();
  if (!row) throw new DomainError('not_found', 'No such payslip');
  db.transaction((tx) => {
    if (row.transactionId) tx.delete(transactions).where(eq(transactions.id, row.transactionId)).run();
    tx.delete(payslips).where(eq(payslips.id, id)).run();
  });
}

// For a financial year (April to March), for the tax pack.
export function payslipTotals(db: Db, from: string, to: string) {
  const rows = listPayslips(db).filter((p) => `${p.month}-01` >= from && `${p.month}-28` <= to).sort((a, b) => a.month.localeCompare(b.month));
  const sumKind = (p: (typeof rows)[number], kind: DeductionKind) => p.deductions.filter((d) => d.kind === kind).reduce((s, d) => s + d.amount, 0);
  return {
    rows: rows.map((p) => ({ month: p.month, employer: p.employer, gross: p.gross, tax: sumKind(p, 'tax'), pf: sumKind(p, 'pf'), professionalTax: sumKind(p, 'professional_tax'), other: sumKind(p, 'other'), net: p.net })),
  };
}
