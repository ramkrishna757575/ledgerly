// What the add-account form can be opened with, so another page can send you
// there with the details it already knows.
export const ACCOUNT_KINDS = ['bank', 'cash', 'wallet', 'investment', 'credit_card', 'loan'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export type AddAccountSearch = {
  add?: AccountKind;
  name?: string;
  last4?: string;
  institution?: string;
  // An import to return to once the account is saved.
  back?: number;
};

export type ImportSearch = { open?: number };

export type TransactionsSearch = { account?: number; from?: string; to?: string };

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined);

const positive = (value: unknown) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

export function parseAddAccountSearch(search: Record<string, unknown>): AddAccountSearch {
  // The router turns "1234" into a number but keeps "7788" as text.
  const last4 = String(search.last4 ?? '');
  return {
    add: ACCOUNT_KINDS.find((kind) => kind === search.add),
    name: text(search.name),
    last4: /^\d{4}$/.test(last4) ? last4 : undefined,
    institution: text(search.institution),
    back: positive(search.back),
  };
}

const isoDate = (value: unknown) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);

export function parseTransactionsSearch(search: Record<string, unknown>): TransactionsSearch {
  return { account: positive(search.account), from: isoDate(search.from), to: isoDate(search.to) };
}

export function parseImportSearch(search: Record<string, unknown>): ImportSearch {
  return { open: positive(search.open) };
}
