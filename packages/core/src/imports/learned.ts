import type { Db } from '@ledgerly/db';
import { z } from 'zod';
import { DomainError } from '../errors.ts';
import { getSetting, setSetting } from '../settings.ts';
import { csvDate } from './adapters/csv-bank.ts';
import type { ParsedRow, ParsedStatement, StatementAdapter } from './types.ts';

// A statement layout a model worked out from one sample, kept as plain data
// (a row pattern and a few rules), never as code. This file is the only thing
// that runs it, and each parse is checked against the statement's own running
// balance, so a recipe that misreads a statement is caught, not trusted.
export const recipeSchema = z.object({
  bank: z.string().trim().min(1).max(60),
  accountKind: z.enum(['bank', 'credit_card']),
  // Words that appear on every statement from this bank in this layout.
  detect: z.array(z.string().trim().min(2).max(60)).min(2).max(6),
  // One line of the table. Named groups: date, description, then amount or
  // debit and credit; optionally balance and drcr (the "Dr"/"Cr" next to an amount).
  row: z.string().min(10).max(500),
  // A row's description carries on over the next line or two.
  continuation: z.boolean().default(false),
  // Flip every amount's direction (set when the balance proves they are backwards).
  invert: z.boolean().default(false),
  // Optional patterns whose first group is the account's last four digits, or two dates.
  // Optional pattern whose first group is the opening balance, which proves the first row's direction.
  opening: z.string().max(200).optional(),
  last4: z.string().max(200).optional(),
  period: z.string().max(300).optional(),
});
export type Recipe = z.infer<typeof recipeSchema>;

const MAX_LINE = 400;
const STOP = /^\s*(page\s+\d|total|opening|closing|statement|this is a computer|registered office)/i;

