import type { AssetClass } from '@ledgerly/db';
import { classifyFund, toMicro, valueOf, MILLION } from '../numbers.ts';
import type { InvestmentAdapter, ParsedHolding } from '../types.ts';

// What brokers and apps call each column. The first header that matches wins.
const COLUMNS = {
  name: ['scheme name', 'fund name', 'name', 'instrument', 'scheme', 'fund', 'symbol', 'stock', 'company', 'security'],
  isin: ['isin'],
  units: ['units', 'balance units', 'qty', 'qty.', 'quantity', 'shares', 'closing units'],
  nav: ['nav', 'current nav', 'ltp', 'last price', 'price', 'current price', 'close price', 'cmp'],
  value: ['current value', 'cur. val', 'cur val', 'market value', 'present value', 'value', 'valuation', 'current amount'],
  invested: ['invested', 'invested amount', 'invested value', 'amount invested', 'total cost', 'cost value', 'buy value', 'purchase value', 'cost'],
  average: ['avg. cost', 'avg cost', 'average cost', 'avg. price', 'avg price', 'average price', 'buy avg', 'avg buy price'],
  folio: ['folio', 'folio no', 'folio no.', 'folio number'],
  assetClass: ['asset class', 'asset type', 'category', 'type'],
} as const;
type Field = keyof typeof COLUMNS;

function delimiterOf(line: string) {
  const counts = [',', '\t', ';'].map((d) => [d, line.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

// Splits one line, honouring quotes so "Fund, Direct - Growth" stays whole.
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

const norm = (header: string) => header.toLowerCase().replace(/[()₹`*]/g, '').replace(/\s+/g, ' ').replace(/\s*in\s*(inr|rs\.?)\s*$/, '').trim();

function mapHeaders(headers: string[]) {
  const found = new Map<Field, number>();
  const used = new Set<number>();
  for (const field of Object.keys(COLUMNS) as Field[]) {
    for (const synonym of COLUMNS[field]) {
      const index = headers.findIndex((h, i) => !used.has(i) && h === synonym);
      if (index >= 0) {
        found.set(field, index);
        used.add(index);
        break;
      }
    }
  }
  return found;
}

// A name that does not look like a fund or a gold/debt product is taken to be a
// company's share, which is equity.
const stockOr = (guess: AssetClass, name: string): AssetClass => (guess === 'other' && !/fund|scheme|plan|etf|bees|fof|trust/i.test(name) ? 'equity' : guess);

const paise = (text: string) => Math.round(toMicro(text) / (MILLION / 100));

function firstTable(text: string) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const delimiter = delimiterOf(lines[i]!);
    const headers = cells(lines[i]!, delimiter).map(norm);
    if (headers.length < 3) continue;
    const map = mapHeaders(headers);
    if (map.has('name') && (map.has('units') || map.has('value'))) return { map, rows: lines.slice(i + 1).map((l) => cells(l, delimiter)) };
  }
  return null;
}

export const csv: InvestmentAdapter = {
  id: 'csv-holdings',
  source: 'csv',
  label: 'Holdings export (CSV)',
  detect(text) {
    if (text.startsWith('%PDF')) return 0;
    return firstTable(text) ? 0.9 : 0;
  },
  parse(text) {
    const table = firstTable(text);
    if (!table) throw new Error('No table of holdings with a name and units or value was found');
    const { map, rows } = table;
    const warnings: string[] = [];
    const holdings: ParsedHolding[] = [];
    const at = (row: string[], field: Field) => (map.has(field) ? row[map.get(field)!] ?? '' : '');

    rows.forEach((row, index) => {
      const name = at(row, 'name').trim();
      if (!name || /^total\b|^grand total/i.test(name)) return;
      try {
        const unitsText = at(row, 'units');
        const units = unitsText ? toMicro(unitsText) : 0;
        const navText = at(row, 'nav');
        let nav = navText ? toMicro(navText) : 0;
        let value = at(row, 'value') ? paise(at(row, 'value')) : 0;
        if (!value && units > 0 && nav > 0) value = valueOf(units, nav);
        if (!nav && units > 0 && value > 0) nav = Math.round((value * 10_000 * MILLION) / 100 / units);
        if (units <= 0 || value <= 0) {
          warnings.push(`Row ${index + 2} was skipped: no units or value`);
          return;
        }
        let invested = at(row, 'invested') ? paise(at(row, 'invested')) : undefined;
        if (invested === undefined && at(row, 'average')) invested = valueOf(units, toMicro(at(row, 'average')));
        const isin = at(row, 'isin').trim().toUpperCase();
        const given = at(row, 'assetClass').toLowerCase();
        const assetClass: AssetClass =
          (['equity', 'debt', 'hybrid', 'gold'] as const).find((c) => given.includes(c)) ??
          // INE… is a company's share; INF… is a fund.
          (isin.startsWith('INE') ? 'equity' : stockOr(classifyFund(name), name));
        holdings.push({
          name: name.slice(0, 200),
          isin: /^IN[A-Z0-9]{10}$/.test(isin) ? isin : undefined,
          folio: at(row, 'folio') || undefined,
          assetClass,
          units,
          nav,
          value,
          invested: invested && invested > 0 ? invested : undefined,
        });
      } catch {
        warnings.push(`Row ${index + 2} could not be read and was skipped`);
      }
    });

    if (holdings.length === 0) throw new Error('No holdings with units and a value were found');
    warnings.push('A holdings export has no date, so today is used as the valuation date.');
    return { adapterId: this.id, source: this.source, label: this.label, asOf: new Date().toISOString().slice(0, 10), holdings, blocks: [], warnings };
  },
};
