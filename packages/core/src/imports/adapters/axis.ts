import type { ParsedRow, ParsedStatement, StatementAdapter } from '../types.ts';
import { AMOUNT, collapse, dmyToIso, indentOf, lastFourDigits, toMinor } from '../text.ts';

const PERIOD = /period\s+from\s*:?\s*(\d{2}-\d{2}-\d{4})\s+to\s*:?\s*(\d{2}-\d{2}-\d{4})/i;

// Both Axis account layouts print a running balance, so each row's direction
// is proven by the balance moving by exactly its amount.
function directionFromBalance(previous: number | undefined, balance: number, amount: number) {
  if (previous === undefined) return undefined;
  if (balance - previous === amount) return 1;
  if (balance - previous === -amount) return -1;
  return undefined;
}

// Used only when the balance cannot tell, such as the first row of a statement
// with no opening balance: the amount sits under the debit or the credit heading.
function directionFromColumns(
  line: string,
  amountText: string,
  header: string,
  outWord: string,
  inWord: string,
) {
  const end = line.indexOf(amountText, 10) + amountText.length;
  const headerLower = header.toLowerCase();
  const outEnd = headerLower.indexOf(outWord) + outWord.length;
  const inEnd = headerLower.indexOf(inWord) + inWord.length;
  return Math.abs(end - outEnd) <= Math.abs(end - inEnd) ? -1 : 1;
}

function finish(
  base: Pick<ParsedStatement, 'adapterId' | 'accountLast4' | 'periodStart' | 'periodEnd'>,
  rows: ParsedRow[],
  opening: number | undefined,
  closing: number | undefined,
  warnings: string[],
): ParsedStatement {
  const closingBalance = closing ?? rows.at(-1)?.balance;
  return {
    ...base,
    accountKind: 'bank',
    openingBalance: opening,
    closingBalance,
    statedNet:
      opening !== undefined && closingBalance !== undefined ? closingBalance - opening : undefined,
    rows,
    warnings,
  };
}

