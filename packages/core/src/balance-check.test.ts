import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, getBalances, getCashFlow, getNetWorth, listAccounts } from './accounts.ts';
import { matchStatementBalance, statementBalanceChecks } from './balance-check.ts';
import { assignAccount, commitBatch, stageStatement } from './imports/batches.ts';
import { getSampleStatement } from './imports/samples.ts';
import { computeInsights, fixInsight } from './insights.ts';
import { monthlyPattern } from './analysis/surplus.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';

let db: ReturnType<typeof openDb>;

function importSample(id: string, accountId: number) {
  // The bank sample pays a card, which needs one to exist.
  if (id === 'bank') createAccount(db, { name: 'Card', type: 'liability', subtype: 'credit_card' });
  const batch = stageStatement(db, getSampleStatement(id)!);
  assignAccount(db, batch.id, accountId);
  commitBatch(db, batch.id);
  return batch.id;
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
});

describe('statement balance check', () => {
  it('finds a balance that disagrees with the statement, and matches it without touching history', () => {
    const bank = createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank' }).id;
    const savings = importSample('bank', bank);
    const checks = statementBalanceChecks(db);
    expect(checks).toHaveLength(1);
    const [check] = checks;
    expect(check!.difference).toBe(check!.statement - check!.ledger);
    expect(check!.difference).not.toBe(0);

    const flow = getCashFlow(db, { from: '2000-01-01', to: '2100-01-01' });
    const insight = computeInsights(db).find((i) => i.key.startsWith('statement_balance'))!;
    expect(insight).toMatchObject({ severity: 'attention', action: { type: 'fix' } });

    fixInsight(db, insight.key);
    expect(statementBalanceChecks(db)).toEqual([]);
    expect(getBalances(db, { asOf: check!.asOf }).find((b) => b.id === bank)!.balance).toBe(check!.statement);
    // Income and spending are untouched: the adjustment sits against Opening Balances.
    expect(getCashFlow(db, { from: '2000-01-01', to: '2100-01-01' })).toEqual(flow);
    expect(() => matchStatementBalance(db, bank)).toThrow(/already matches/);
    void savings;
  });

  it('works for a credit card, where the balance is what is owed', () => {
    // The sample's own previous balance is nil, so give the card a stray 5,000 owed to disagree with it.
    const card = createAccount(db, { name: 'My card', type: 'liability', subtype: 'credit_card', openingBalance: 5_000_00, openingDate: '2000-01-01' }).id;
    importSample('card', card);
    const [check] = statementBalanceChecks(db);
    expect(check!.type).toBe('liability');
    expect(check!.difference).toBe(-5_000_00);
    matchStatementBalance(db, card);
    expect(getBalances(db, { asOf: check!.asOf }).find((b) => b.id === card)!.balance).toBe(check!.statement);
    expect(getNetWorth(db).liabilities).toBeGreaterThanOrEqual(0);
  });

  it('says nothing when there are no imported statements', () => {
    createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank', openingBalance: 100_00, openingDate: '2026-01-01' });
    expect(statementBalanceChecks(db)).toEqual([]);
  });
});

describe('months used for a normal month', () => {
  it('counts only months a bank statement covers in full once statements are imported', () => {
    const bank = createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank' }).id;
    importSample('bank', bank);
    const batch = listAccounts(db);
    void batch;
    const withStatement = monthlyPattern(db, '2027-12-15');
    // Whatever month the sample covers is far outside the last three, so none qualify.
    expect(withStatement).toMatchObject({ monthsOfData: 0, fromStatements: true, spending: null });
  });
});
