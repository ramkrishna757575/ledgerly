import { importBatches, openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { getBalances, listAccounts } from '../accounts.ts';
import { getHoldings } from '../investments/portfolio.ts';
import { getInvestmentSample } from '../investments/samples.ts';
import { ensureStarterCategories, seedDefaults } from '../seed.ts';
import { commitReadyImports, dryRunCommitReady, stageAnyStatement } from './bulk.ts';
import { getSampleStatement } from './samples.ts';

let db: ReturnType<typeof openDb>;
const sample = (id: string, variant = '') => {
  const s = getSampleStatement(id)!;
  return { text: s.text, file: { ...s.file, sha256: s.file.sha256 + variant } };
};

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
});

describe('importing a pile of statements', () => {
  it('works out what each statement is and creates the accounts it needs', () => {
    expect(stageAnyStatement(db, sample('card')).kind).toBe('bank');
    expect(stageAnyStatement(db, sample('bank')).kind).toBe('bank');
    expect(stageAnyStatement(db, getInvestmentSample('cdsl')!).kind).toBe('investment');
    expect(() => stageAnyStatement(db, { text: 'just some notes', file: sample('bank').file })).toThrow(/not supported/);

    const made = listAccounts(db).filter((a) => a.type === 'asset' || a.type === 'liability');
    expect(made.map((a) => `${a.type}:${a.subtype}`).sort()).toEqual(['asset:bank', 'liability:credit_card']);
    expect(made.every((a) => a.numberLast4 && a.institution)).toBe(true);
  });

  it('imports everything that is safe, oldest first, and reports what it did', () => {
    stageAnyStatement(db, sample('card'));
    stageAnyStatement(db, sample('bank'));
    stageAnyStatement(db, getInvestmentSample('cdsl')!);

    const result = commitReadyImports(db);
    expect(result.held).toEqual([]);
    expect(result.imported.map((i) => i.kind).sort()).toEqual(['bank', 'bank', 'investment']);
    expect(getHoldings(db).holdings.length).toBeGreaterThan(0);
    expect(db.select().from(importBatches).all().every((b) => b.status === 'committed')).toBe(true);
    expect(getBalances(db).some((b) => b.type === 'asset' && b.balance !== 0)).toBe(true);

    expect(commitReadyImports(db)).toEqual({ imported: [], held: [] });
  });

  it('holds a bank statement that pays a card nobody has set up, until the card exists', () => {
    stageAnyStatement(db, sample('bank'));
    const first = commitReadyImports(db);
    expect(first.held[0]!.reason).toMatch(/pays a credit card that is not set up/);

    stageAnyStatement(db, sample('card'));
    const second = commitReadyImports(db);
    expect(second.held).toEqual([]);
    expect(second.imported).toHaveLength(2);
  });

  it('does not add transactions twice when statements overlap', () => {
    stageAnyStatement(db, sample('card'));
    stageAnyStatement(db, sample('bank'));
    commitReadyImports(db);
    const before = getBalances(db).find((b) => b.subtype === 'bank')!.balance;

    // The same transactions again, in a file with a different checksum.
    stageAnyStatement(db, sample('bank', '-again'));
    const result = commitReadyImports(db);
    expect(result.imported).toEqual([]);
    expect(result.held[0]!.reason).toMatch(/already imported/);
    expect(getBalances(db).find((b) => b.subtype === 'bank')!.balance).toBe(before);
  });

  it('leaves a statement for review when it has no account or does not add up', () => {
    const staged = stageAnyStatement(db, sample('bank'));
    db.update(importBatches).set({ accountId: null }).run();
    const noAccount = commitReadyImports(db);
    expect(noAccount.held).toMatchObject([{ id: staged.id, reason: expect.stringMatching(/No account/) }]);

    stageAnyStatement(db, sample('card', '-b'));
    db.update(importBatches).set({ reconciliation: 'mismatch' }).run();
    const mismatch = commitReadyImports(db);
    expect(mismatch.held.every((h) => /add up|totals|No account/.test(h.reason))).toBe(true);
    expect(mismatch.imported).toEqual([]);
  });
});

describe('previewing an import', () => {
  it('shows what would happen and leaves everything exactly as it was', () => {
    stageAnyStatement(db, sample('card'));
    stageAnyStatement(db, sample('bank'));
    stageAnyStatement(db, getInvestmentSample('cdsl')!);
    const balancesBefore = JSON.stringify(getBalances(db));
    const batchesBefore = db.select().from(importBatches).all().map((b) => b.status);

    const preview = dryRunCommitReady(db);
    expect(preview.held).toEqual([]);
    expect(preview.imported).toHaveLength(3);
    const bank = preview.imported.find((i) => i.kind === 'bank' && (i.transactions ?? 0) > 0)!;
    expect(bank.moneyIn! + bank.moneyOut!).toBeGreaterThan(0);
    expect(preview.imported.find((i) => i.kind === 'investment')!.holdings).toBeGreaterThan(0);
    expect(preview.balances.length).toBeGreaterThan(0);
    expect(preview.balances.every((b) => b.before !== b.after)).toBe(true);

    // Nothing was kept.
    expect(JSON.stringify(getBalances(db))).toBe(balancesBefore);
    expect(db.select().from(importBatches).all().map((b) => b.status)).toEqual(batchesBefore);
    expect(getHoldings(db).holdings).toEqual([]);

    // And the real import then does what the preview said.
    const real = commitReadyImports(db);
    expect(real.imported.map((i) => i.id).sort()).toEqual(preview.imported.map((i) => i.id).sort());
  });

  it('reports what it would hold back, as the real thing would', () => {
    stageAnyStatement(db, sample('bank'));
    const preview = dryRunCommitReady(db);
    expect(preview.imported).toEqual([]);
    expect(preview.held[0]!.reason).toMatch(/pays a credit card/);
  });
});
