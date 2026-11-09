// Money is an integer count of the smallest currency unit (paise for INR).

const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export function parseAmount(input: string): number {
  const cleaned = input.replace(/[,\s₹]/g, '');
  if (!AMOUNT_PATTERN.test(cleaned)) throw new Error(`Invalid amount: ${input}`);

  const negative = cleaned.startsWith('-');
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) throw new Error(`Amount out of range: ${input}`);
  return negative && minor !== 0 ? -minor : minor;
}

export function formatAmount(minor: number, currency = 'INR'): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}
