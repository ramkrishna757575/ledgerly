import type { ParsedRow, StatementAdapter } from '../types.ts';

// What banks call each column in their CSV downloads.
const COLUMNS = {
  date: ['transaction date', 'txn date', 'tran date', 'trans date', 'date', 'posting date', 'value date'],
  description: ['transaction remarks', 'transaction details', 'narration', 'description', 'particulars', 'remarks', 'details', 'transaction description'],
  debit: ['withdrawal amt.', 'withdrawal amount', 'withdrawal amount (inr)', 'withdrawals', 'withdrawal', 'debit amount', 'debit', 'debits', 'dr', 'amount debited'],
  credit: ['deposit amt.', 'deposit amount', 'deposit amount (inr)', 'deposits', 'deposit', 'credit amount', 'credit', 'credits', 'cr', 'amount credited'],
  amount: ['transaction amount', 'amount', 'amount (inr)', 'txn amount'],
  type: ['dr/cr', 'cr/dr', 'debit/credit', 'transaction type', 'type'],
  balance: ['closing balance', 'running balance', 'balance (inr)', 'balance amount', 'balance'],
} as const;
type Field = keyof typeof COLUMNS;

function delimiterOf(line: string) {
  return ([',', '\t', ';', '|'] as const).map((d) => [d, line.split(d).length - 1] as const).sort((a, b) => b[1] - a[1])[0]![0];
}

function cells(line: string, delimiter: string) {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

const norm = (header: string) => header.toLowerCase().replace(/\s+/g, ' ').replace(/[*]/g, '').trim();

function mapHeaders(headers: string[]) {
  const map = new Map<Field, number>();
  const used = new Set<number>();
  for (const field of Object.keys(COLUMNS) as Field[]) {
    for (const synonym of COLUMNS[field]) {
      const index = headers.findIndex((h, i) => !used.has(i) && h === synonym);
      if (index >= 0) {
        map.set(field, index);
        used.add(index);
        break;
      }
    }
  }
  return map;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// 30/09/2026, 30-09-26, 30-Sep-2026, 2026-09-30 and "30 Sep 2026".
export function csvDate(text: string): string | undefined {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.\-\s]+(\d{1,2})[/.\-\s]+(\d{2,4})/.exec(t);
  if (m) {
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${year}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  }
  m = /^(\d{1,2})[\-\s/]+([A-Za-z]{3})[A-Za-z]*[\-\s/,]+(\d{2,4})/.exec(t);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
    if (month === 0) return undefined;
    const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${year}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  }
  return undefined;
}

function money(text: string) {
  const cleaned = text.replace(/[₹\s]/g, '').replace(/,/g, '');
  if (!cleaned || cleaned === '-') return 0;
  const negative = cleaned.startsWith('-') || /^\(.*\)$/.test(cleaned);
  const plain = cleaned.replace(/[()-]/g, '').replace(/(Dr|Cr)$/i, '');
  const rounded = Math.round(Number(plain) * 100);
  if (!Number.isFinite(rounded)) throw new Error('not a number');
  return negative ? -rounded : rounded;
}

function table(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const delimiter = delimiterOf(lines[i]!);
    const headers = cells(lines[i]!, delimiter).map(norm);
    if (headers.length < 3) continue;
    const map = mapHeaders(headers);
    const hasMoney = (map.has('debit') && map.has('credit')) || (map.has('amount') && (map.has('type') || map.has('balance')));
    if (map.has('date') && map.has('description') && hasMoney) return { map, rows: lines.slice(i + 1).map((l) => cells(l, delimiter)) };
  }
  return null;
}

export const csvBank: StatementAdapter = {
  id: 'csv-bank',
  label: 'Bank statement (CSV)',
  bank: 'Bank',
  detect(text) {
    if (text.startsWith('%PDF')) return 0;
    return table(text) ? 0.8 : 0;
  },
  parse(text) {
    const found = table(text);
    if (!found) throw new Error('No table with a date, description and amounts was found');
    const { map, rows: raw } = found;
    const at = (row: string[], field: Field) => (map.has(field) ? row[map.get(field)!] ?? '' : '');
    const warnings: string[] = [];
    let rows: ParsedRow[] = [];

    raw.forEach((row, index) => {
      const date = csvDate(at(row, 'date'));
      if (!date) return;
      const description = at(row, 'description').replace(/\s+/g, ' ').trim();
      if (!description) return;
      try {
        let amount: number;
        if (map.has('debit') && map.has('credit')) {
          const debit = Math.abs(money(at(row, 'debit')));
          const credit = Math.abs(money(at(row, 'credit')));
          amount = credit - debit;
        } else {
          const raw = money(at(row, 'amount'));
          const kind = `${at(row, 'type')} ${at(row, 'amount')}`.toLowerCase();
          amount = /\b(dr|debit|withdrawal)\b|dr$/i.test(kind) ? -Math.abs(raw) : /\b(cr|credit|deposit)\b|cr$/i.test(kind) ? Math.abs(raw) : raw;
        }
        if (amount === 0) return;
        const balanceText = at(row, 'balance');
        rows.push({ date, description, amount, balance: balanceText ? money(balanceText) : undefined });
      } catch {
        warnings.push(`Line ${index + 2} could not be read and was skipped`);
      }
    });
    if (rows.length === 0) throw new Error('No transactions were found');

    // Downloads are often newest first; the running balance only makes sense oldest first.
    if (rows.length > 1 && rows[0]!.date > rows.at(-1)!.date) rows = rows.reverse();

    const dates = rows.map((r) => r.date).sort();
    const first = rows[0]!;
    const last = rows.at(-1)!;
    let openingBalance: number | undefined;
    let closingBalance: number | undefined;
    let statedNet: number | undefined;
    let inconsistent = false;
    if (rows.every((r) => r.balance !== undefined)) {
      openingBalance = first.balance! - first.amount;
      closingBalance = last.balance!;
      statedNet = closingBalance - openingBalance;
      // A running balance that does not follow from the amounts means a row is missing or misread.
      for (let i = 1; i < rows.length; i++) {
        if (rows[i]!.balance! !== rows[i - 1]!.balance! + rows[i]!.amount) {
          warnings.push('The running balance does not follow from the amounts, so some rows may be missing');
          inconsistent = true;
          break;
        }
      }
    } else {
      warnings.push('This file has no running balance, so the totals could not be checked');
    }

    return {
      adapterId: this.id,
      accountKind: 'bank',
      periodStart: dates[0],
      periodEnd: dates.at(-1),
      openingBalance,
      closingBalance,
      statedNet,
      inconsistent,
      rows,
      warnings,
    };
  },
};
