import {
  approveProposal,
  authenticateToken,
  tenantOfToken,
  countPendingProposals,
  createApiToken,
  decideAll,
  DomainError,
  listApiTokens,
  listAudit,
  listProposals,
  rejectProposal,
  revokeApiToken,
  runAutoRules,
} from '@ledgerly/core';
import type { Db } from '@ledgerly/db';
import { createMcpServer } from '@ledgerly/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';
import { tenantStore, type Tenant } from './tenants.ts';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

export function registerAgentRoutes(app: FastifyInstance, db: Db, config: Config, resolveTenant?: (id: number) => Tenant | undefined) {
  // Managing agent access is for the person using the app, so these sit behind
  // the same login as the rest of /api. An agent's token cannot reach them.
  const demoOff = () => {
    if (config.demoMode) throw new DomainError('invalid', 'Agent access is turned off in the demo');
  };

  app.get('/api/agents/tokens', async () => listApiTokens(db));

  app.post('/api/agents/tokens', async (request, reply) => {
    demoOff();
    const { token, record } = createApiToken(db, request.body as never, tenantStore.getStore()?.id);
    return reply.code(201).send({ ...record, token });
  });

  app.delete('/api/agents/tokens/:id', async (request, reply) => {
    revokeApiToken(db, idParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get('/api/agents/summary', async () => ({ pending: countPendingProposals(db) }));

  app.get('/api/agents/proposals', async (request) => {
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'failed']).optional() }).parse(request.query);
    return listProposals(db, { status });
  });

  app.post('/api/agents/proposals/:id/approve', async (request) => {
    const result = approveProposal(db, idParams.parse(request.params).id);
    runAutoRules(db);
    return result;
  });
  app.post('/api/agents/proposals/:id/reject', async (request) => rejectProposal(db, idParams.parse(request.params).id));

  app.post('/api/agents/proposals/decide-all', async (request) => {
    const { decision, ids } = z
      .object({ decision: z.enum(['approve', 'reject']), ids: z.array(z.number().int().positive()).max(500).optional() })
      .parse(request.body);
    const outcome = decideAll(db, decision, ids);
    runAutoRules(db);
    return outcome;
  });

  app.get('/api/agents/activity', async () => listAudit(db, 100));

  // The agent endpoint. Every request needs a token, even on a machine that
  // otherwise needs no login, and a new server handles each request so there is
  // no session to hijack.
  app.post('/mcp', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (config.demoMode) return reply.code(403).send(rpcError(-32001, 'Agent access is turned off in the demo'));

    const header = request.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    // With several people on the server, the token says whose books it opens.
    const owner = resolveTenant ? resolveTenant(tenantOfToken(bearer) ?? -1) : undefined;
    if (resolveTenant && !owner) {
      return reply.code(401).header('www-authenticate', 'Bearer').send(rpcError(-32001, 'A valid access token is required'));
    }
    const books = owner?.db ?? db;
    const agent = authenticateToken(books, bearer);
    if (!agent) {
      return reply.code(401).header('www-authenticate', 'Bearer').send(rpcError(-32001, 'A valid access token is required'));
    }

    const server = createMcpServer(books, agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error(error);
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(JSON.stringify(rpcError(-32603, 'Internal error')));
      }
    }
  });

  const notAllowed = async (_request: unknown, reply: { code: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown } } }) =>
    reply.code(405).header('allow', 'POST').send(rpcError(-32000, 'Use POST'));
  app.get('/mcp', notAllowed as never);
  app.delete('/mcp', notAllowed as never);
}
