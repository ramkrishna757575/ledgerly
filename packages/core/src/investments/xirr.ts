export type Cashflow = { date: string; amount: number };

const DAY = 86_400_000;
const years = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY / 365;

// Money-weighted annual return. Money put in is negative, money taken out (and
// what it is worth now) positive. Returns undefined when there is no sensible
// answer, such as no money in, or nothing back.
export function xirr(flows: Cashflow[]): number | undefined {
  const sorted = [...flows].filter((f) => f.amount !== 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.some((f) => f.amount < 0) || !sorted.some((f) => f.amount > 0)) return undefined;
  const start = sorted[0]!.date;
  if (sorted.at(-1)!.date === start) return undefined;

  const npv = (rate: number) => sorted.reduce((sum, f) => sum + f.amount / (1 + rate) ** years(start, f.date), 0);

  // The value is falling in rate, so a bracket and bisection always converge.
  let low = -0.999;
  let high = 10;
  if (npv(low) * npv(high) > 0) return undefined;
  for (let step = 0; step < 200; step += 1) {
    const mid = (low + high) / 2;
    if (npv(low) * npv(mid) <= 0) high = mid;
    else low = mid;
    if (high - low < 1e-10) break;
  }
  return (low + high) / 2;
}
