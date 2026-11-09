import { csv } from './adapters/csv.ts';
import { cdsl } from './adapters/cdsl.ts';
import { scripbox } from './adapters/scripbox.ts';
import type { InvestmentAdapter } from './types.ts';

export const INVESTMENT_ADAPTERS: InvestmentAdapter[] = [cdsl, scripbox, csv];

export function detectInvestmentAdapter(text: string) {
  const scored = INVESTMENT_ADAPTERS.map((adapter) => ({ adapter, score: adapter.detect(text) }));
  const best = scored.sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 0.5 ? best.adapter : undefined;
}
