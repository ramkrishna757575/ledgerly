import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitInvestmentImport, getInvestmentSample, seedDefaults, stageInvestmentStatement } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadAi, loadConfig } from './config.ts';

const local = { host: 'localhost:4310' };
let closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function start(env: Record<string, string> = {}, demo = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-analysis-'));
  const config = { ...loadConfig({ DATA_DIR: dataDir, DEMO_MODE: String(demo), ...env }), webDir: '/nonexistent' };
  const db = openDb(config.dbPath);
  seedDefaults(db);
  commitInvestmentImport(db, stageInvestmentStatement(db, getInvestmentSample('cdsl')!).id);
  const app = await buildApp(db, config);
  closers.push(() => app.close());
  return { app, config };
}

async function model(content: string) {
  let received = '';
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received = raw;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}/v1`, received: () => received };
}

describe('AI configuration', () => {
  it('is off unless a provider is chosen', () => {
    expect(loadAi({})).toEqual({ ai: null });
  });

  it('sets up each provider from its own settings', () => {
    expect(loadAi({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).ai).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'k' });
    expect(loadAi({ AI_PROVIDER: 'bedrock', AI_MODEL: 'm', AWS_BEARER_TOKEN_BEDROCK: 'b', AWS_REGION: 'ap-south-1' }).ai).toMatchObject({ provider: 'bedrock', apiKey: 'b', region: 'ap-south-1' });
    expect(loadAi({ AI_PROVIDER: 'openai', AI_MODEL: 'llama3', AI_BASE_URL: 'http://localhost:8080/v1' }).ai).toMatchObject({ provider: 'openai', model: 'llama3', baseUrl: 'http://localhost:8080/v1' });
  });

  it('explains what is missing instead of failing to start', () => {
    expect(loadAi({ AI_PROVIDER: 'anthropic' }).aiProblem).toMatch(/ANTHROPIC_API_KEY/);
    expect(loadAi({ AI_PROVIDER: 'bedrock', AWS_BEARER_TOKEN_BEDROCK: 'b' }).aiProblem).toMatch(/AI_MODEL/);
    expect(loadAi({ AI_PROVIDER: 'openai' }).aiProblem).toMatch(/AI_MODEL/);
    expect(loadAi({ AI_PROVIDER: 'nope' }).aiProblem).toMatch(/must be one of/);
    expect(loadAi({ AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_BASE_URL: 'ftp://x' }).aiProblem).toMatch(/http/);
  });

  it('never sets one up in demo mode', () => {
    expect(loadConfig({ DEMO_MODE: 'true', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).ai).toBeNull();
  });
});

describe('analysis routes', () => {
  it('shows the calculated review with or without an AI provider, and never exposes the key', async () => {
    const { app } = await start({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-very-secret' });
    const res = await app.inject({ url: '/api/analysis', headers: local });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('sk-very-secret');
    const body = res.json();
    expect(body.ai).toMatchObject({ configured: true, provider: 'anthropic', destination: { host: 'api.anthropic.com', local: false } });
    expect(body.review.hasPortfolio).toBe(true);
    expect(body.surplus.status).toBe('unknown');
  });

  it('saves the buffer and a target, and rejects a target that does not add up', async () => {
    const { app } = await start();
    const ok = await app.inject({ method: 'PUT', url: '/api/analysis/settings', headers: local, payload: { bufferMonths: 9, target: { equity: 70, debt: 30 } } });
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/analysis', headers: local })).json()).toMatchObject({ bufferMonths: 9, target: { equity: 70, debt: 30 } });
    expect((await app.inject({ method: 'PUT', url: '/api/analysis/settings', headers: local, payload: { target: { equity: 70 } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/analysis/settings', headers: local, payload: { bufferMonths: 100 } })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/analysis/settings', headers: local, payload: { target: null } });
    expect((await app.inject({ url: '/api/analysis', headers: local })).json().target).toBeNull();
  });

  it('previews exactly what a review would send, before anything is sent', async () => {
    const { app } = await start({ AI_PROVIDER: 'openai', AI_MODEL: 'm' });
    const preview = (await app.inject({ url: '/api/analysis/preview', headers: local })).json();
    expect(preview.destination).toEqual({ host: 'localhost:11434', local: true });
    expect(preview.snapshot.portfolio.holdings).toHaveLength(3);
  });

  it('runs a review against the configured model and keeps it in the history', async () => {
    const answer = JSON.stringify({ summary: 'All fine.', surplus: { assessment: 'ok', options: [] }, portfolio: { observations: [], questionsToConsider: [] }, caveats: [] });
    const fake = await model(answer);
    const { app } = await start({ AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_BASE_URL: fake.base });

    const run = await app.inject({ method: 'POST', url: '/api/analysis/run', headers: local, payload: {} });
    expect(run.statusCode).toBe(201);
    expect(run.json().result.summary).toBe('All fine.');
    expect(fake.received()).toContain('Sample Index Fund');

    const state = (await app.inject({ url: '/api/analysis', headers: local })).json();
    expect(state.history).toHaveLength(1);
    const again = (await app.inject({ url: `/api/analysis/history/${state.history[0].id}`, headers: local })).json();
    expect(again.snapshot.portfolio.holdings).toHaveLength(3);
    expect((await app.inject({ url: '/api/analysis/history/999', headers: local })).statusCode).toBe(404);
  });

  it('refuses to run with no provider, and in demo mode', async () => {
    const { app } = await start();
    const none = await app.inject({ method: 'POST', url: '/api/analysis/run', headers: local, payload: {} });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toMatch(/No AI provider/);

    const demo = await start({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }, true);
    expect((await demo.app.inject({ method: 'POST', url: '/api/analysis/run', headers: local, payload: {} })).json().error).toMatch(/demo mode/);
    expect((await demo.app.inject({ method: 'POST', url: '/api/analysis/market', headers: local })).statusCode).toBe(400);
  });
});

describe('balance check route', () => {
  it('reports accounts that disagree with a statement and matches them', async () => {
    const { app } = await start();
    expect((await app.inject({ url: '/api/analysis', headers: local })).json().balanceChecks).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/analysis/match-balance/1', headers: local })).statusCode).toBe(404);
  });
});

describe('assets routes', () => {
  it('adds, values and removes an asset', async () => {
    const { app } = await start();
    const created = await app.inject({ method: 'POST', url: '/api/assets', headers: local, payload: { name: 'Gold coins', kind: 'gold', value: 2_00_000_00 } });
    expect(created.statusCode).toBe(201);
    const id = created.json().accountId;
    expect((await app.inject({ url: '/api/assets', headers: local })).json()).toMatchObject({ total: 2_00_000_00, items: [{ name: 'Gold coins' }] });
    expect((await app.inject({ method: 'PUT', url: `/api/assets/${id}/value`, headers: local, payload: { value: 2_20_000_00 } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/assets', headers: local })).json().total).toBe(2_20_000_00);
    expect((await app.inject({ method: 'POST', url: '/api/assets', headers: local, payload: { name: 'X', kind: 'bonds', value: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/assets/${id}`, headers: local })).statusCode).toBe(204);
  });
});

