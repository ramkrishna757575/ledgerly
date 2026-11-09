import { openDb, type Db } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedDefaults } from '../index.ts';
import { stageStatement, getImportBatch } from './batches.ts';
import { aiParsersOn, learnParser, maskSample, recipeIn, setAiParsers } from './learn.ts';
import { compile, learnedAdapters, listLearned, parseWithRecipe, recipeSchema } from './learned.ts';

const AI = { provider: 'openai' as const, model: 'm', baseUrl: 'http://localhost:11434/v1' };
const file = (n: string) => ({ sha256: n, filename: `${n}.pdf`, mimeType: 'application/pdf', size: 1, storedName: `${n}.pdf` });

// A made-up bank: debit and credit columns, running balance, account number printed.
const STATEMENT = (balances: number[]) => `Zeta Bank Ltd
Account No: 5010099887766 ending 4321
Date        Narration                          Debit       Credit      Balance
01/09/2026  UPI/Spice Garden/12345              1,500.00                ${balances[0]!.toFixed(2)}
03/09/2026  SALARY SEP                                      80,000.00   ${balances[1]!.toFixed(2)}
05/09/2026  ATM WDL Andheri                     2,000.00                ${balances[2]!.toFixed(2)}
09/09/2026  NEFT to Rent                       25,000.00                ${balances[3]!.toFixed(2)}
Page 1 of 1`;
const GOOD = STATEMENT([98_500, 178_500, 176_500, 151_500]).replace('Date ', 'Opening Balance   100,000.00\nDate ');

const RECIPE = {
  bank: 'Zeta Bank',
  accountKind: 'bank',
  detect: ['zeta bank', 'narration'],
  row: '^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s{2,}(?:(?<debit>[\\d,]+\\.\\d{2})\\s+(?<credit>[\\d,]+\\.\\d{2})?|\\s+(?<credit2>[\\d,]+\\.\\d{2}))\\s+(?<balance>[\\d,]+\\.\\d{2})$',
};
// Simpler and what a model would more likely write: separate expressions are not possible, so use optional groups.
const GOOD_ROW = '^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s{2,}(?<amount>[\\d,]+\\.\\d{2})\\s+(?<balance>[\\d,]+\\.\\d{2})$';

function script(replies: unknown[]) {
  let i = 0;
  const sent: string[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)).messages[1].content);
    const reply = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
});

describe('teaching Ledgerly a statement layout', () => {
  it('is off until turned on', async () => {
    expect(aiParsersOn(db)).toBe(false);
    await expect(learnParser(db, AI, GOOD, script([{}]).fetcher)).rejects.toThrow(/Turn on/);
  });

  it('keeps a recipe that reads the statement and agrees with its running balance, then reads later statements without the model', async () => {
    setAiParsers(db, true);
    const { fetcher, sent } = script([{ ...RECIPE, row: GOOD_ROW, opening: 'Opening Balance\\s+([\\d,]+\\.\\d{2})', last4: 'ending\\s+(\\d{4})' }]);
    const result = await learnParser(db, AI, GOOD, fetcher);
    expect(result).toMatchObject({ bank: 'Zeta Bank', rows: 4, checked: true });
    // The account number was blanked before it was sent.
    expect(sent[0]).not.toContain('5010099887766');
    expect(sent[0]).toContain('ending 4321');
    expect(listLearned(db)).toHaveLength(1);

    // A different month, no model involved.
    const next = GOOD.replaceAll('/09/', '/10/');
    const staged = stageStatement(db, { text: next, file: file('oct'), createAccount: true });
    const batch = getImportBatch(db, staged.id);
    expect(batch).toMatchObject({ bank: 'Zeta Bank', reconciliation: 'ok', accountLast4: '4321' });
    expect(batch!.items).toHaveLength(4);
    expect(batch!.items.map((r) => r.amount)).toEqual([-1_500_00, 80_000_00, -2_000_00, -25_000_00]);
  });

  it('flags a later statement whose balance does not add up instead of trusting the recipe', async () => {
    setAiParsers(db, true);
    await learnParser(db, AI, GOOD, script([{ ...RECIPE, row: GOOD_ROW, opening: 'Opening Balance\\s+([\\d,]+\\.\\d{2})' }]).fetcher);
    const broken = STATEMENT([98_500, 178_500, 100_000, 151_500]);
    const staged = stageStatement(db, { text: broken, file: file('bad'), createAccount: true });
    expect(getImportBatch(db, staged.id)!.reconciliation).toBe('mismatch');
  });

  it('asks again with what went wrong, and gives up with a clear message', async () => {
    setAiParsers(db, true);
    const wrong = { ...RECIPE, row: '^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>X+)\\s+(?<amount>\\d+)$' };
    const { fetcher, sent } = script([wrong, wrong, wrong]);
    await expect(learnParser(db, AI, GOOD, fetcher)).rejects.toThrow(/Could not work out/);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toContain('matched 0 lines');
    expect(listLearned(db)).toHaveLength(0);
  });

  it('flips directions the balance proves are backwards', async () => {
    setAiParsers(db, true);
    // One amount column with no Dr/Cr: the model reads every amount as positive.
    const text = `Zeta Bank\nDate  Narration  Amount  Balance\n01/09/2026  COFFEE   100.00   900.00\n02/09/2026  LUNCH   200.00   700.00\n03/09/2026  TAXI   50.00   650.00\n04/09/2026  SALARY  1,000.00   1,650.00`;
    const recipe = { bank: 'Zeta Bank', accountKind: 'bank', detect: ['zeta bank', 'narration'], row: '^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>[\\d,]+\\.\\d{2})\\s+(?<balance>[\\d,]+\\.\\d{2})$' };
    // Positive amounts read as credits, so the balance disagrees until the signs are flipped; salary then breaks it.
    await expect(learnParser(db, AI, text, script([recipe]).fetcher)).rejects.toThrow();
  });
});

describe('recipes are plain data and are checked', () => {
  it('finds the recipe in a reply that explains itself and fences the answer', () => {
    const reply = 'Spacing varies {a bit}.\n```json\n' + JSON.stringify({ ...RECIPE, row: GOOD_ROW }) + '\n```\nThat should work.';
    expect(recipeIn(reply)?.bank).toBe('Zeta Bank');
    expect(recipeIn('no json here')).toBeUndefined();
  });

  it('refuses patterns that can run away', () => {
    expect(() => compile('(a+)+b')).toThrow(/repeats a repeat/);
    expect(() => compile('(a)\\1')).toThrow(/not allowed/);
    expect(() => compile('(?<=a)b')).toThrow(/not allowed/);
  });

  it('masks long numbers and emails before anything is sent', () => {
    expect(maskSample('Acct 5010099887766 mail a.b@c.com ref 12345')).toBe('Acct XXXXXXXXXXXXX mail EMAIL ref 12345');
  });

  it('reads credit card charges as money out unless marked Cr', () => {
    const recipe = recipeSchema.parse({ bank: 'Zeta', accountKind: 'credit_card', detect: ['zeta', 'card'], row: '^(?<date>\\d{2}/\\d{2}/\\d{4})\\s+(?<description>.+?)\\s+(?<amount>[\\d,]+\\.\\d{2})\\s*(?<drcr>Cr|Dr)?$' });
    const out = parseWithRecipe(recipe, '01/09/2026  SHOP  500.00\n02/09/2026  PAYMENT RECEIVED  500.00 Cr', 'x');
    expect(out.rows.map((r) => r.amount)).toEqual([-500_00, 500_00]);
    expect(learnedAdapters(db)).toEqual([]);
  });
});
