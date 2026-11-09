import { describe, expect, it } from 'vitest';
import { complete } from './llm.ts';
import { compareReceipt, readReceipt } from './receipt.ts';

const IMAGE = { mediaType: 'image/png' as const, base64: 'aGVsbG8=' };
const fetcherFor = (content: string, seen: unknown[] = []) =>
  (async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content } }], content: [{ type: 'text', text: content }], output: { message: { content: [{ text: content }] } } }), { status: 200 });
  }) as unknown as typeof fetch;

describe('sending a picture to each kind of model', () => {
  it('uses each provider\'s own shape for an image', async () => {
    const seen: any[] = [];
    await complete({ provider: 'anthropic', model: 'm', apiKey: 'k' }, { system: 'S', user: 'U', images: [IMAGE] }, fetcherFor('ok', seen));
    await complete({ provider: 'openai', model: 'm' }, { system: 'S', user: 'U', images: [IMAGE] }, fetcherFor('ok', seen));
    await complete({ provider: 'bedrock', model: 'm', apiKey: 'k' }, { system: 'S', user: 'U', images: [IMAGE] }, fetcherFor('ok', seen));
    expect(seen[0].messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
    expect(seen[1].messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } });
    expect(seen[2].messages[0].content[0]).toEqual({ image: { format: 'png', source: { bytes: 'aGVsbG8=' } } });
  });

  it('sends plain text as before when there is no picture', async () => {
    const seen: any[] = [];
    await complete({ provider: 'anthropic', model: 'm', apiKey: 'k' }, { system: 'S', user: 'U' }, fetcherFor('ok', seen));
    expect(seen[0].messages[0].content).toBe('U');
  });
});

describe('reading a receipt', () => {
  it('returns what was read, tolerating a wrapped answer, and refuses nonsense', async () => {
    const ai = { provider: 'openai' as const, model: 'm' };
    const read = await readReceipt(ai, IMAGE, fetcherFor('Sure:\n{"vendor":"Big Bazaar","date":"2026-10-04","total":1234.5,"currency":"INR","confidence":0.9}'));
    expect(read).toEqual({ vendor: 'Big Bazaar', date: '2026-10-04', total: 1234.5, currency: 'INR', confidence: 0.9 });
    const partial = await readReceipt(ai, IMAGE, fetcherFor('{"vendor":null,"date":"not a date","total":"abc"}'));
    expect(partial).toMatchObject({ vendor: null, date: null, total: null, confidence: 0 });
    await expect(readReceipt(ai, IMAGE, fetcherFor('I cannot read that'))).rejects.toThrow(/could not read/);
  });

  it('compares it with the transaction without changing anything', () => {
    const tx = { date: '2026-10-05', amount: 1_234_50, payee: 'BIG BAZAAR KORAMANGALA', description: 'UPI/BIGBAZAAR' };
    expect(compareReceipt({ vendor: 'Big Bazaar', date: '2026-10-04', total: 1234.5, currency: 'INR', confidence: 1 }, tx)).toEqual({ amount: true, amountDifference: 0, date: true, vendor: true });
    expect(compareReceipt({ vendor: 'Other Shop', date: '2026-09-01', total: 999, currency: 'INR', confidence: 1 }, tx)).toEqual({ amount: false, amountDifference: 999_00 - 1_234_50, date: false, vendor: false });
    expect(compareReceipt({ vendor: null, date: null, total: null, currency: 'INR', confidence: 0 }, tx)).toEqual({ amount: null, amountDifference: null, date: null, vendor: null });
  });
});
