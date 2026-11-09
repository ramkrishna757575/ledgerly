import { parseAmount } from '../../money.ts';
import { classifyFund, parseStatementDate, toMicro, valueOf } from '../numbers.ts';
import type { InvestmentAdapter, ParsedBlock, ParsedHolding, ParsedTransaction } from '../types.ts';
import type { InvestmentKind } from '@ledgerly/db';

const NUM = String.raw`\(?-?[\d,]*\.\d+\)?|\(?-?[\d,]+\)?`;
const DATE = String.raw`\d{2}-(?:\d{2}|[A-Za-z]{3})-\d{4}`;
const ISIN = /\b(IN[A-Z0-9]{10})\b/;
// The distributor's code ends the descriptive columns, and nine figures follow it.
const HOLDING_TAIL = new RegExp(
  String.raw`(?:^|\s)(?:ARN-\d+|[A-Z]{2,4}-\d{3,}|DIRECT|NA|N\.A\.?)\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s*$`,
);
const TXN_TAIL = new RegExp(String.raw`(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s*$`);
const ROW = new RegExp(String.raw`^\s*(${DATE})\s+(.*)$`);

const clean = (text: string) => text.replace(/­/g, '').replace(/\s+/g, ' ').trim();
const absolute = (micro: number) => Math.abs(micro);

function kindOf(text: string): InvestmentKind {
  const lower = text.toLowerCase();
  if (/switch.?out/.test(lower)) return 'switch_out';
  if (/switch.?in/.test(lower)) return 'switch_in';
  if (/redemption|redeem|withdrawal|payout/.test(lower)) return 'redemption';
  if (/dividend|idcw/.test(lower)) return 'dividend';
  if (/\bsip\b|systematic|instalment|installment/.test(lower)) return 'sip';
  if (/purchase|investment|subscription/.test(lower)) return 'purchase';
  return 'other';
}

function splitCode(text: string) {
  const match = /^([A-Z]{2,8}|[A-Za-z]*\d[A-Za-z0-9]*)\s*-\s*(.+)$/.exec(text);
  return match ? { schemeCode: match[1]!, name: match[2]!.trim() } : { schemeCode: undefined, name: text.trim() };
}

function parseHoldings(lines: string[], warnings: string[]): ParsedHolding[] {
  const title = lines.findIndex((line) => /MUTUAL FUND UNITS HELD AS ON/i.test(line));
  if (title < 0) return [];

  // The ISIN heading marks where the scheme-name column ends.
  const headerIndex = lines.findIndex((line, i) => i > title && /Scheme Name/.test(line) && /\bISIN\b/.test(line));
  const nameWidth = headerIndex >= 0 ? lines[headerIndex]!.indexOf('ISIN') : 28;
  let start = headerIndex + 1;
  for (let i = headerIndex + 1; i < Math.min(lines.length, headerIndex + 8); i += 1) {
    if (/(\bINR\)|Loss\(%\))\s*$/.test(lines[i]!)) start = i + 1;
  }

  const tuples: { line: number; figures: string[] }[] = [];
  const isins: { line: number; isin: string; folio?: string; folioColumn: number }[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    const tail = HOLDING_TAIL.exec(line);
    if (tail) tuples.push({ line: i, figures: tail.slice(1) });
    const hit = ISIN.exec(line);
    if (hit) {
      const after = line.slice(hit.index + hit[1]!.length).trim().split(/\s+/)[0];
      const isFolio = after !== undefined && after !== '' && !/^(ARN-|DIRECT|NA$|N\.A)/.test(after) && !/^[A-Z]{2,4}-\d/.test(after);
      isins.push({ line: i, isin: hit[1]!, folio: isFolio ? after : undefined, folioColumn: line.indexOf(after ?? '', hit.index) });
    }
  }
  if (tuples.length === 0) return parseWideHoldings(lines, start, warnings);
  if (tuples.length !== isins.length) {
    warnings.push(`Found ${tuples.length} holdings but ${isins.length} ISINs, so some may be misread`);
  }

  return tuples.slice(0, isins.length).map((tuple, index) => {
    const isin = isins[index]!;

    // A folio number can wrap onto the next line, such as 12345678/9 split after the slash.
    let folio = isin.folio;
    for (const offset of [1, 2]) {
      const next = lines[isin.line + offset];
      if (folio && next && /^\s*\d{1,3}$/.test(next) === false && /^\s*\d+(\/\d+)?\s*$/.test(next)) {
        const column = next.search(/\S/);
        if (Math.abs(column - isin.folioColumn) <= 8 && !folio.includes('/')) {
          folio += next.trim();
          break;
        }
      }
    }

    // The name wraps over several lines around the figures, so each holding owns
    // the lines up to halfway to its neighbours.
    const previous = tuples[index - 1]?.line ?? start - 1;
    const following = tuples[index + 1]?.line ?? tuple.line + 4;
    const from = tuples[index - 1] ? Math.floor((previous + tuple.line) / 2) + 1 : start;
    const to = tuples[index + 1] ? Math.floor((tuple.line + following) / 2) : tuple.line + 3;
    const pieces: string[] = [];
    for (let i = Math.max(from, start); i <= Math.min(to, lines.length - 1); i += 1) {
      if (i > tuple.line && !lines[i]!.trim()) break;
      const left = lines[i]!.slice(0, nameWidth).trim();
      if (left) pieces.push(left);
    }
    const { schemeCode, name } = splitCode(clean(pieces.join(' ')));

    const [unitsText, navText, first, second] = tuple.figures as [string, string, string, string];
    const units = toMicro(unitsText);
    const nav = toMicro(navText);
    // Cost and valuation come one after the other. Units times NAV tells them apart.
    const expected = valueOf(units, nav);
    const a = parseAmount(first.replace(/[()]/g, ''));
    const b = parseAmount(second.replace(/[()]/g, ''));
    const [value, invested] = Math.abs(a - expected) <= Math.abs(b - expected) ? [a, b] : [b, a];
    if (expected > 0 && Math.abs(value - expected) / expected > 0.01) {
      warnings.push(`${name || isin.isin}: units times NAV does not match the valuation`);
    }

    return {
      name,
      isin: isin.isin,
      folio,
      schemeCode,
      assetClass: classifyFund(name),
      units,
      nav,
      value,
      invested,
    };
  });
}

