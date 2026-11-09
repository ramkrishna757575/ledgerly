import { openDb, type Db } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { setAiCategorize } from './analysis/categorize.ts';
import { createAccount, createSimpleTransaction, ensureStarterCategories, listAccounts, seedDefaults } from './index.ts';
import { aiPayeePicks, aiPayeeSuggestions, applyPayeeAliases, payeeAliaser, payeeRows, textSuggestions, tidySnapshot } from './payees.ts';

const AI = { provider: 'openai' as const, model: 'm', baseUrl: 'http://localhost:11434/v1' };
let db: Db;

function spend(payee: string, description = payee, times = 1) {
  const bank = listAccounts(db).find((a) => a.name === 'Savings')!;
  const food = listAccounts(db).find((a) => a.name === 'Food & Dining')!;
  for (let i = 0; i < times; i++) createSimpleTransaction(db, { date: '2026-10-05', description, payee, kind: 'expense', accountId: bank.id, counterAccountId: food.id, amount: 100_00 } as never);
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank', openingBalance: 1_00_000_00, openingDate: '2026-01-01' });
});

describe('suggesting tidier payee names without a model', () => {
  it('joins spellings and cut-off names, and leaves different people alone', () => {
    const rows = [
      { payee: 'Amazon India', times: 5, sample: '' },
      { payee: 'AMAZON INDIA', times: 2, sample: '' },
      { payee: 'Wealtheon Private Limite', times: 3, sample: '' },
      { payee: 'Wealtheon Private Limited', times: 1, sample: '' },
      { payee: 'Sunny Kumar Singh', times: 4, sample: '' },
      { payee: 'Sunny Kumar', times: 2, sample: '' },
      { payee: 'Ajit M Kr', times: 3, sample: '' },
    ];
    const out = textSuggestions(rows);
    expect(out.map((s) => [s.from, s.to])).toEqual(expect.arrayContaining([['AMAZON INDIA', 'Amazon India'], ['Wealtheon Private Limite', 'Wealtheon Private Limited']]));
    // "Sunny Kumar" is too short to be a cut-off name, so it is not folded into a person.
    expect(out.find((s) => s.from === 'Sunny Kumar')).toBeUndefined();
    expect(out.every((s) => s.source === 'text')).toBe(true);
  });
});

describe('renaming payees', () => {
  it('renames them everywhere, keeps the bank\'s own text, and applies on later imports', () => {
    spend('AMAZON INDIA', 'UPI/AMAZON INDIA/123', 2);
    spend('Amazon India', 'UPI/Amazon India/456');
    const result = applyPayeeAliases(db, [{ from: 'AMAZON INDIA', to: 'Amazon India' }]);
    expect(result.renamed).toBe(2);
    expect(payeeRows(db).map((r) => [r.payee, r.times])).toEqual([['Amazon India', 3]]);
    expect(payeeRows(db)[0]!.sample).toMatch(/^UPI\/(AMAZON|Amazon) INDIA/i);
    // The next statement comes through under the new name, whatever case the bank used.
    const alias = payeeAliaser(db);
    expect(alias('amazon india')).toBe('Amazon India');
    expect(alias('Swiggy')).toBe('Swiggy');
    expect(alias(null)).toBeNull();
  });

  it('follows a chain of renames to the last name', () => {
    spend('Amzn');
    applyPayeeAliases(db, [{ from: 'Amzn', to: 'Amazon India' }]);
    applyPayeeAliases(db, [{ from: 'Amazon India', to: 'Amazon' }]);
    expect(payeeAliaser(db)('Amzn')).toBe('Amazon');
    expect(payeeRows(db).map((r) => r.payee)).toEqual(['Amazon']);
  });
});

function script(reply: unknown) {
  const sent: string[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

describe('asking a model to tidy payees', () => {
  it('is off until turned on', async () => {
    await expect(aiPayeeSuggestions(db, AI, script([]).fetcher)).rejects.toThrow(/Turn on/);
  });

  it('sends names and one example line with long numbers blanked, and keeps only confident, valid answers', async () => {
    setAiCategorize(db, true);
    spend('com India', 'UPI/Amazon.com India/9876543210/ref', 3);
    spend('Google Pl', 'UPI/Google Play/1234567', 2);
    spend('Gully Turf', 'UPI/Gully Turf/777/owner@okbank', 1);
    const snapshot = tidySnapshot(db);
    expect(snapshot.send.map((r) => r.payee)).toEqual(['com India', 'Google Pl', 'Gully Turf']);
    const { fetcher, sent } = script([
      { name: 'Amazon', ids: [1], confidence: 0.9, reason: 'Amazon.com India in the example' },
      { name: 'Google Play', ids: [2, 99], confidence: 0.8, reason: 'cut off' },
      { name: 'Turf', ids: [3], confidence: 0.4, reason: 'unsure' },
    ]);
    const out = await aiPayeeSuggestions(db, AI, fetcher);
    expect(sent[0]).not.toContain('9876543210');
    expect(sent[0]).not.toContain('owner@okbank');
    expect(out.suggestions.map((s) => [s.from, s.to, s.source])).toEqual([['com India', 'Amazon', 'ai'], ['Google Pl', 'Google Play', 'ai']]);
  });
});

describe('filling in the Sort by payee list', () => {
  it('offers categories and generic account words, never account names, and maps answers back', async () => {
    createAccount(db, { name: 'HDFC Regalia 4242', type: 'liability', subtype: 'credit_card', openingBalance: 0, openingDate: '2026-01-01' });
    setAiCategorize(db, true);
    const bank = listAccounts(db).find((a) => a.name === 'Savings')!;
    const unsorted = listAccounts(db).find((a) => a.name === 'Uncategorized')!;
    for (const [payee, notes] of [['CRED Club', 'UPI/P2M/55555555/CRED Club/UTIB'], ['Fresh Mart', 'UPI/P2M/999999/Fresh Mart'], ['Mystery Co', 'UPI/P2M/1/Mystery']]) {
      createSimpleTransaction(db, { date: '2026-10-05', description: payee, payee, notes, kind: 'expense', accountId: bank.id, counterAccountId: unsorted.id, amount: 500_00 } as never);
    }
    const { fetcher, sent } = script([
      { id: 1, pick: 'CARD_BILL', confidence: 0.9, reason: 'CRED pays card bills' },
      { id: 2, pick: 'Groceries', confidence: 0.8, reason: 'a store' },
      { id: 3, pick: 'Groceries', confidence: 0.3, reason: 'guess' },
    ]);
    const out = await aiPayeePicks(db, AI, fetcher);
    expect(sent[0]).not.toContain('HDFC Regalia');
    expect(sent[0]).not.toContain('Savings');
    expect(sent[0]).toContain('CARD_BILL');
    expect(sent[0]).not.toContain('55555555');
    expect(out.picks.map((p) => [p.payee, p.label])).toEqual([['CRED Club', 'a credit card bill'], ['Fresh Mart', 'Groceries']]);
    // One card, so it points straight at it.
    expect(out.picks[0]!.categoryId).not.toBeNull();
    // The unsure answer is left unset.
    expect(out.picks.find((p) => p.payee === 'Mystery Co')).toBeUndefined();
  });
});
