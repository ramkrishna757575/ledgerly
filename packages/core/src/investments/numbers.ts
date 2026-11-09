// Units and prices are kept as integers in millionths, so sums never drift.
export const MILLION = 1_000_000;

// "1,234.567" -> 1234567000. Accepts a leading minus or brackets for a negative.
export function toMicro(text: string): number {
  const trimmed = text.replace(/[\u00AD\s,₹`]/g, '');
  const negative = trimmed.startsWith('-') || (trimmed.startsWith('(') && trimmed.endsWith(')'));
  const cleaned = trimmed.replace(/[()-]/g, '');
  if (!/^\d*\.?\d+$|^\d+\.?$/.test(cleaned)) throw new Error(`Invalid number: ${text}`);
  const [whole = '0', fraction = ''] = cleaned.split('.');
  if (fraction.length > 6) throw new Error(`Too many decimals: ${text}`);
  const micro = Number(whole || '0') * MILLION + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(micro)) throw new Error(`Number out of range: ${text}`);
  return negative && micro !== 0 ? -micro : micro;
}

// Units times price, in paise, rounded. Done in big integers, since the product
// of two millionths can be larger than a plain number holds exactly.
export function valueOf(unitsMicro: number, navMicro: number) {
  const product = BigInt(unitsMicro) * BigInt(navMicro);
  const divisor = BigInt(MILLION) * 10_000n;
  const half = product < 0n ? -divisor / 2n : divisor / 2n;
  return Number((product + half) / divisor);
}

// A percentage such as "12.34 %" as basis points (1234).
export function toBps(text: string): number {
  return Math.round(Number(text.replace(/[*%,\s]/g, '')) * 100);
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// 30-09-2026, 30-Sep-2026 and Sep 30, 2026, which is what these statements use.
export function parseStatementDate(text: string): string | undefined {
  const trimmed = text.trim();
  let year: string | undefined;
  let month: string | undefined;
  let day: string | undefined;

  let match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(trimmed);
  if (match) [, day, month, year] = match;
  if (!match && (match = /^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ,]+(\d{4})$/.exec(trimmed))) {
    [, day, , year] = match;
    month = MONTHS[match[2]!.toLowerCase()];
  }
  if (!match && (match = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(trimmed))) {
    [, , day, year] = match;
    month = MONTHS[match[1]!.toLowerCase()];
  }
  if (!day || !month || !year) return undefined;

  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? undefined : iso;
}

// Equity, debt or hybrid, guessed from a scheme's name when the statement does not say.
export function classifyFund(name: string): 'equity' | 'debt' | 'hybrid' | 'gold' | 'other' {
  const text = name.toLowerCase();
  if (/gold|silver|precious/.test(text)) return 'gold';
  if (/hybrid|balanced|arbitrage|asset allocation|multi asset|equity savings/.test(text)) return 'hybrid';
  if (/liquid|money market|overnight|debt|gilt|bond|income|duration|credit risk|banking & psu|ultra short|low duration|corporate/.test(text)) return 'debt';
  if (/equity|index|nifty|sensex|flexi|large|mid ?cap|small ?cap|elss|tax saver|growth opportunities|focused|value|contra|dividend yield|bluechip|blue chip|fund of fund/.test(text)) return 'equity';
  return 'other';
}
