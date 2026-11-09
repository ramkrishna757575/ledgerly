import { parseAmount } from '../../money.ts';
import { classifyFund, parseStatementDate, toBps, toMicro, valueOf } from '../numbers.ts';
import type { InvestmentAdapter, ParsedHolding } from '../types.ts';

const INT = String.raw`-?[\d,]+`;
const DECIMAL = String.raw`-?[\d,]+(?:\.\d+)?`;
// Holding share, value, invested, gain, XIRR, two more gain columns, then units and NAV.
const ROW = new RegExp(
  String.raw`^(?<name>.*?)\s*(?<share>\d+(?:\.\d+)?)\s*%\s+(?<value>${INT})\s+(?<invested>${INT})\s+(?<gain>${INT})\s+(?<xirr>\*?-?\d+(?:\.\d+)?\s*%)\s+(?<a>${INT})\s+(?<b>${INT})\s+(?<units>${DECIMAL})\s+(?<nav>${DECIMAL})\s*$`,
);
const SECTION = /Mutual Funds\s*>\s*(.+?)\s+\d+\s*-\s*\d+\s+of\s+\d+\s+funds/i;
const FOLIO = /^\s*(?<category>.*?)\s*•\s*(?<folio>\S+)\s*$/;
const TOTAL = /^\s*Total\s+\d+(?:\.\d+)?\s*%\s+(-?[\d,]+)/;

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
// The "(R)" or "(G)" that follows a fund's name is a plan marker, not part of it.
const tidyName = (text: string) => clean(text).replace(/\s*\([A-Za-z]\)\s*$/, '');

function assetClassOf(heading: string, name: string) {
  const text = heading.toLowerCase();
  if (/gold|silver|precious/.test(text)) return 'gold' as const;
  if (/hybrid|balanced/.test(text)) return 'hybrid' as const;
  if (/equity/.test(text)) return 'equity' as const;
  if (/debt/.test(text)) return 'debt' as const;
  return classifyFund(name);
}

export const scripbox: InvestmentAdapter = {
  id: 'scripbox-portfolio',
  source: 'scripbox',
  label: 'Scripbox portfolio report',

  detect(text) {
    return /Scripbox/i.test(text) && /Portfolio Summary/i.test(text) && />\s*Mutual Funds\s*>/i.test(text) ? 0.9 : 0;
  },

  parse(text) {
    const lines = text.split('\n');
    const warnings: string[] = [];

    const dateText = /As On\s+([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i.exec(text)?.[1];
    const asOf = dateText ? parseStatementDate(dateText) : undefined;
    if (!asOf) throw new Error('Could not find the date this report is as of');

    const holdings: ParsedHolding[] = [];
    let heading = '';
    let pending: string[] = [];
    let waiting: Omit<ParsedHolding, 'folio'> | undefined;
    let statedTotal = 0;

    for (const line of lines) {
      if (!line.trim()) continue;

      const section = SECTION.exec(line);
      if (section) {
        heading = section[1]!;
        pending = [];
        waiting = undefined;
        continue;
      }
      const total = TOTAL.exec(line);
      if (total) {
        statedTotal += parseAmount(total[1]!);
        pending = [];
        continue;
      }
      if (/Portfolio Summary as on|Holding %|^\s*Value\s+Invested|^\*/i.test(line)) continue;

      const row = ROW.exec(line);
      if (row?.groups) {
        const { name: tail, value, invested, xirr, units, nav } = row.groups as Record<string, string>;
        const name = tidyName([...pending, tail ?? ''].join(' '));
        pending = [];
        const unitsMicro = toMicro(units!);
        const navMicro = toMicro(nav!);
        const amount = parseAmount(value!);
        // Units are rounded to two places here, so allow for that.
        if (amount > 0 && Math.abs(valueOf(unitsMicro, navMicro) - amount) / amount > 0.02) {
          warnings.push(`${name}: units times NAV does not match the current value`);
        }
        waiting = {
          name,
          assetClass: assetClassOf(heading, name),
          units: unitsMicro,
          nav: navMicro,
          value: amount,
          invested: parseAmount(invested!),
          xirrBps: toBps(xirr!),
        };
        continue;
      }

      const folio = waiting ? FOLIO.exec(line) : null;
      if (folio?.groups && waiting) {
        holdings.push({ ...waiting, folio: folio.groups.folio });
        waiting = undefined;
        continue;
      }

      if (waiting) {
        // A row with no folio line after it still counts.
        holdings.push(waiting);
        waiting = undefined;
      }
      pending.push(line.trim());
    }
    if (waiting) holdings.push(waiting);

    const total = holdings.reduce((sum, holding) => sum + holding.value, 0);
    // Each fund is rounded to a whole rupee, so a few rupees either way is fine.
    if (statedTotal > 0 && Math.abs(total - statedTotal) > Math.max(5000, statedTotal * 0.001)) {
      warnings.push("The funds do not add up to the report's own totals");
    }

    return {
      adapterId: this.id,
      source: this.source,
      label: this.label,
      asOf,
      statedTotal: statedTotal > 0 ? statedTotal : undefined,
      holdings,
      blocks: [],
      warnings,
    };
  },
};
