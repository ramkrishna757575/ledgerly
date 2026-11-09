import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from '../accounts.ts';
import { listProposals } from '../proposals.ts';
import { ensureStarterCategories, seedDefaults } from '../seed.ts';
import { createSimpleTransaction } from '../transactions.ts';
import { aiCategorize, categorizeSnapshot, maskPayee, setAiCategorize } from './categorize.ts';

let db: ReturnType<typeof openDb>;
const cat = (name: string) => listAccounts(db).find((a) => a.name === name)!.id;
const AI = { provider: 'openai' as const, model: 'm', baseUrl: 'http://localhost:11434/v1' };

function spend(payee: string, rupees: number, times = 3) {
  const bank = listAccounts(db).find((a) => a.name === 'Bank')!.id;
  for (let i = 0; i < times; i++) {
    createSimpleTransaction(db, { date: `2026-10-0${i + 1}`, description: `UPI/DR/123456789012/${payee}/note`, payee, kind: 'expense', accountId: bank, counterAccountId: cat('Uncategorized'), amount: rupees * 100 } as never);
  }
}

const reply = (content: unknown) => {
  const seen: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    seen.push(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
};

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 10_00_000_00, openingDate: '2026-01-01' });
});

describe('AI category suggestions', () => {
  it('sends only blanked payee text, counts and category names', () => {
    spend('Nandini Dairy 9876543210', 240);
    spend('Rahul Sharma', 500);
    const { send } = categorizeSnapshot(db);
    const text = JSON.stringify(send);
    expect(send.groups.map((g) => g.payee).sort()).toEqual(['Nandini Dairy #', 'Rahul Sharma']);
    expect(send.groups[0]).toEqual(expect.objectContaining({ times: 3, kind: 'expense' }));
    expect(text).not.toMatch(/9876543210|2026-10|123456789012|"Bank"/);
    expect(send.spendingCategories).toContain('Groceries');
    expect(send.spendingCategories).not.toContain('Uncategorized');
    expect(maskPayee('PAY 1234567 TO   X')).toBe('PAY # TO X');
  });

  it('does nothing until it is turned on', async () => {
    spend('Nandini Dairy', 240);
    await expect(aiCategorize(db, AI, { fetcher: reply([]).fetcher })).rejects.toThrow(/Turn on/);
  });

  it('turns confident answers into suggested rules, and leaves unsure or invalid ones alone', async () => {
    spend('Nandini Dairy', 240);
    spend('Rahul Sharma', 500);
    spend('Mystery Co', 900);
    spend('Wrong Kind', 100);
    setAiCategorize(db, true);
    const ids = Object.fromEntries(categorizeSnapshot(db).send.groups.map((g) => [g.payee, g.id]));
    const { fetcher, seen } = reply(`Here you go:\n${JSON.stringify([
      { id: ids['Nandini Dairy'], category: 'Groceries', confidence: 0.92, reason: 'a dairy' },
      { id: ids['Rahul Sharma'], category: null, confidence: 0.2, reason: 'a person' },
      { id: ids['Mystery Co'], category: 'Travel', confidence: 0.4, reason: 'guess' },
      { id: ids['Wrong Kind'], category: 'Salary', confidence: 0.99, reason: 'income category for an expense' },
      { id: 999, category: 'Groceries', confidence: 0.99, reason: 'no such payee' },
    ])}`);
    const run = await aiCategorize(db, AI, { fetcher });
    expect(run).toMatchObject({ sent: 4, proposed: 1, local: true });
    expect(run.skipped).toBe(4);
    const pending = listProposals(db, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'create_rule', source: 'AI suggestions', to: 'Groceries' });
    expect((pending[0] as { rule: { pattern: string } }).rule.pattern).toBe('Nandini Dairy');
    expect(seen[0]).toContain('Nandini Dairy');
    expect(seen[0]).not.toContain('123456789012');
  });

  it('refuses an answer that is not JSON, and suggests nothing', async () => {
    spend('Nandini Dairy', 240);
    setAiCategorize(db, true);
    await expect(aiCategorize(db, AI, { fetcher: reply('I am not sure what you mean.').fetcher })).rejects.toThrow(/expected format/);
    expect(listProposals(db, { status: 'pending' })).toEqual([]);
  });
});
