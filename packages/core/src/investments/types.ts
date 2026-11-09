import type { AssetClass, InvestmentKind, InvestmentSource } from '@ledgerly/db';

// Units and prices in millionths, money in paise.
export type ParsedHolding = {
  name: string;
  isin?: string;
  folio?: string;
  schemeCode?: string;
  assetClass?: AssetClass;
  units: number;
  nav: number;
  value: number;
  invested?: number;
  xirrBps?: number;
};

export type ParsedTransaction = {
  date: string;
  kind: InvestmentKind;
  // Positive. Units carry the direction.
  amount: number;
  units: number;
  nav?: number;
  description: string;
};

// What one statement says happened to one scheme in its period.
export type ParsedBlock = {
  schemeCode?: string;
  name: string;
  openingUnits?: number;
  closingUnits?: number;
  rows: ParsedTransaction[];
};

export type ParsedInvestmentStatement = {
  adapterId: string;
  source: InvestmentSource;
  label: string;
  asOf: string;
  periodStart?: string;
  statedTotal?: number;
  holdings: ParsedHolding[];
  blocks: ParsedBlock[];
  warnings: string[];
};

export type InvestmentAdapter = {
  id: string;
  source: InvestmentSource;
  label: string;
  detect(text: string): number;
  parse(text: string): ParsedInvestmentStatement;
};
