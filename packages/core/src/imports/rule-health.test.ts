import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from '../accounts.ts';
import { ensureStarterCategories, seedDefaults } from '../seed.ts';
import { createSimpleTransaction } from '../transactions.ts';
import { createRule, ruleHealth, updateRule } from './rules.ts';

let db: ReturnType<typeof openDb>;
const cat = (name: string) => listAccounts(db).find((a) => a.name === name && a.type === 'expense')!.id;
const LATER = '2099-01-01';

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' }).id;
  createSimpleTransaction(db, { date: '2026-10-01', description: 'AMAZON PAY', kind: 'expense', accountId: bank, counterAccountId: cat('Uncategorized'), amount: 500_00 } as never);
});

describe('rule health', () => {
  it('finds a rule that matches nothing, but not a young one or one that matches', () => {
    createRule(db, { pattern: 'amazon', categoryId: cat('Shopping') });
    createRule(db, { pattern: 'nothing like this', categoryId: cat('Travel') });
    expect(ruleHealth(db)).toEqual([]); // both are new, so give them time
    const found = ruleHealth(db, { today: LATER });
    expect(found).toMatchObject([{ pattern: 'nothing like this', kind: 'unused', categoryName: 'Travel' }]);
  });

  it('finds a rule that a broader one above it always beats, and says whether they disagree', () => {
    createRule(db, { pattern: 'amazon', categoryId: cat('Shopping') });
    createRule(db, { pattern: 'amazon pay', categoryId: cat('Shopping') });
    createRule(db, { pattern: 'amazon pay later', categoryId: cat('Loan EMI') });
    const found = ruleHealth(db, { today: '2026-11-05' }).filter((p) => p.kind !== 'unused');
    expect(found).toMatchObject([
      { pattern: 'amazon pay', kind: 'shadowed', reason: expect.stringMatching(/same category/) },
      { pattern: 'amazon pay later', kind: 'conflict', reason: expect.stringMatching(/Shopping.*never applies/) },
    ]);
  });

  it('does not call a rule shadowed when it has its own conditions, or when the narrower one comes first', () => {
    createRule(db, { pattern: 'amazon', categoryId: cat('Shopping') });
    createRule(db, { pattern: 'amazon pay', categoryId: cat('Loan EMI'), minAmount: 5_000_00 });
    expect(ruleHealth(db, { today: '2026-11-05' }).filter((p) => p.kind !== 'unused')).toEqual([]);
    const ruleId = createRule(db, { pattern: 'amazon pay', categoryId: cat('Travel') }).id;
    updateRule(db, ruleId, { priority: 1 });
    // The specific rule now comes first, and the broad one after it is what is left for everything else.
    expect(ruleHealth(db, { today: '2026-11-05' }).filter((p) => p.kind !== 'unused')).toEqual([]);
  });
});
