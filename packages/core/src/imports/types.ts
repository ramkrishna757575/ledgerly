export type ParsedRow = {
  date: string;
  description: string;
  // Ledger sign for the statement's account: negative is money out or a card charge.
  amount: number;
  balance?: number;
};

export type ParsedStatement = {
  adapterId: string;
  accountKind: 'bank' | 'credit_card';
  accountLast4?: string;
  periodStart?: string;
  periodEnd?: string;
  openingBalance?: number;
  closingBalance?: number;
  // Credit cards: when the bill is due and the smallest payment allowed.
  dueDate?: string;
  minimumDue?: number;
  // What the rows must add up to, when the statement says so.
  statedNet?: number;
  // The adapter found the statement contradicting itself, which is as good as totals that do not add up.
  inconsistent?: boolean;
  rows: ParsedRow[];
  warnings: string[];
};

// An adapter understands one statement layout. Supporting a new bank means
// adding an adapter here, with no changes to the import pipeline.
export type StatementAdapter = {
  id: string;
  label: string;
  // The bank's name, used to prefill the account a statement belongs to.
  bank: string;
  // How sure the adapter is that this text is its layout, from 0 to 1.
  detect(text: string): number;
  parse(text: string): ParsedStatement;
};
