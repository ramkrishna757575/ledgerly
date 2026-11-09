import { describe, expect, it } from 'vitest';
import { owedLabel, plainKind } from './plain.ts';

const accounts = new Map([
  [1, { id: 1, type: 'asset', subtype: 'bank' }],
  [2, { id: 2, type: 'liability', subtype: 'credit_card' }],
  [3, { id: 3, type: 'asset', subtype: 'investment' }],
  [4, { id: 4, type: 'expense', subtype: null }],
  [5, { id: 5, type: 'income', subtype: null }],
  [6, { id: 6, type: 'liability', subtype: 'loan' }],
]);
const sides = (...ids: number[]) => ids.map((accountId) => ({ accountId, accountType: accounts.get(accountId)!.type }));

describe('saying what a transaction is', () => {
  it('calls salary money in and a card swipe a card purchase', () => {
    expect(plainKind(sides(1, 5), accounts).label).toBe('Money in');
    expect(plainKind(sides(2, 4), accounts).label).toBe('Card purchase');
    expect(plainKind(sides(1, 4), accounts).label).toBe('Spending');
  });

  it('says paying a card, a loan or a SIP is not spending', () => {
    for (const [ids, label] of [[[1, 2], 'Card bill payment'], [[1, 6], 'Loan payment'], [[1, 3], 'Investment']] as const) {
      const kind = plainKind(sides(...ids), accounts);
      expect(kind.label).toBe(label);
      expect(kind.note).toMatch(/Not spending/);
    }
  });

  it('calls money between two bank accounts a move', () => {
    const two = new Map(accounts).set(7, { id: 7, type: 'asset', subtype: 'bank' });
    expect(plainKind([{ accountId: 1, accountType: 'asset' }, { accountId: 7, accountType: 'asset' }], two).label).toBe('Moved between your accounts');
  });
});

describe('owedLabel', () => {
  it('shows an overpaid card as credit instead of a negative amount owed', () => {
    expect(owedLabel('liability', 2_612_679)).toEqual({ amount: 2_612_679, word: 'owed' });
    expect(owedLabel('liability', -2_612_679)).toEqual({ amount: 2_612_679, word: 'in credit' });
    expect(owedLabel('asset', -5)).toBeNull();
  });
});