// The newer statement: no distributor column. Each row is the ISIN, the folio, then units, NAV, amount
// invested, valuation, profit and profit %. The scheme name wraps over the lines above and below the row,
// and where the ISIN sits changes from row to row, so a name starts at the line that begins with its
// scheme code ("151IG - Aditya Birla ...") and runs to the next one.
const WIDE_ROW = new RegExp(String.raw`\b(IN[A-Z0-9]{10})\s+(\S+)\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s+(${NUM})\s*$`);
const NAME_START = /^\s*[A-Z0-9]{2,6}\s+-\s+\S/;

function parseWideHoldings(lines: string[], start: number, warnings: string[]): ParsedHolding[] {
  const rows: { line: number; isinAt: number; isin: string; folio: string; figures: string[] }[] = [];
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*Grand Total/i.test(line)) {
      end = i;
      break;
    }
    const hit = WIDE_ROW.exec(line);
    if (hit) rows.push({ line: i, isinAt: hit.index, isin: hit[1]!, folio: hit[2]!, figures: hit.slice(3) });
  }

  // Where each name begins: the nearest name-start line at or above its row, below the previous row.
  const begins = rows.map((row, k) => {
    const floor = (rows[k - 1]?.line ?? start - 1) + 1;
    let at = row.line;
    while (at > floor && !NAME_START.test(lines[at]!)) at -= 1;
    return at;
  });

  return rows.map((row, k) => {
    const to = k + 1 < rows.length ? begins[k + 1]! - 1 : Math.min(end - 1, row.line + 6);
    const pieces: string[] = [];
    for (let i = begins[k]!; i <= to; i += 1) {
      const text = i === row.line ? lines[i]!.slice(0, row.isinAt) : lines[i]!;
      if (text.trim()) pieces.push(text.trim());
    }
    const { schemeCode, name } = splitCode(clean(pieces.join(' ')));

    const [unitsText, navText, first, second] = row.figures as [string, string, string, string];
    const units = toMicro(unitsText);
    const nav = toMicro(navText);
    // Amount invested and valuation come one after the other. Units times NAV tells them apart.
    const expected = valueOf(units, nav);
    const a = parseAmount(first.replace(/[()]/g, ''));
    const b = parseAmount(second.replace(/[()]/g, ''));
    const [value, invested] = Math.abs(a - expected) <= Math.abs(b - expected) ? [a, b] : [b, a];
    if (expected > 0 && Math.abs(value - expected) / expected > 0.01) {
      warnings.push(`${name || row.isin}: units times NAV does not match the valuation`);
    }
    return { name, isin: row.isin, folio: row.folio, schemeCode, assetClass: classifyFund(name), units, nav, value, invested };
  });
}

