import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from '../accounts.ts';
import { ensureStarterCategories, seedDefaults } from '../seed.ts';
import { createSimpleTransaction, getTransaction } from '../transactions.ts';
import { assignAccount, getImportBatch, stageStatement } from './batches.ts';
import { applyAllRules, createRule, firstMatchingRule, listRules, previewRule, updateRule } from './rules.ts';
import { getSampleStatement } from './samples.ts';

let db: ReturnType<typeof openDb>;
const cat = (name: string) => listAccounts(db).find((a) => a.name === name && a.type === 'expense')!.id;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
});

describe('rule conditions', () => {
  it('match on the amount as well as the text', () => {
    createRule(db, { pattern: 'amazon', matchType: 'contains', categoryId: cat('Groceries'), minAmount: 5_000_00 });
    createRule(db, { pattern: 'amazon', matchType: 'contains', categoryId: cat('Subscriptions'), maxAmount: 1_000_00 });
    const rules = listRules(db).map((r) => ({ ...r })) as never[];
    const all = rules as unknown as Parameters<typeof firstMatchingRule>[0];
    const pick = (amount: number) => firstMatchingRule(all, { description: 'AMAZON PAY', amount })?.categoryId;
    expect(pick(-6_000_00)).toBe(cat('Groceries'));
    expect(pick(-299_00)).toBe(cat('Subscriptions'));
    expect(pick(-2_000_00)).toBeUndefined();
    // With no amount to check, a rule with an amount condition stays out of it.
    expect(firstMatchingRule(all, { description: 'AMAZON PAY' })).toBeUndefined();
  });

  it('keeps two rules on the same text apart when their conditions differ, and updates the right one', () => {
    createRule(db, { pattern: 'dmart', categoryId: cat('Groceries'), maxAmount: 500_00 });
    createRule(db, { pattern: 'dmart', categoryId: cat('Shopping'), minAmount: 500_01 });
    expect(listRules(db)).toHaveLength(2);
    // Saying the same thing again does not add a third.
    createRule(db, { pattern: 'DMART', categoryId: cat('Food & Dining'), maxAmount: 500_00 });
    expect(listRules(db)).toHaveLength(2);
    const [first] = listRules(db);
    expect(updateRule(db, first!.id, { maxAmount: 300_00 }).maxAmount).toBe(300_00);
    expect(() => updateRule(db, first!.id, { minAmount: 900_00 })).toThrow(/smallest amount/);
    expect(() => createRule(db, { pattern: 'x1', categoryId: cat('Groceries'), minAmount: 10, maxAmount: 5 })).toThrow(/smallest/);
  });

  it('apply to existing transactions by amount and by account', () => {
    const a = createAccount(db, { name: 'Joint', type: 'asset', subtype: 'bank' }).id;
    const b = createAccount(db, { name: 'Mine', type: 'asset', subtype: 'bank' }).id;
    const other = cat('Uncategorized');
    const spend = (account: number, amount: number) =>
      (createSimpleTransaction(db, { date: '2026-10-01', description: 'Store 12', kind: 'expense', accountId: account, counterAccountId: other, amount } as never) as { id: number }).id;
    const bigJoint = spend(a, 8_000_00);
    const smallJoint = spend(a, 200_00);
    const bigMine = spend(b, 8_000_00);

    createRule(db, { pattern: 'store 12', categoryId: cat('Shopping'), minAmount: 1_000_00, accountId: a });
    expect(previewRule(db, { pattern: 'store 12', minAmount: 1_000_00, accountId: a }).matches).toBe(1);
    expect(applyAllRules(db)).toEqual({ updated: 1 });
    const category = (id: number) => getTransaction(db, id).postings.find((p) => p.accountType === 'expense')!.accountName;
    expect(category(bigJoint)).toBe('Shopping');
    expect(category(smallJoint)).toBe('Uncategorized');
    expect(category(bigMine)).toBe('Uncategorized');
  });

  it('wait for the account to be known before a statement row is sorted by them', () => {
    const sample = getSampleStatement('card')!;
    const card = createAccount(db, { name: 'Card', type: 'liability', subtype: 'credit_card' }).id;
    const batch = stageStatement(db, sample);
    const first = batch.items.find((i) => i.amount < 0)!;
    createRule(db, { pattern: first.payee ?? first.description.slice(0, 6), categoryId: cat('Entertainment'), accountId: card });
    // Not known which account it is yet, so the rule has not fired.
    expect(getImportBatch(db, batch.id).items.find((i) => i.id === first.id)!.categoryId).not.toBe(cat('Entertainment'));
    assignAccount(db, batch.id, card);
    expect(getImportBatch(db, batch.id).items.find((i) => i.id === first.id)!.categoryId).toBe(cat('Entertainment'));
  });
});