// Patterns are checked for shapes that can run away on a long line.
export function compile(source: string, flags = 'i'): RegExp {
  if (/\\[1-9]|\(\?<[=!]/.test(source)) throw new DomainError('invalid', 'The row pattern uses a feature that is not allowed');
  if (/\([^()]*[*+}][^()]*\)[*+{]/.test(source)) throw new DomainError('invalid', 'The row pattern repeats a repeat, which is not allowed');
  try {
    return new RegExp(source, flags);
  } catch {
    throw new DomainError('invalid', 'The row pattern is not a valid pattern');
  }
}

function money(text: string): number | undefined {
  const cleaned = text.replace(/[₹\s]|rs\.?|inr/gi, '').replace(/,/g, '');
  if (!cleaned) return undefined;
  const negative = cleaned.startsWith('-') || /^\(.*\)$/.test(cleaned);
  const plain = cleaned.replace(/[()-]/g, '').replace(/(dr|cr)$/i, '');
  const rounded = Math.round(Number(plain) * 100);
  return Number.isFinite(rounded) ? (negative ? -rounded : rounded) : undefined;
}

const direction = (text: string | undefined) => (!text ? 0 : /^(dr|d|debit)\b/i.test(text.trim()) ? -1 : /^(cr|c|credit)\b/i.test(text.trim()) ? 1 : 0);

export type LearnedParse = ParsedStatement & { rowCount: number; unreadLines: string[]; openingFound: boolean };

export function parseWithRecipe(recipe: Recipe, text: string, adapterId: string): LearnedParse {
  const re = compile(recipe.row);
  const lines = text.split(/\r?\n/);
  const rows: (ParsedRow & { text: string })[] = [];
  const unread: string[] = [];
  let carrying = 0;

  for (const line of lines) {
    if (line.length > MAX_LINE) continue;
    const g = re.exec(line)?.groups;
    const date = g?.date ? csvDate(g.date) : undefined;
    if (g && date && g.description !== undefined) {
      const debit = g.debit ? money(g.debit) : undefined;
      const credit = g.credit ? money(g.credit) : undefined;
      let amount: number | undefined;
      if (g.debit !== undefined || g.credit !== undefined) amount = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
      else if (g.amount) {
        const value = money(`${g.amount}`);
        const dir = direction(g.drcr) || direction(/(dr|cr)$/i.exec(g.amount.trim())?.[0]);
        if (value !== undefined) amount = dir ? dir * Math.abs(value) : recipe.accountKind === 'credit_card' ? -value : value;
      }
      if (amount === undefined || amount === 0) continue;
      const balance = g.balance ? money(g.balance) : undefined;
      rows.push({ date, description: g.description.replace(/\s+/g, ' ').trim(), amount: recipe.invert ? -amount : amount, balance, text: line });
      carrying = recipe.continuation ? 2 : 0;
    } else if (carrying > 0 && line.trim() && !STOP.test(line)) {
      const last = rows.at(-1);
      if (last) last.description = `${last.description} ${line.trim()}`.replace(/\s+/g, ' ').slice(0, 300);
      carrying -= 1;
    } else {
      carrying = 0;
      if (/^\s*\d{1,2}[/\-. ][A-Za-z0-9]{2,3}[/\-. ]\d{2,4}\b/.test(line) && /\d[\d,]*\.\d{2}/.test(line) && unread.length < 6) unread.push(line.trim());
    }
  }

  const ordered = rows.length > 1 && rows[0]!.date > rows.at(-1)!.date ? [...rows].reverse() : rows;
  const openingText = recipe.opening ? compile(recipe.opening).exec(text)?.[1] : undefined;
  const opening = openingText ? money(openingText) : undefined;
  // Plain-text columns cannot say which of debit and credit an amount sits under, but
  // the balance can: it moves by exactly the amount, up or down.
  if (recipe.accountKind === 'bank') {
    let previous = opening === undefined ? undefined : Math.abs(opening);
    for (const row of ordered) {
      if (previous !== undefined && row.balance !== undefined) {
        const moved = row.balance - previous;
        if (Math.abs(moved) === Math.abs(row.amount)) row.amount = moved;
      }
      previous = row.balance ?? previous;
    }
  }
  const warnings: string[] = [];
  let inconsistent = false;
  let openingBalance: number | undefined;
  let closingBalance: number | undefined;
  let statedNet: number | undefined;
  if (recipe.accountKind === 'bank' && ordered.length > 0 && ordered.every((r) => r.balance !== undefined)) {
    openingBalance = ordered[0]!.balance! - ordered[0]!.amount;
    closingBalance = ordered.at(-1)!.balance!;
    statedNet = closingBalance - openingBalance;
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]!.balance! !== ordered[i - 1]!.balance! + ordered[i]!.amount) {
        warnings.push('The running balance does not follow from the amounts, so some rows may be missing or misread');
        inconsistent = true;
        break;
      }
    }
  } else warnings.push('This layout has no running balance to check against, so the totals could not be checked');

  const last4 = recipe.last4 ? compile(recipe.last4).exec(text)?.[1] : undefined;
  const period = recipe.period ? compile(recipe.period).exec(text) : null;
  const dates = ordered.map((r) => r.date).sort();
  return {
    adapterId,
    accountKind: recipe.accountKind,
    accountLast4: last4 && /^\d{4}$/.test(last4) ? last4 : undefined,
    periodStart: (period?.[1] && csvDate(period[1])) || dates[0],
    periodEnd: (period?.[2] && csvDate(period[2])) || dates.at(-1),
    openingBalance,
    closingBalance,
    statedNet,
    inconsistent,
    rows: ordered.map(({ text: _t, ...row }) => row),
    warnings,
    rowCount: ordered.length,
    unreadLines: unread,
    openingFound: opening !== undefined,
  };
}

export const learnedAdapter = (id: string, recipe: Recipe): StatementAdapter => ({
  id,
  label: `${recipe.bank} statement (learned)`,
  bank: recipe.bank,
  detect: (text) => (recipe.detect.every((word) => text.toLowerCase().includes(word.toLowerCase())) ? 0.9 : 0),
  parse: (text) => parseWithRecipe(recipe, text, id),
});

// ---- Kept per ledger -----------------------------------------------------------

const KEY = 'imports.learned';
export type LearnedRecipe = { id: string; recipe: Recipe; learnedAt: string };

export function listLearned(db: Db): LearnedRecipe[] {
  try {
    const found = JSON.parse(getSetting(db, KEY) ?? '[]') as LearnedRecipe[];
    return found.filter((f) => recipeSchema.safeParse(f.recipe).success);
  } catch {
    return [];
  }
}

export const learnedAdapters = (db: Db): StatementAdapter[] => listLearned(db).map((l) => learnedAdapter(l.id, l.recipe));

export function saveLearned(db: Db, recipe: Recipe): LearnedRecipe {
  const all = listLearned(db);
  const id = `learned-${recipe.bank.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${recipe.accountKind === 'bank' ? 'acct' : 'card'}`;
  const entry = { id, recipe, learnedAt: new Date().toISOString() };
  setSetting(db, KEY, JSON.stringify([...all.filter((a) => a.id !== id), entry]));
  return entry;
}

export function forgetLearned(db: Db, id: string) {
  setSetting(db, KEY, JSON.stringify(listLearned(db).filter((a) => a.id !== id)));
}