function parseBlocks(lines: string[], warnings: string[]): ParsedBlock[] {
  const begin = lines.findIndex((line) => /MUTUAL FUND UNITS HELD WITH/i.test(line));
  const end = lines.findIndex((line) => /MUTUAL FUND UNITS HELD AS ON/i.test(line));
  if (begin < 0) return [];

  const blocks: ParsedBlock[] = [];
  let block: ParsedBlock | undefined;
  let between: string[] = [];
  const text = new WeakMap<ParsedTransaction, string[]>();

  // Lines between two rows describe one or the other, so each gets half.
  const settle = (nextRowStarts: boolean) => {
    const last = block?.rows.at(-1);
    if (!last) {
      // The first row of a scheme owns everything above it.
      const leading = nextRowStarts ? between : [];
      between = [];
      return leading;
    }
    const give = nextRowStarts ? Math.floor(between.length / 2) : between.length;
    text.get(last)!.push(...between.slice(0, give));
    const keep = between.slice(give);
    between = [];
    return keep;
  };
  const finish = () => {
    for (const rows of blocks) for (const row of rows.rows) {
      row.description = clean(text.get(row)!.join(' '));
      row.kind = kindOf(row.description);
      if (row.kind === 'redemption' || row.kind === 'switch_out') row.units = -absolute(row.units);
      else row.units = absolute(row.units);
    }
  };

  for (let i = begin + 1; i < (end < 0 ? lines.length : end); i += 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;

    const opening = /Opening Balance\s+(\S+)/i.exec(line);
    const closing = /Closing Balance\s+(\S+)/i.exec(line);
    const row = ROW.exec(line);
    // A scheme code has a digit or is all capitals, which keeps a wrapped "Plan - Growth" from counting.
    const scheme = /^\s*([A-Z]{2,8}|[A-Za-z]*\d[A-Za-z0-9]*)\s+-\s+(.{6,})$/.exec(line);

    if (opening && block) {
      block.openingUnits = toMicro(opening[1]!);
    } else if (closing && block) {
      settle(false);
      block.closingUnits = toMicro(closing[1]!);
    } else if (row) {
      const tail = TXN_TAIL.exec(line);
      const date = parseStatementDate(row[1]!);
      if (!tail || !date || !block) {
        if (tail === null || !date) warnings.push(`Could not read a transaction line dated ${row[1]}`);
        continue;
      }
      const leading = settle(true);
      const middle = line.slice(line.indexOf(row[1]!) + row[1]!.length, tail.index).trim();
      const parsed: ParsedTransaction = {
        date,
        kind: 'other',
        amount: absolute(toMicro(tail[1]!)) / 10_000,
        nav: absolute(toMicro(tail[2]!)),
        units: toMicro(tail[4]!),
        description: '',
      };
      text.set(parsed, [...leading, middle]);
      block.rows.push(parsed);
    } else if (scheme) {
      settle(false);
      block = { schemeCode: scheme[1]!, name: scheme[2]!.trim(), rows: [] };
      blocks.push(block);
    } else if (!/Mutual Fund\s*$/i.test(line) && !/^\s*ISIN\s*:/.test(line) && !/^\s*(Date|Duty|\(`\)|\(₹\))/.test(line) && !/Transaction Description/.test(line)) {
      between.push(line.trim());
    }
  }
  settle(false);
  finish();
  return blocks.filter((b) => b.rows.length > 0 || b.openingUnits !== undefined);
}

export const cdsl: InvestmentAdapter = {
  id: 'cas-cdsl',
  source: 'cdsl',
  label: 'Consolidated account statement (CDSL)',

  detect(text) {
    return /CONSOLIDATED ACCOUNT STATEMENT/i.test(text) && /MUTUAL FUND UNITS HELD AS ON/i.test(text) ? 0.9 : 0;
  },

  parse(text) {
    const lines = text.replace(/­/g, '').split('\n');
    const warnings: string[] = [];

    const holdTitle = lines.find((line) => /MUTUAL FUND UNITS HELD AS ON/i.test(line));
    const asOfText = /AS ON\s+(\S+)/i.exec(holdTitle ?? '')?.[1];
    const asOf = asOfText ? parseStatementDate(asOfText) : undefined;
    if (!asOf) throw new Error('Could not find the date this statement is as of');

    const period = /PERIOD FROM\s+(\S+)/i.exec(text)?.[1];
    const summary = lines.find((line) => /Mutual Fund Folios/i.test(line));
    const figures = summary ? [...summary.matchAll(/(\d[\d,]*\.\d{2})/g)].map((m) => m[1]!) : [];
    const statedTotal = figures.length > 0 ? parseAmount(figures.at(-1)!) : undefined;

    const holdings = parseHoldings(lines, warnings);
    const blocks = parseBlocks(lines, warnings);

    const total = holdings.reduce((sum, holding) => sum + holding.value, 0);
    if (statedTotal !== undefined && Math.abs(total - statedTotal) > 100) {
      warnings.push("The holdings do not add up to the statement's own mutual fund total");
    }

    return {
      adapterId: this.id,
      source: this.source,
      label: this.label,
      asOf,
      periodStart: period ? parseStatementDate(period) : undefined,
      statedTotal,
      holdings,
      blocks,
      warnings,
    };
  },
};
