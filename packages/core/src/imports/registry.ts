import { axisConsolidated, axisCreditCard, axisStatement } from './adapters/axis.ts';
import { csvBank } from './adapters/csv-bank.ts';
import type { StatementAdapter } from './types.ts';

export const ADAPTERS: StatementAdapter[] = [axisConsolidated, axisStatement, axisCreditCard, csvBank];

// `learned` are the layouts this ledger has been taught; built-in ones win a tie.
export function detectAdapter(text: string, learned: StatementAdapter[] = []) {
  const scored = [...ADAPTERS, ...learned].map((adapter) => ({ adapter, score: adapter.detect(text) }));
  const best = scored.sort((a, b) => b.score - a.score)[0];
  return best && best.score >= 0.5 ? best.adapter : undefined;
}
