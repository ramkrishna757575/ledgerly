// Checks how investment statements are read, without importing anything.
//   node apps/server/src/scripts/check-investments.ts <file.pdf> [more.pdf]
// Prints counts and pass or fail checks only, so the output is safe to share.
import { detectInvestmentAdapter, extractPdfText, valueOf, type ParsedInvestmentStatement } from '@ledgerly/core';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: check-investments.ts <file.pdf> [more.pdf]');
  process.exit(1);
}
const yes = (ok: boolean) => (ok ? 'yes' : 'NO');
const parsedFiles: ParsedInvestmentStatement[] = [];

for (const file of files) {
  const text = await extractPdfText(file);
  const adapter = detectInvestmentAdapter(text);
  if (!adapter) {
    console.log('no adapter recognised this statement');
    continue;
  }
  const parsed = adapter.parse(text);
  parsedFiles.push(parsed);
  const { holdings, blocks } = parsed;
  const total = holdings.reduce((sum, h) => sum + h.value, 0);

  console.log(`\n== ${adapter.id}  as on ${parsed.asOf}`);
  console.log(`holdings:            ${holdings.length}`);
  console.log(`warnings:            ${parsed.warnings.length}${parsed.warnings.length ? '  ' + parsed.warnings.map((w) => w.replace(/^.*?: /, '')).join(' | ') : ''}`);
  console.log(`total reconciles:    ${parsed.statedTotal === undefined ? 'no total to compare' : yes(Math.abs(total - parsed.statedTotal) <= Math.max(5000, parsed.statedTotal * 0.001))} (off by Rs ${parsed.statedTotal === undefined ? 0 : Math.abs(total - parsed.statedTotal) / 100})`);
  console.log(`names found:         ${holdings.filter((h) => h.name.length > 8).length}/${holdings.length}`);
  console.log(`folios found:        ${holdings.filter((h) => h.folio).length}/${holdings.length}`);
  console.log(`value = units x NAV: ${holdings.filter((h) => Math.abs(valueOf(h.units, h.nav) - h.value) <= Math.max(200, h.value * 0.02)).length}/${holdings.length}`);
  console.log(`cost recorded:       ${holdings.filter((h) => h.invested !== undefined).length}/${holdings.length}`);
  console.log(`classes:             ${['equity', 'debt', 'hybrid', 'gold', 'other'].map((c) => `${c}=${holdings.filter((h) => h.assetClass === c).length}`).join(' ')}`);
  if (adapter.source === 'cdsl') {
    console.log(`ISINs:               ${holdings.filter((h) => /^IN[A-Z0-9]{10}$/.test(h.isin ?? '')).length}/${holdings.length}`);
    console.log(`scheme codes:        ${holdings.filter((h) => h.schemeCode).length}/${holdings.length}`);
  } else {
    console.log(`returns (XIRR):      ${holdings.filter((h) => h.xirrBps !== undefined).length}/${holdings.length}`);
  }
  const rows = blocks.flatMap((b) => b.rows);
  console.log(`transaction blocks:  ${blocks.length}, with ${rows.length} transactions (${[...new Set(rows.map((r) => r.kind))].join(', ') || 'none'})`);
  const closes = blocks.filter((b) => b.openingUnits !== undefined && b.closingUnits !== undefined);
  console.log(`units carry through: ${closes.filter((b) => b.openingUnits! + b.rows.reduce((s, r) => s + r.units, 0) === b.closingUnits).length}/${closes.length}`);
  const linked = blocks.filter((b) => b.schemeCode && holdings.some((h) => h.schemeCode?.toLowerCase() === b.schemeCode!.toLowerCase() && h.units === b.closingUnits));
  console.log(`blocks match holdings: ${linked.length}/${blocks.length}`);
}

if (parsedFiles.length === 2) {
  const [a, b] = parsedFiles as [ParsedInvestmentStatement, ParsedInvestmentStatement];
  // Scripbox sometimes leaves off the part of a folio after the slash.
  const norm = (folio?: string) => (folio ?? '').split('/')[0]!.replace(/\D/g, '');
  const matched = a.holdings.filter((h) => b.holdings.some((o) => norm(o.folio) && norm(o.folio) === norm(h.folio))).length;
  console.log(`\nfunds in both files, matched by folio: ${matched} of ${a.holdings.length} and ${b.holdings.length}`);
}
