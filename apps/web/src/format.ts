const trim = (value: number) => String(Math.round(value * 10) / 10).replace(/\.0$/, '');

// Indian short form for axis labels: 12K, 3.5L, 1.2Cr. Amounts are in paise.
export function formatCompact(minor: number) {
  const rupees = Math.abs(minor) / 100;
  const sign = minor < 0 ? '-' : '';
  if (rupees >= 1e7) return `${sign}${trim(rupees / 1e7)}Cr`;
  if (rupees >= 1e5) return `${sign}${trim(rupees / 1e5)}L`;
  if (rupees >= 1e3) return `${sign}${trim(rupees / 1e3)}K`;
  return `${sign}${Math.round(rupees)}`;
}

// Round axis steps (1, 2, 2.5, 5 times a power of ten) that cover low to high.
export function niceTicks(low: number, high: number, count = 4) {
  const lo = Math.min(0, low);
  const hi = Math.max(0, high, lo + 100);
  const rough = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10);
  const ticks: number[] = [];
  for (let value = Math.floor(lo / step) * step; ; value += step) {
    ticks.push(Math.round(value));
    if (value >= hi) break;
  }
  return ticks;
}
