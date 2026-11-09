import {
  createAccount,
  createApiToken,
  createSimpleTransaction,
  listAccounts,
  listAudit,
  listTransactions,
  seedDefaults,
} from '@ledgerly/core';
import { openDb, type Db } from '@ledgerly/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';

let app: FastifyInstance;
let db: Db;
let base: string;

const baseConfig: Config = { ...loadConfig({}), webDir: '/nonexistent' };

async function start(overrides: Partial<Config> = {}) {
  db = openDb(':memory:');
  seedDefaults(db);
  app = await buildApp(db, { ...baseConfig, ...overrides });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

const json = { 'content-type': 'application/json' };
const api = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(base + path, { ...init, headers: { ...(init.body ? json : {}), ...init.headers } });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
};

async function newToken(name: string, scope: 'read' | 'propose') {
  const created = await api('/api/agents/tokens', { method: 'POST', body: JSON.stringify({ name, scope }) });
  expect(created.status).toBe(201);
  return created.data as { id: number; token: string };
}

async function connect(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  return client;
}

const rawMcp = (headers: Record<string, string>) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...json, accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

const category = (name: string) => listAccounts(db).find((a) => a.name === name)!.id;

afterEach(async () => {
  await app?.close();
});

describe('MCP over HTTP', () => {
  beforeEach(() => start());

  it('serves an agent with a token, and records who asked', async () => {
    const { token } = await newToken('Claude', 'propose');
    const client = await connect(token);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['get_accounts', 'propose_rule']));

    const result = await client.callTool({ name: 'list_categories', arguments: {} });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).map((c: { name: string }) => c.name)).toContain('Groceries');
    expect(listAudit(db)[0]).toMatchObject({ actor: 'Claude', tool: 'list_categories', outcome: 'ok' });
    await client.close();
  });

  it('gives a read-only token no way to suggest anything', async () => {
    const { token } = await newToken('Reader', 'read');
    const client = await connect(token);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('search_transactions');
    expect(tools.some((name) => name.startsWith('propose_'))).toBe(false);
    await client.close();
  });

  it('turns away missing, wrong and revoked tokens', async () => {
    const { token, id } = await newToken('Temp', 'read');
    const none = await rawMcp({});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    expect((await rawMcp({ authorization: 'Bearer lg_nonsense' })).status).toBe(401);
    expect((await rawMcp({ authorization: `Bearer ${token}` })).status).toBe(200);

    expect((await api(`/api/agents/tokens/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await rawMcp({ authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it('refuses a request that comes from a web page, even with a valid token', async () => {
    const { token } = await newToken('Claude', 'read');
    const response = await rawMcp({ authorization: `Bearer ${token}`, origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('only accepts POST', async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(405);
  });

  it('never shows the token again after it is created', async () => {
    const { token } = await newToken('Claude', 'read');
    const list = await api('/api/agents/tokens');
    expect(JSON.stringify(list.data)).not.toContain(token);
    expect(list.data[0]).toMatchObject({ name: 'Claude', scope: 'read', tokenPrefix: token.slice(0, 9), revokedAt: null });
  });

  it('puts a suggestion in front of you, and applies it only when you approve', async () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 100000 }).id;
    const tx = createSimpleTransaction(db, { kind: 'expense', date: '2026-10-01', description: 'Ravi', payee: 'Ravi', accountId: bank, counterAccountId: category('Uncategorized'), amount: 500 });

    const { token } = await newToken('Claude', 'propose');
    const client = await connect(token);
    const made = await client.callTool({
      name: 'propose_transaction_categories',
      arguments: { items: [{ transactionId: tx.id, categoryId: category('Gifts & Donations'), reason: 'Personal payee' }] },
    });
    expect(made.isError).toBeFalsy();

    expect((await api('/api/agents/summary')).data).toEqual({ pending: 1 });
    const pending = (await api('/api/agents/proposals?status=pending')).data;
    expect(pending[0]).toMatchObject({ source: 'Claude', reason: 'Personal payee', from: 'Uncategorized', to: 'Gifts & Donations' });
    expect(listTransactions(db, { search: 'ravi' }).items[0]!.postings.map((p) => p.accountName)).toContain('Uncategorized');

    const approved = await api(`/api/agents/proposals/${pending[0].id}/approve`, { method: 'POST' });
    expect(approved.data.status).toBe('approved');
    expect(listTransactions(db, { search: 'ravi' }).items[0]!.postings.map((p) => p.accountName)).toContain('Gifts & Donations');
    expect((await api('/api/agents/summary')).data).toEqual({ pending: 0 });
    await client.close();
  });

  it('can turn suggestions down, and decide them all at once', async () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 100000 }).id;
    const ids = [1, 2, 3].map((n) =>
      createSimpleTransaction(db, { kind: 'expense', date: '2026-10-01', description: `Shop ${n}`, payee: `Shop ${n}`, accountId: bank, counterAccountId: category('Uncategorized'), amount: 100 }).id,
    );
    const { token } = await newToken('Claude', 'propose');
    const client = await connect(token);
    await client.callTool({ name: 'propose_transaction_categories', arguments: { items: ids.map((transactionId) => ({ transactionId, categoryId: category('Health') })) } });

    const first = (await api('/api/agents/proposals?status=pending')).data[0].id;
    expect((await api(`/api/agents/proposals/${first}/reject`, { method: 'POST' })).data.status).toBe('rejected');
    expect((await api(`/api/agents/proposals/${first}/approve`, { method: 'POST' })).status).toBe(409);

    const rest = await api('/api/agents/proposals/decide-all', { method: 'POST', body: JSON.stringify({ decision: 'approve' }) });
    expect(rest.data).toEqual({ done: 2, failed: 0 });
    expect((await api('/api/agents/activity')).data.some((entry: { tool: string }) => entry.tool === 'propose_transaction_categories')).toBe(true);
    await client.close();
  });
});

describe('who can manage agent access', () => {
  it('keeps the management API behind the login, whatever token an agent holds', async () => {
    await start({ authPassword: 'correct horse' });
    const { token } = createApiToken(db, { name: 'Claude', scope: 'propose' });

    const asAgent = await api('/api/agents/tokens', { headers: { authorization: `Bearer ${token}` } });
    expect(asAgent.status).toBe(401);
    expect((await api('/api/agents/tokens', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'x', scope: 'propose' }) })).status).toBe(401);

    // The agent endpoint takes a token and needs no login cookie.
    expect((await rawMcp({ authorization: `Bearer ${token}` })).status).toBe(200);
  });
});

describe('demo mode', () => {
  it('turns agent access off', async () => {
    await start({ demoMode: true });
    const created = await api('/api/agents/tokens', { method: 'POST', body: JSON.stringify({ name: 'x', scope: 'read' }) });
    expect(created.status).toBe(400);
    expect(created.data.error).toMatch(/demo/);
    expect((await rawMcp({ authorization: 'Bearer lg_anything' })).status).toBe(403);
  });
});
