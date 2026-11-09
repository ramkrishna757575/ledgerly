// Checks how a statement PDF is read, without importing anything.
//   node apps/server/src/scripts/check-statement.ts <file.pdf> [--show]
// By default only counts, totals and masked text are printed, so the output is
// safe to paste. Add --show to see the real transactions.
import { detectAdapter, extractPdfText, formatAmount, parseNarration } from '@ledgerly/core';

const [path, flag] = process.argv.slice(2);
if (!path) {
  console.error('Usage: check-statement.ts <file.pdf> [--show]');
  process.exit(1);
}
const show = flag === '--show';

const KEEP = new Set(
  'upi neft imps rtgs ach dr cr atm pos payment ref int pd gst fee fees charges bank limited ltd to from p2a p2m'.split(' '),
);
const mask = (text: string) =>
  text
    .replace(/\d/g, '9')
    .replace(/[A-Za-z]+/g, (word) => (KEEP.has(word.toLowerCase()) ? word : 'x'.repeat(word.length)));

const text = await extractPdfText(path);
const adapter = detectAdapter(text);
if (!adapter) {
  console.log('No adapter recognised this statement.');
  process.exit(2);
}

const parsed = adapter.parse(text);
const sum = parsed.rows.reduce((total, row) => total + row.amount, 0);
const incoming = parsed.rows.filter((row) => row.amount > 0).length;

console.log(`adapter:        ${adapter.id}`);
console.log(`kind:           ${parsed.accountKind}`);
console.log(`account digits: ${parsed.accountLast4 ? 'found' : 'not found'}`);
console.log(`period:         ${parsed.periodStart ?? '?'} to ${parsed.periodEnd ?? '?'}`);
console.log(`rows:           ${parsed.rows.length} (${incoming} in, ${parsed.rows.length - incoming} out)`);
console.log(`rows total:     ${formatAmount(sum)}`);
console.log(
  `statement says: ${parsed.statedNet === undefined ? 'nothing to compare' : formatAmount(parsed.statedNet)}`,
);
console.log(
  `reconciles:     ${parsed.statedNet === undefined ? 'unchecked' : parsed.statedNet === sum ? 'YES' : 'NO'}`,
);
console.log(`warnings:       ${parsed.warnings.length}`);

const channels = new Map<string, number>();
const unread: string[] = [];
for (const row of parsed.rows) {
  const { channel, payee } = parseNarration(row.description);
  channels.set(channel, (channels.get(channel) ?? 0) + 1);
  if (channel === 'other' || ((channel === 'upi' || channel === 'neft') && !payee)) {
    unread.push(`${channel}: ${row.description}`);
  }
}
console.log(`channels:       ${[...channels].map(([name, count]) => `${name}=${count}`).join(' ')}`);
console.log(`unrecognised:   ${unread.length}`);
for (const line of unread.slice(0, 12)) console.log(`   ${show ? line : mask(line)}`);

const longest = parsed.rows.reduce((max, row) => Math.max(max, row.description.length), 0);
console.log(`longest narration: ${longest} characters`);

if (show) {
  for (const row of parsed.rows) {
    console.log(`${row.date}  ${formatAmount(row.amount).padStart(14)}  ${row.description}`);
  }
}
