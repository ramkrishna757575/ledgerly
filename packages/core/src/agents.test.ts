import { readFileSync } from 'node:fs';
import { accounts, apiTokens, openDb, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveProposal,
  authenticateToken,
  countPendingProposals,
  createAccount,
  createApiToken,
  createSimpleTransaction,
  decideAll,
  getImportBatch,
  listApiTokens,
  listAudit,
  listProposals,
  listRules,
  proposeImportRowCategories,
  proposeRule,
  proposeTransactionCategories,
  recordAudit,
  rejectProposal,
  revokeApiToken,
  seedDefaults,
  setTransactionCategory,
  stageStatement,
} from './index.ts';

let db: Db;
let bank: number;

const category = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).get()!.id;

function spend(payee: string, name = 'Uncategorized', amount = 1000) {
  return createSimpleTransaction(db, {
    kind: 'expense',
    date: '2026-10-01',
    description: payee,
    payee,
    accountId: bank,
    counterAccountId: category(name),
    amount,
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 1000000 }).id;
});

describe('access tokens', () => {
  it('hands the token out once and stores only its hash', () => {
    const { token, record } = createApiToken(db, { name: 'Claude', scope: 'propose' });
    expect(token).toMatch(/^lg_[A-Za-z0-9_-]{40,}$/);
    expect(record.tokenPrefix).toBe(token.slice(0, 9));

    const stored = db.select().from(apiTokens).get()!;
    expect(stored.tokenHash).not.toContain(token);
    expect(JSON.stringify(listApiTokens(db))).not.toContain(stored.tokenHash);
  });

  it('recognises a token, with its name and scope, and notes when it was used', () => {
    const { token } = createApiToken(db, { name: 'Reader', scope: 'read' });
    expect(listApiTokens(db)[0]?.lastUsedAt).toBeNull();
    expect(authenticateToken(db, token)).toMatchObject({ name: 'Reader', scope: 'read' });
    expect(listApiTokens(db)[0]?.lastUsedAt).not.toBeNull();
  });

  it('turns away unknown, malformed and revoked tokens', () => {
    const { token, record } = createApiToken(db, { name: 'Temp', scope: 'read' });
    expect(authenticateToken(db, undefined)).toBeUndefined();
    expect(authenticateToken(db, 'lg_wrong')).toBeUndefined();
    expect(authenticateToken(db, token.slice(3))).toBeUndefined();
    revokeApiToken(db, record.id);
    expect(authenticateToken(db, token)).toBeUndefined();
    expect(listApiTokens(db)[0]?.revokedAt).not.toBeNull();
    expect(() => revokeApiToken(db, 999)).toThrow(/not found/);
  });

  it('needs a name and a known access level', () => {
    expect(() => createApiToken(db, { name: '', scope: 'read' })).toThrow();
    expect(() => createApiToken(db, { name: 'x', scope: 'admin' as never })).toThrow();
  });
});

describe('audit log', () => {
  it('lists the newest first and shortens long arguments', () => {
    recordAudit(db, { actor: 'Claude', tool: 'get_accounts', outcome: 'ok' });
    recordAudit(db, { actor: 'Claude', tool: 'search_transactions', args: { query: 'x'.repeat(5000) }, outcome: 'error', detail: 'bad' });
    const [latest, earlier] = listAudit(db);
    expect(latest).toMatchObject({ tool: 'search_transactions', outcome: 'error' });
    expect(latest?.args?.length).toBe(2000);
    expect(earlier?.tool).toBe('get_accounts');
  });
});

