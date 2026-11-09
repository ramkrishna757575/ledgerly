import type { Db } from '@ledgerly/db';
import { listTransactions } from './transactions.ts';

const HEADER = ['Date', 'Description', 'Payee', 'Account', 'Account type', 'Amount (INR)', 'Tags'];

// A spreadsheet runs a cell that starts with these as a formula, and bank
// narrations are text from outside, so they are defused with a leading quote.
function cell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function rupees(paise: number) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// One row per ledger line, so a transfer shows both sides and every row sums
// back to the books. Amounts are plain numbers so a spreadsheet can total them.
export function exportTransactionsCsv(db: Db, range: { from?: string; to?: string } = {}) {
  const lines = [HEADER.join(',')];
  for (let offset = 0; ; offset += 200) {
    const { items } = listTransactions(db, { ...range, limit: 200, offset });
    if (items.length === 0) break;
    for (const t of items) {
      for (const p of t.postings) {
        lines.push(
          [
            t.date,
            cell(t.description),
            cell(t.payee ?? ''),
            cell(p.accountName),
            p.accountType,
            rupees(p.amount),
            cell(t.tags.join(' ')),
          ].join(','),
        );
      }
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}
