// What a transaction is, in the words a person would use, so a card bill payment or a
// monthly SIP is not mistaken for spending.
type Side = { accountId: number; accountType: string };
type Account = { id: number; type: string; subtype: string | null };

export type PlainKind = { label: string; note?: string };

const isCategory = (type: string) => type === 'income' || type === 'expense';

export function plainKind(postings: Side[], accounts: Map<number, Account>): PlainKind {
  const subtypeOf = (side: Side) => accounts.get(side.accountId)?.subtype ?? null;
  const category = postings.find((p) => isCategory(p.accountType));

  if (category) {
    const money = postings.find((p) => !isCategory(p.accountType));
    if (category.accountType === 'income') return { label: 'Money in' };
    if (money && subtypeOf(money) === 'credit_card') return { label: 'Card purchase', note: 'Counted as spending now. The card bill payment later is not counted again.' };
    return { label: 'Spending' };
  }

  const cards = postings.filter((p) => subtypeOf(p) === 'credit_card');
  const investments = postings.filter((p) => subtypeOf(p) === 'investment');
  const loans = postings.filter((p) => subtypeOf(p) === 'loan');
  if (cards.length > 0) return { label: 'Card bill payment', note: 'Not spending. The spending was counted when the card was used.' };
  if (loans.length > 0) return { label: 'Loan payment', note: 'Not spending. It reduces what you owe.' };
  if (investments.length > 0) return { label: 'Investment', note: 'Not spending. The money moved into something you own.' };
  return { label: 'Moved between your accounts', note: 'Not spending or income.' };
}

// What to show beside a balance. A card or loan balance is what you owe, so a
// negative one means the bank owes you (overpaid, or a refund over the bill).
export function owedLabel(type: string, balance: number): { amount: number; word: string } | null {
  if (type !== 'liability') return null;
  return balance < 0 ? { amount: -balance, word: 'in credit' } : { amount: balance, word: 'owed' };
}
