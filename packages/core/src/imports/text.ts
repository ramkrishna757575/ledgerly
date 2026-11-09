import { parseAmount } from '../money.ts';

export const AMOUNT = String.raw`-?[\d,]+\.\d{2}`;

export const toMinor = parseAmount;

export const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

export const indentOf = (line: string) => line.length - line.trimStart().length;

// Accepts DD-MM-YYYY and DD/MM/YYYY and rejects dates that do not exist.
export function dmyToIso(value: string): string | undefined {
  const match = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(value);
  if (!match) return undefined;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  const valid = !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
  return valid ? iso : undefined;
}

export function lastFourDigits(value: string | undefined) {
  return value ? /(\d{4})$/.exec(value)?.[1] : undefined;
}
