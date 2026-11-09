import { createAccount, createSimpleTransaction, ensureStarterCategories, listAccounts, listAudit, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { ask, datesFor, setAskOn } from './ask.ts';

const AI = { provider: 'openai' as const, model: 'm', baseUrl: 'http://localhost:11434/v1' };
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  const bank = createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank', openingBalance: 1_00_000_00, openingDate: '2026-01-01' });
  createSimpleTransaction(db, { date: '2026-10-05', description: 'Dinner', payee: 'Spice Garden', kind: 'expense', accountId: bank.id, counterAccountId: listAccounts(db).find((a) => a.name === 'Food & Dining')!.id, amount: 1_500_00 } as never);
});

// A model that says what it is told to, one turn at a time, and keeps what it was sent.
function script(turns: string[]) {
  const sent: { system: string; user: string }[] = [];
  let i = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ system: body.messages[0].content, user: body.messages[1].content });
    return new Response(JSON.stringify({ choices: [{ message: { content: turns[Math.min(i++, turns.length - 1)] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

describe('asking a question', () => {
  it('is off until turned on', async () => {
    await expect(ask(db, AI, { question: 'hi' }, script(['{"answer":"x"}']).fetcher)).rejects.toThrow(/Turn on/);
  });

  it('looks things up with read-only tools and answers from what they return', async () => {
    setAskOn(db, true);
    const { fetcher, sent } = script([
      '{"tool":"get_accounts","arguments":{}}',
      '{"answer":"You have one account, Savings."}',
    ]);
    const result = await ask(db, AI, { question: 'What accounts do I have?' }, fetcher);
    expect(result).toMatchObject({ answer: 'You have one account, Savings.', steps: [{ tool: 'get_accounts', ok: true }], stoppedEarly: false });
    // The second turn was shown what the lookup returned.
    expect(sent[1]!.user).toContain('Savings');
    expect(sent[1]!.user).toContain('You called get_accounts');
    // The model was told only about read tools.
    expect(sent[0]!.system).toContain('- get_accounts:');
    expect(sent[0]!.system).not.toMatch(/^- propose_/m);
    // Each lookup is on record, under its own name.
    expect(listAudit(db).some((row) => row.actor === 'Ask Ledgerly' && row.tool === 'get_accounts')).toBe(true);
  });

  it('reads the first call when a model repeats itself or wraps it in a code fence', async () => {
    setAskOn(db, true);
    const { fetcher } = script([
      '{"tool":"get_accounts","arguments":{}}\n```json\n```\n\n{"tool":"get_accounts","arguments":{}}',
      'Here you go:\n```json\n{"answer":"One account, Savings {main}."}\n```',
    ]);
    const result = await ask(db, AI, { question: 'What accounts do I have?' }, fetcher);
    expect(result).toMatchObject({ answer: 'One account, Savings {main}.', steps: [{ tool: 'get_accounts', ok: true }] });
  });

  it('understands a call written as an invoke tag, and asks again when a call is unreadable', async () => {
    setAskOn(db, true);
    const { fetcher, sent } = script([
      '<invoke name="get_accounts">{}</invoke>\n\nWait, JSON only.\n<invoke name="get_accounts">\n</invoke>',
      '{"tool": get_accounts}',
      '{"answer":"One account."}',
    ]);
    const result = await ask(db, AI, { question: 'What accounts do I have?' }, fetcher);
    expect(result).toMatchObject({ answer: 'One account.', steps: [{ tool: 'get_accounts', ok: true }] });
    expect(sent[2]!.user).toContain('That was not valid');
  });

  it('refuses a tool that does not exist, including one that would change something', async () => {
    setAskOn(db, true);
    const { fetcher, sent } = script([
      '{"tool":"propose_rule","arguments":{"pattern":"x","categoryId":1}}',
      '{"tool":"delete_everything","arguments":{}}',
      '{"answer":"I could not do that."}',
    ]);
    const result = await ask(db, AI, { question: 'Make a rule' }, fetcher);
    expect(result.steps).toEqual([]);
    expect(sent[1]!.user).toContain('not one of the tools');
    expect(result.answer).toBe('I could not do that.');
  });

  it('stops after a few lookups and asks for an answer with what it has', async () => {
    setAskOn(db, true);
    const { fetcher } = script(['{"tool":"get_accounts","arguments":{}}', '{"tool":"get_accounts","arguments":{}}', '{"tool":"get_accounts","arguments":{}}', '{"tool":"get_accounts","arguments":{}}', '{"tool":"get_accounts","arguments":{}}', '{"tool":"get_accounts","arguments":{}}', '{"answer":"That is all I found."}']);
    const result = await ask(db, AI, { question: 'Loop' }, fetcher);
    expect(result.steps).toHaveLength(6);
    expect(result).toMatchObject({ stoppedEarly: true, answer: 'That is all I found.' });
  });

  it('copes with a lookup that fails, a plain-text reply, and carries earlier questions', async () => {
    setAskOn(db, true);
    const failing = script(['{"tool":"search_transactions","arguments":{"limit":"not a number"}}', '{"answer":"It did not work."}']);
    const failed = await ask(db, AI, { question: 'Search' }, failing.fetcher);
    expect(failed.steps).toMatchObject([{ tool: 'search_transactions', ok: false }]);
    expect(failing.sent[1]!.user).toContain('(failed)');

    const plain = await ask(db, AI, { question: 'Hello', history: [{ question: 'Q1', answer: 'A1' }] }, script(['Just a sentence, no JSON.']).fetcher);
    expect(plain.answer).toBe('Just a sentence, no JSON.');
    const withHistory = script(['{"answer":"ok"}']);
    await ask(db, AI, { question: 'Follow up', history: [{ question: 'First question', answer: 'First answer' }] }, withHistory.fetcher);
    expect(withHistory.sent[0]!.user).toContain('Earlier question: First question');
    await expect(ask(db, AI, { question: '   ' }, script(['{}']).fetcher)).rejects.toThrow(/Ask a question/);
  });
});

describe('datesFor', () => {
  it('works out last month and the financial year, across a year end', () => {
    expect(datesFor('2026-11-06')).toMatchObject({ lastMonth: '2026-10-01 to 2026-10-31', thisFinancialYear: '2026-04-01 to 2026-11-06' });
    expect(datesFor('2027-01-15')).toMatchObject({ lastMonth: '2026-12-01 to 2026-12-31', thisFinancialYear: '2026-04-01 to 2027-01-15' });
    expect(datesFor('2028-03-10').lastMonth).toBe('2028-02-01 to 2028-02-29');
  });
});