function periodOf(text: string) {
  const match = PERIOD.exec(text);
  return {
    periodStart: match ? dmyToIso(match[1]!) : undefined,
    periodEnd: match ? dmyToIso(match[2]!) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Consolidated statement: the date starts the row and narration continues below.
//   Date  Transaction Details  Chq No.  Withdrawal  Deposits  Balance
// ---------------------------------------------------------------------------

const CONSOLIDATED_HEADER = /Transaction Details\s+Chq\s+(?:No\.?\s+)?Withdrawal\s+Deposits?/i;
const CONSOLIDATED_ROW = new RegExp(
  String.raw`^\s*(\d{2}-\d{2}-\d{4})\s+(.*?)\s+(${AMOUNT})\s+(${AMOUNT})\s*(Cr|Dr)?\.?\s*$`,
);
const CONSOLIDATED_STOP = /^\s*(Total\b|Closing Balance|\*{3,}|\+{3,}|Legends)/i;

export const axisConsolidated: StatementAdapter = {
  id: 'axis-savings-consolidated',
  label: 'Axis Bank consolidated statement',
  bank: 'Axis Bank',

  detect(text) {
    return CONSOLIDATED_HEADER.test(text) && /Statement for Account No/i.test(text) ? 0.9 : 0;
  },

  parse(text) {
    const lines = text.split('\n');
    const warnings: string[] = [];
    const headerIndex = lines.findIndex((line) => CONSOLIDATED_HEADER.test(line));
    const header = lines[headerIndex] ?? '';
    const account = /Statement for Account No\.?\s*(\S+)/i.exec(text)?.[1];

    const rows: ParsedRow[] = [];
    let opening: number | undefined;
    let previous: number | undefined;
    let extraLines = 0;

    for (const line of lines.slice(headerIndex + 1)) {
      if (!line.trim()) continue;
      if (CONSOLIDATED_STOP.test(line)) break;
      if (CONSOLIDATED_HEADER.test(line) || /^\s*No\.\s*$/.test(line)) continue;

      const openingMatch = new RegExp(String.raw`^\s*Opening Balance\s+(${AMOUNT})`, 'i').exec(line);
      if (openingMatch) {
        opening = previous = toMinor(openingMatch[1]!);
        continue;
      }

      const row = CONSOLIDATED_ROW.exec(line);
      const date = row ? dmyToIso(row[1]!) : undefined;
      if (row && date) {
        const amount = toMinor(row[3]!);
        const balance = toMinor(row[4]!) * (row[5] === 'Dr' ? -1 : 1);
        const direction =
          directionFromBalance(previous, balance, amount) ??
          directionFromColumns(line, row[3]!, header, 'withdrawal', 'deposits');
        if (previous !== undefined && directionFromBalance(previous, balance, amount) === undefined) {
          warnings.push(`Row on ${date} does not match the running balance`);
        }
        rows.push({ date, description: collapse(row[2]!), amount: amount * direction, balance });
        previous = balance;
        extraLines = 0;
        continue;
      }

      const last = rows.at(-1);
      if (last && indentOf(line) >= 5 && indentOf(line) <= 40 && extraLines < 3) {
        last.description = collapse(`${last.description} ${line}`);
        extraLines += 1;
      }
    }

    return finish(
      { adapterId: this.id, accountLast4: lastFourDigits(account), ...periodOf(text) },
      rows,
      opening,
      undefined,
      warnings,
    );
  },
};

// ---------------------------------------------------------------------------
// Account statement: narration starts above the date line, which carries the
// last part of it.
//   Tran Date  Chq No  Particulars  Debit  Credit  Balance  Init. Br
// ---------------------------------------------------------------------------

const STATEMENT_HEADER = /Tran Date\s+Chq No\s+Particulars\s+Debit\s+Credit\s+Balance/i;
const STATEMENT_ROW = new RegExp(
  String.raw`^\s*(\d{2}-\d{2}-\d{4})\s+(?:(.*?)\s+)?(${AMOUNT})\s+(${AMOUNT})(?:\s+(\d{1,5}))?\s*$`,
);
const STATEMENT_FURNITURE =
  /Init\.?\s*$|^\s*Br\s*$|Statement of Account No|Customer ID|IFSC Code|MICR Code|Nominee|Mobile No|Email ID|PAN\s*:|Joint Holder|Scheme\s*:/i;

export const axisStatement: StatementAdapter = {
  id: 'axis-savings-statement',
  label: 'Axis Bank account statement',
  bank: 'Axis Bank',

  detect(text) {
    return STATEMENT_HEADER.test(text) ? 0.9 : 0;
  },

  parse(text) {
    const lines = text.split('\n');
    const warnings: string[] = [];
    const headerIndex = lines.findIndex((line) => STATEMENT_HEADER.test(line));
    const header = lines[headerIndex] ?? '';
    const account = /Statement of Account No\s*:?\s*(\S+)/i.exec(text)?.[1];
    const period = /for the period\s*\(\s*From\s*:\s*(\d{2}-\d{2}-\d{4})\s+To\s*:\s*(\d{2}-\d{2}-\d{4})/i.exec(
      text,
    );

    const rows: ParsedRow[] = [];
    let opening: number | undefined;
    let closing: number | undefined;
    let previous: number | undefined;
    let pending: string[] = [];

    for (const line of lines.slice(headerIndex + 1)) {
      if (!line.trim()) continue;
      if (/^\s*TRANSACTION TOTAL/i.test(line)) continue;
      const closingMatch = new RegExp(String.raw`^\s*CLOSING BALANCE\s+(${AMOUNT})`, 'i').exec(line);
      if (closingMatch) {
        closing = toMinor(closingMatch[1]!);
        break;
      }
      if (STATEMENT_HEADER.test(line)) {
        pending = [];
        continue;
      }
      if (STATEMENT_FURNITURE.test(line)) continue;

      const openingMatch = new RegExp(String.raw`^\s*OPENING BALANCE\s+(${AMOUNT})`, 'i').exec(line);
      if (openingMatch) {
        opening = previous = toMinor(openingMatch[1]!);
        pending = [];
        continue;
      }

      const row = STATEMENT_ROW.exec(line);
      const date = row ? dmyToIso(row[1]!) : undefined;
      if (row && date) {
        const amount = toMinor(row[3]!);
        const balance = toMinor(row[4]!);
        const byBalance = directionFromBalance(previous, balance, amount);
        const direction =
          byBalance ?? directionFromColumns(line, row[3]!, header, 'debit', 'credit');
        if (previous !== undefined && byBalance === undefined) {
          warnings.push(`Row on ${date} does not match the running balance`);
        }
        rows.push({
          date,
          description: collapse([...pending, row[2] ?? ''].join(' ')),
          amount: amount * direction,
          balance,
        });
        previous = balance;
        pending = [];
        continue;
      }

      pending.push(line.trim());
    }

    return finish(
      {
        adapterId: this.id,
        accountLast4: lastFourDigits(account),
        periodStart: period ? dmyToIso(period[1]!) : undefined,
        periodEnd: period ? dmyToIso(period[2]!) : undefined,
      },
      rows,
      opening,
      closing,
      warnings,
    );
  },
};

// ---------------------------------------------------------------------------
// Credit card statement: DD/MM/YYYY, details, then the amount with Dr or Cr.
// ---------------------------------------------------------------------------

const CARD_ROW = new RegExp(String.raw`^\s*(\d{2}/\d{2}/\d{4})\s+(.+?)\s+(${AMOUNT})\s*(Dr|Cr)\s*$`);
const CARD_SUMMARY = new RegExp(
  String.raw`(${AMOUNT})\s*(Dr|Cr)?\s+(${AMOUNT})\s+(${AMOUNT})\s+(${AMOUNT})\s+(${AMOUNT})\s+(${AMOUNT})\s+(${AMOUNT})\s*(Dr|Cr)?`,
);

export const axisCreditCard: StatementAdapter = {
  id: 'axis-credit-card',
  label: 'Axis Bank credit card statement',
  bank: 'Axis Bank',

  detect(text) {
    return /Credit Card Statement/i.test(text) && /TRANSACTION DETAILS/i.test(text) ? 0.9 : 0;
  },

  parse(text) {
    const lines = text.split('\n');
    const warnings: string[] = [];
    const rows: ParsedRow[] = [];

    for (const line of lines) {
      if (/End of Statement/i.test(line)) break;
      const match = CARD_ROW.exec(line);
      const date = match ? dmyToIso(match[1]!) : undefined;
      if (!match || !date) continue;

      // The merchant category sits in its own column after a wide gap.
      // A foreign amount in brackets is kept, since it explains the charge.
      const parts = match[2]!.split(/\s{3,}/);
      const description = collapse(
        parts.filter((part, index) => index === 0 || /^\(.*\)$/.test(part.trim())).join(' '),
      );
      const amount = toMinor(match[3]!);
      rows.push({ date, description, amount: match[4] === 'Dr' ? -amount : amount });
    }

    const period = /(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/.exec(text);
    const last4 = /\d{6}\*{6}(\d{4})/.exec(text)?.[1];

    // The line that carries the statement period also carries the amounts due
    // before it and the payment due date after it.
    const periodLine = lines.find((line) => /\d{2}\/\d{2}\/\d{4}\s*-\s*\d{2}\/\d{2}\/\d{4}/.test(line));
    const dates = periodLine?.match(/\d{2}\/\d{2}\/\d{4}/g) ?? [];
    const dueDate = dates.length >= 3 ? dmyToIso(dates[2]!) : undefined;
    const amounts = periodLine?.match(/\d[\d,]*\.\d{2}/g) ?? [];
    const minimumDue = amounts.length >= 2 ? toMinor(amounts[1]!) : undefined;

    // Previous balance - payments - credits + purchases + cash + charges = total due.
    const summary = lines.map((line) => CARD_SUMMARY.exec(line)).find(Boolean);
    let openingBalance: number | undefined;
    let closingBalance: number | undefined;
    let statedNet: number | undefined;
    if (summary) {
      const owed = (value: string, side: string | undefined) =>
        toMinor(value) * (side === 'Cr' ? -1 : 1);
      openingBalance = owed(summary[1]!, summary[2]);
      closingBalance = owed(summary[8]!, summary[9]);
      statedNet = -(closingBalance - openingBalance);
    } else {
      warnings.push('Could not read the statement summary, so totals were not checked');
    }

    return {
      adapterId: this.id,
      accountKind: 'credit_card',
      accountLast4: last4,
      periodStart: period ? dmyToIso(period[1]!) : undefined,
      periodEnd: period ? dmyToIso(period[2]!) : undefined,
      openingBalance,
      closingBalance,
      dueDate,
      minimumDue,
      statedNet,
      rows,
      warnings,
    };
  },
};