describe('suggestions for transactions', () => {
  it('checks each item, keeps the good ones and tells the agent about the rest', () => {
    const ok = spend('Ravi');
    const already = spend('Landlord', 'Rent');
    const other = createAccount(db, { name: 'Other', type: 'asset' }).id;
    const transfer = createSimpleTransaction(db, { kind: 'transfer', date: '2026-10-02', description: 'Move', accountId: bank, counterAccountId: other, amount: 5 });

    const results = proposeTransactionCategories(db, 'Claude', {
      items: [
        { transactionId: ok.id, categoryId: category('Gifts & Donations'), reason: 'Personal payee' },
        { transactionId: already.id, categoryId: category('Rent') },
        { transactionId: transfer.id, categoryId: category('Rent') },
        { transactionId: 9999, categoryId: category('Rent') },
      ],
    });

    expect(results[0]).toMatchObject({ transactionId: ok.id, proposalId: expect.any(Number) });
    expect(results[1]).toMatchObject({ error: expect.stringMatching(/Already in Rent/) });
    expect(results[2]).toMatchObject({ error: expect.stringMatching(/no single category/) });
    expect(results[3]).toMatchObject({ error: expect.stringMatching(/not found/) });
    expect(countPendingProposals(db)).toBe(1);
  });

  it('changes nothing until approved, then applies it like a manual change', () => {
    const tx = spend('Ravi');
    const [result] = proposeTransactionCategories(db, 'Claude', { items: [{ transactionId: tx.id, categoryId: category('Gifts & Donations'), reason: 'Personal' }] });
    const proposalId = (result as { proposalId: number }).proposalId;

    expect(listProposals(db, { status: 'pending' })[0]).toMatchObject({
      kind: 'categorize_transaction',
      from: 'Uncategorized',
      to: 'Gifts & Donations',
      reason: 'Personal',
      source: 'Claude',
      target: { description: 'Ravi', amount: -1000, account: 'Bank' },
    });
    expect(db.select().from(accounts).where(eq(accounts.name, 'Gifts & Donations')).get()).toBeDefined();

    expect(approveProposal(db, proposalId).status).toBe('approved');
    expect(countPendingProposals(db)).toBe(0);
  });

  it('replaces an earlier suggestion for the same transaction', () => {
    const tx = spend('Ravi');
    const first = proposeTransactionCategories(db, 'Claude', { items: [{ transactionId: tx.id, categoryId: category('Gifts & Donations') }] })[0] as { proposalId: number };
    const second = proposeTransactionCategories(db, 'Claude', { items: [{ transactionId: tx.id, categoryId: category('Health') }] })[0] as { proposalId: number };
    expect(second.proposalId).toBe(first.proposalId);
    expect(listProposals(db, { status: 'pending' })).toHaveLength(1);
    expect(listProposals(db)[0]?.to).toBe('Health');
  });

  it('refuses to approve once you have changed that transaction yourself', () => {
    const tx = spend('Ravi');
    const { proposalId } = proposeTransactionCategories(db, 'Claude', { items: [{ transactionId: tx.id, categoryId: category('Gifts & Donations') }] })[0] as { proposalId: number };
    setTransactionCategory(db, tx.id, category('Travel'));

    const result = approveProposal(db, proposalId);
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/Changed to Travel/) });
    expect(listProposals(db, { status: 'pending' })).toHaveLength(0);
  });

  it('can be turned down, and decided only once', () => {
    const tx = spend('Ravi');
    const { proposalId } = proposeTransactionCategories(db, 'Claude', { items: [{ transactionId: tx.id, categoryId: category('Health') }] })[0] as { proposalId: number };
    expect(rejectProposal(db, proposalId).status).toBe('rejected');
    expect(() => approveProposal(db, proposalId)).toThrow(/already rejected/);
    expect(() => approveProposal(db, 999)).toThrow(/not found/);
  });

  it('approves or rejects a whole batch', () => {
    const items = [spend('A'), spend('B'), spend('C')].map((tx) => ({ transactionId: tx.id, categoryId: category('Health') }));
    proposeTransactionCategories(db, 'Claude', { items });
    expect(decideAll(db, 'approve')).toEqual({ done: 3, failed: 0 });
    expect(countPendingProposals(db)).toBe(0);
  });

  it('limits how many items one call can carry', () => {
    const tx = spend('A');
    const items = Array.from({ length: 101 }, () => ({ transactionId: tx.id, categoryId: category('Health') }));
    expect(() => proposeTransactionCategories(db, 'Claude', { items })).toThrow();
  });
});

describe('suggestions for import rows', () => {
  const text = () => readFileSync(new URL('./imports/fixtures/axis-consolidated.txt', import.meta.url), 'utf8');
  const stage = () =>
    stageStatement(db, {
      text: text(),
      accountId: bank,
      file: { sha256: 'a', filename: 'a.pdf', mimeType: 'application/pdf', size: 1, storedName: 'a.pdf' },
    });

  it('sets the category on a row waiting for review once approved', () => {
    const batch = stage();
    const row = batch.items.find((item) => item.payee === 'Rahul Sharma')!;
    const { proposalId } = proposeImportRowCategories(db, 'Claude', { items: [{ rowId: row.id, categoryId: category('Gifts & Donations') }] })[0] as { proposalId: number };

    expect(listProposals(db)[0]).toMatchObject({ kind: 'categorize_import_row', from: null, to: 'Gifts & Donations', target: { description: expect.stringContaining('Rahul') } });
    expect(getImportBatch(db, batch.id).items.find((i) => i.id === row.id)?.categoryId).toBeNull();

    approveProposal(db, proposalId);
    expect(getImportBatch(db, batch.id).items.find((i) => i.id === row.id)).toMatchObject({
      categoryId: category('Gifts & Donations'),
      categorySource: 'manual',
    });
  });

  it('will not suggest for a finished or unknown row', () => {
    const results = proposeImportRowCategories(db, 'Claude', { items: [{ rowId: 9999, categoryId: category('Health') }] });
    expect(results[0]).toMatchObject({ error: expect.stringMatching(/not found/) });
  });

  it('refuses to approve after you chose a category yourself', async () => {
    const batch = stage();
    const row = batch.items.find((item) => item.payee === 'Rahul Sharma')!;
    const { proposalId } = proposeImportRowCategories(db, 'Claude', { items: [{ rowId: row.id, categoryId: category('Gifts & Donations') }] })[0] as { proposalId: number };
    const { updateStagedRow } = await import('./index.ts');
    updateStagedRow(db, row.id, { categoryId: category('Travel') });

    expect(approveProposal(db, proposalId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/changed after/) });
  });
});

describe('suggestions for rules', () => {
  it('creates the rule only once approved', () => {
    const { proposalId } = proposeRule(db, 'Claude', { pattern: 'big basket', categoryId: category('Groceries'), reason: 'Seen 9 times' });
    expect(listRules(db)).toHaveLength(0);
    expect(listProposals(db)[0]).toMatchObject({ kind: 'create_rule', to: 'Groceries', rule: { pattern: 'big basket', matchType: 'contains' } });
    approveProposal(db, proposalId);
    expect(listRules(db).map((r) => [r.pattern, r.categoryName])).toEqual([['big basket', 'Groceries']]);
  });

  it('rejects a bad pattern or category straight away', () => {
    expect(() => proposeRule(db, 'Claude', { pattern: '(abc', matchType: 'regex', categoryId: category('Rent') })).toThrow(/valid pattern/);
    const equity = db.select().from(accounts).where(eq(accounts.type, 'equity')).get()!;
    expect(() => proposeRule(db, 'Claude', { pattern: 'abc', categoryId: equity.id })).toThrow(/Choose a category/);
  });
});
