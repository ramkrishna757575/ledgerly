import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from '../accounts.ts';
import { commitInvestmentImport, getInvestmentSample, stageInvestmentStatement } from '../investments/index.ts';
import { ensureStarterCategories, seedDefaults } from '../seed.ts';
import { createSimpleTransaction } from '../transactions.ts';
import { complete, describeDestination, type AiConfig } from './llm.ts';
import { buildSnapshot, getAnalysis, listAnalyses, parseOutput, runAnalysis } from './run.ts';

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

type Seen = { url: string; headers: IncomingMessage['headers']; body: any };

async function fake(reply: (seen: Seen) => { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const entry = { url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') };
      seen.push(entry);
      const { status = 200, json } = reply(entry);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { seen, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const ANSWER = JSON.stringify({ summary: 'You have idle cash.', surplus: { assessment: 'Comfortable.', options: [{ title: 'Emergency fund', whenItFits: 'Always', tradeOffs: 'Low return' }] }, portfolio: { observations: ['Equity heavy'], questionsToConsider: ['Is that intended?'] }, caveats: ['Not advice'] });

describe('providers', () => {
  it('talks to Anthropic with the key in a header', async () => {
    const { seen, base } = await fake(() => ({ json: { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'there' }] } }));
    const text = await complete({ provider: 'anthropic', model: 'claude-x', apiKey: 'sk-secret', baseUrl: base }, { system: 'S', user: 'U' });
    expect(text).toBe('hello there');
    expect(seen[0]).toMatchObject({ url: '/v1/messages', body: { model: 'claude-x', system: 'S', messages: [{ role: 'user', content: 'U' }] } });
    expect(seen[0]!.headers['x-api-key']).toBe('sk-secret');
    expect(seen[0]!.headers['anthropic-version']).toBeTruthy();
    expect(JSON.stringify(seen[0]!.body)).not.toContain('sk-secret');
  });

  it('talks to Bedrock with a bearer token', async () => {
    const { seen, base } = await fake(() => ({ json: { output: { message: { content: [{ text: 'bedrock says hi' }] } } } }));
    const text = await complete({ provider: 'bedrock', model: 'anthropic.claude-x:0', apiKey: 'bk', baseUrl: base }, { system: 'S', user: 'U' });
    expect(text).toBe('bedrock says hi');
    expect(seen[0]!.url).toBe('/model/anthropic.claude-x%3A0/converse');
    expect(seen[0]!.headers.authorization).toBe('Bearer bk');
    expect(seen[0]!.body).toMatchObject({ system: [{ text: 'S' }], messages: [{ role: 'user', content: [{ text: 'U' }] }] });
  });

  it('talks to an OpenAI-compatible server such as Ollama or llama.cpp, with no key', async () => {
    const { seen, base } = await fake(() => ({ json: { choices: [{ message: { content: 'local answer' } }] } }));
    const text = await complete({ provider: 'openai', model: 'llama3', baseUrl: `${base}/v1` }, { system: 'S', user: 'U' });
    expect(text).toBe('local answer');
    expect(seen[0]!.url).toBe('/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  });

  it('turns failures into plain errors that never echo the key', async () => {
    const config: AiConfig = { provider: 'anthropic', model: 'm', apiKey: 'sk-secret' };
    const bad = await fake(() => ({ status: 401, json: { error: { message: 'invalid x-api-key' } } }));
    const error = await complete({ ...config, baseUrl: bad.base }, { system: 'S', user: 'U' }).catch((e) => e);
    expect(error.message).toMatch(/answered 401: invalid x-api-key.*Check the API key/);
    expect(error.message).not.toContain('sk-secret');

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const down = await complete({ ...config, baseUrl: bad.base }, { system: 'S', user: 'U' }).catch((e) => e);
    expect(down.message).toMatch(/Couldn't reach the AI provider/);
    expect(down.message).not.toContain('sk-secret');

    const empty = await fake(() => ({ json: { choices: [] } }));
    await expect(complete({ provider: 'openai', model: 'm', baseUrl: empty.base }, { system: 'S', user: 'U' })).rejects.toThrow(/empty/);
  });

  it('asks a server on your own machine not to spend the answer on thinking, and no one else', async () => {
    const { seen, base } = await fake(() => ({ json: { choices: [{ message: { content: 'ok' } }] } }));
    await complete({ provider: 'openai', model: 'm', baseUrl: `${base}/v1` }, { system: 's', user: 'u' });
    expect(seen[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });

    const hosted: Seen[] = [];
    await complete(
      { provider: 'openai', model: 'm', baseUrl: 'https://api.openai.com/v1' },
      { system: 's', user: 'u' },
      (async (_url: any, init: any) => {
        hosted.push({ url: '', headers: {}, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }) as typeof fetch,
    );
    expect(hosted[0]!.body.chat_template_kwargs).toBeUndefined();
  });

  it('says where data would go, and whether that is this machine', () => {
    expect(describeDestination({ provider: 'anthropic', model: 'm' })).toEqual({ host: 'api.anthropic.com', local: false });
    expect(describeDestination({ provider: 'bedrock', model: 'm', region: 'ap-south-1' })).toEqual({ host: 'bedrock-runtime.ap-south-1.amazonaws.com', local: false });
    expect(describeDestination({ provider: 'openai', model: 'm' })).toEqual({ host: 'localhost:11434', local: true });
    expect(describeDestination({ provider: 'openai', model: 'm', baseUrl: 'http://192.168.1.5:8080/v1' }).local).toBe(false);
  });
});

describe('analysis', () => {
  function setup() {
    const db = openDb(':memory:');
    seedDefaults(db);
    ensureStarterCategories(db);
    const bank = createAccount(db, { name: 'Axis Savings 4821 Ramkrishna', type: 'asset', subtype: 'bank', numberLast4: '4821', openingBalance: 5_00_000_00, openingDate: '2026-01-01' });
    const rent = listAccounts(db).find((a) => a.name === 'Rent')!;
    for (const m of ['08', '09', '10']) {
      createSimpleTransaction(db, { date: `2026-${m}-03`, description: 'NEFT-LANDLORD SHARMA', payee: 'Landlord Sharma', kind: 'expense', accountId: bank.id, counterAccountId: rent.id, amount: 20_000_00 } as never);
    }
    commitInvestmentImport(db, stageInvestmentStatement(db, getInvestmentSample('cdsl')!).id);
    return db;
  }

  it('shows the model only a short summary, with no account, payee or transaction detail', () => {
    const text = JSON.stringify(buildSnapshot(setup(), { today: '2026-11-10' }));
    expect(text).not.toMatch(/4821|Ramkrishna|Axis Savings|Landlord|SHARMA|NEFT/i);
    const snapshot = buildSnapshot(setup(), { today: '2026-11-10' });
    expect(snapshot.spending).toMatchObject({ monthsOfHistory: 3, averageMonthlySpending: 20_000 });
    expect(snapshot.emergencyBuffer).toMatchObject({ status: 'surplus', monthsOfSpendingKept: 6, bufferRupees: 120_000 });
    expect(snapshot.portfolio?.holdings).toHaveLength(3);
    expect(snapshot.market).toBeNull();
  });

  it('runs a review, stores exactly what was sent, and lists it afterwards', async () => {
    const db = setup();
    const { seen, base } = await fake(() => ({ json: { choices: [{ message: { content: `Here you go:\n${ANSWER}` } }] } }));
    const run = await runAnalysis(db, { provider: 'openai', model: 'llama3', baseUrl: `${base}/v1` }, { today: '2026-11-10' });

    expect(run.result?.summary).toBe('You have idle cash.');
    expect(run.destination).toMatch(/127\.0\.0\.1:\d+ \(this machine\)/);
    expect(seen[0]!.body.messages[0].content).toMatch(/not a licensed or SEBI-registered adviser/);
    expect(seen[0]!.body.messages[1].content).toContain(JSON.stringify(run.snapshot, null, 2));

    expect(getAnalysis(db, run.id).snapshot).toEqual(run.snapshot);
    expect(listAnalyses(db)).toMatchObject([{ id: run.id, summary: 'You have idle cash.' }]);
  });

  it('keeps an answer that is not the requested JSON, as plain text', async () => {
    const db = setup();
    const { base } = await fake(() => ({ json: { choices: [{ message: { content: 'I could not format this, but you look fine.' } }] } }));
    const run = await runAnalysis(db, { provider: 'openai', model: 'm', baseUrl: `${base}/v1` });
    expect(run.result).toBeNull();
    expect(run.raw).toContain('you look fine');
    expect(parseOutput('{"summary": 5}')).toBeNull();
    expect(parseOutput('{"summary":"ok"}')).toMatchObject({ summary: 'ok', caveats: [] });
    // A priority can point at one page of the app; an unknown page is dropped, not an error.
    const out = parseOutput('{"summary":"ok","priorities":[{"title":"a","open":"rules"},{"title":"b","open":"/etc/passwd"}]}');
    expect(out?.priorities.map((p) => p.open)).toEqual(['rules', undefined]);
  });
});