describe('forecast route', () => {
  it('returns a projection, and rejects a silly horizon', async () => {
    const { app } = await start();
    const res = await app.inject({ url: '/api/forecast?days=30', headers: local });
    expect(res.json()).toMatchObject({ days: 30, includesEverydaySpending: false });
    expect(res.json().points).toHaveLength(31);
    expect((await app.inject({ url: '/api/forecast?days=9999', headers: local })).statusCode).toBe(400);
  });
});

describe('tax routes', () => {
  it('returns a summary and saves which categories count toward a section', async () => {
    const { app } = await start();
    const first = (await app.inject({ url: '/api/tax?fy=2026-27', headers: local })).json();
    // The sample statement sells units it has no earlier purchase for, so the cost is unknown.
    expect(first).toMatchObject({ fy: '2026-27', gains: { complete: false } });
    const insurance = first.categories.find((c: { name: string }) => c.name === 'Insurance');
    expect((await app.inject({ method: 'PUT', url: '/api/tax/sections', headers: local, payload: { map: { [insurance.id]: '80C' } } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/tax?fy=2026-27', headers: local })).json().map).toEqual({ [insurance.id]: '80C' });
    expect((await app.inject({ url: '/api/tax?fy=2026', headers: local })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/tax/sections', headers: local, payload: { map: { 1: '80Z' } } })).statusCode).toBe(400);
  });
});

describe('goal routes', () => {
  it('adds, lists, edits and removes a goal', async () => {
    const { app } = await start();
    const created = await app.inject({ method: 'POST', url: '/api/goals', headers: local, payload: { name: 'Trip', targetAmount: 50_000_00, savedByHand: 10_000_00 } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await app.inject({ url: '/api/goals', headers: local })).json()).toMatchObject([{ name: 'Trip', current: 10_000_00, remaining: 40_000_00 }]);
    expect((await app.inject({ method: 'PUT', url: `/api/goals/${id}`, headers: local, payload: { name: 'Trip', targetAmount: 50_000_00, savedByHand: 50_000_00 } })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/goals', headers: local })).json()[0].done).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/goals', headers: local, payload: { name: '', targetAmount: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/goals/${id}`, headers: local })).statusCode).toBe(204);
  });
});

describe('split route', () => {
  it('splits a transaction and refuses parts that do not add up', async () => {
    const { app } = await start();
    const accounts = (await app.inject({ url: '/api/accounts', headers: local })).json();
    const bank = await app.inject({ method: 'POST', url: '/api/accounts', headers: local, payload: { name: 'Bank', type: 'asset', subtype: 'bank' } });
    const food = accounts.find((a: { name: string }) => a.name === 'Groceries');
    const shop = accounts.find((a: { name: string }) => a.name === 'Shopping');
    const tx = await app.inject({ method: 'POST', url: '/api/transactions/simple', headers: local, payload: { date: '2026-10-01', description: 'Mall', kind: 'expense', accountId: bank.json().id, counterAccountId: food.id, amount: 1_000_00 } });
    const id = tx.json().id;
    const bad = await app.inject({ method: 'POST', url: `/api/transactions/${id}/split`, headers: local, payload: { parts: [{ categoryId: food.id, amount: 1 }] } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/transactions/${id}/split`, headers: local, payload: { parts: [{ categoryId: food.id, amount: 600_00 }, { categoryId: shop.id, amount: 400_00 }] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().postings).toHaveLength(3);
  });
});

describe('SIP route', () => {
  it('lists plans, empty when there are none', async () => {
    const { app } = await start();
    expect((await app.inject({ url: '/api/investments/sips', headers: local })).json()).toEqual({ plans: [], monthlyTotal: 0 });
  });
});

describe('loan and policy routes', () => {
  it('adds, lists and removes them', async () => {
    const { app } = await start();
    const loan = await app.inject({ method: 'POST', url: '/api/loans', headers: local, payload: { name: 'Car', principal: 5_00_000_00, rateBps: 900, tenureMonths: 60, firstEmiDate: '2026-01-05' } });
    expect(loan.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/loans', headers: local })).json()[0]).toMatchObject({ name: 'Car', instalmentsLeft: expect.any(Number) });
    expect((await app.inject({ method: 'DELETE', url: `/api/loans/${loan.json().id}`, headers: local })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/loans', headers: local, payload: { name: '', principal: 1 } })).statusCode).toBe(400);

    const policy = await app.inject({ method: 'POST', url: '/api/policies', headers: local, payload: { name: 'Term', kind: 'term', premium: 12_000_00, frequency: 'yearly', nextDue: '2027-01-15' } });
    expect(policy.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/policies', headers: local })).json()).toMatchObject([{ name: 'Term', premiumPerYear: 12_000_00 }]);
    expect((await app.inject({ method: 'DELETE', url: `/api/policies/${policy.json().id}`, headers: local })).statusCode).toBe(204);
  });
});

describe('rules with conditions', () => {
  it('saves an amount range and an account, and rejects a backwards range', async () => {
    const { app } = await start();
    const accounts = (await app.inject({ url: '/api/accounts', headers: local })).json();
    const food = accounts.find((a: { name: string }) => a.name === 'Groceries');
    const ok = await app.inject({ method: 'POST', url: '/api/rules', headers: local, payload: { pattern: 'bigbasket', categoryId: food.id, minAmount: 1_000_00, maxAmount: 9_000_00 } });
    expect(ok.statusCode).toBe(201);
    expect((await app.inject({ url: '/api/rules', headers: local })).json()).toMatchObject([{ pattern: 'bigbasket', minAmount: 1_000_00, maxAmount: 9_000_00, accountId: null }]);
    const bad = await app.inject({ method: 'POST', url: '/api/rules', headers: local, payload: { pattern: 'other', categoryId: food.id, minAmount: 500, maxAmount: 100 } });
    expect(bad.statusCode).toBe(400);
    const preview = await app.inject({ method: 'POST', url: '/api/rules/preview', headers: local, payload: { pattern: 'bigbasket', minAmount: 1_000_00 } });
    expect(preview.statusCode).toBe(200);
  });
});

describe('rule health route', () => {
  it('returns problems, empty for a tidy set', async () => {
    const { app } = await start();
    expect((await app.inject({ url: '/api/rules/health', headers: local })).json()).toEqual([]);
  });
});

describe('AI category suggestion routes', () => {
  it('shows what would be sent, stays off until turned on, and runs against the model', async () => {
    const answer = '[]';
    const fake = await model(answer);
    const { app } = await start({ AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_BASE_URL: fake.base });
    const first = (await app.inject({ url: '/api/ai/categorize', headers: local })).json();
    expect(first).toMatchObject({ enabled: false, configured: true, destination: { local: true } });
    expect(first.send.spendingCategories).toContain('Groceries');
    const early = await app.inject({ method: 'POST', url: '/api/ai/categorize/run', headers: local });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toMatch(/Turn on/);
    await app.inject({ method: 'PUT', url: '/api/ai/categorize', headers: local, payload: { on: true } });
    expect((await app.inject({ url: '/api/ai/categorize', headers: local })).json().enabled).toBe(true);
    const run = await app.inject({ method: 'POST', url: '/api/ai/categorize/run', headers: local });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ sent: 0, proposed: 0 });
  });
});

describe('ask routes', () => {
  it('stay off until turned on, then answer from the model', async () => {
    const fake = await model('{"answer":"You hold three funds."}');
    const { app } = await start({ AI_PROVIDER: 'openai', AI_MODEL: 'm', AI_BASE_URL: fake.base });
    expect((await app.inject({ url: '/api/ai/ask', headers: local })).json()).toMatchObject({ enabled: false, configured: true });
    const early = await app.inject({ method: 'POST', url: '/api/ai/ask', headers: local, payload: { question: 'How many funds?' } });
    expect(early.statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/ai/ask', headers: local, payload: { on: true } });
    const answered = await app.inject({ method: 'POST', url: '/api/ai/ask', headers: local, payload: { question: 'How many funds?' } });
    expect(answered.json()).toMatchObject({ answer: 'You hold three funds.', steps: [] });
    expect((await app.inject({ method: 'POST', url: '/api/ai/ask', headers: local, payload: { question: 'x'.repeat(600) } })).statusCode).toBe(400);
  });
});
