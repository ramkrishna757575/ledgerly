import {
  aiCategorize,
  aiCategorizeOn,
  aiParsersOn,
  aiPayeePicks,
  aiPayeeSuggestions,
  aliasCount,
  applyPayeeAliases,
  payeeRows,
  textSuggestions,
  tidySnapshot,
  categorizeSnapshot,
  forgetLearned,
  listLearned,
  setAiParsers,
  getCategorizeLog,
  setAiCategorize,
  buildSnapshot,
  DomainError,
  describeDestination,
  fetchMarket,
  getAnalysis,
  getBufferMonths,
  getMarket,
  getTarget,
  listAnalyses,
  matchStatementBalance,
  statementBalanceChecks,
  portfolioReview,
  runAnalysis,
  setSetting,
  setTarget,
  surplusCash,
  BUFFER_KEY,
} from '@ledgerly/core';
import { monthlyOn, setMonthlyOn } from './monthly-note.ts';
import { ASSET_CLASSES, type Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ask, askOn, setAskOn } from './ask.ts';
import type { Config } from './config.ts';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const includeQuery = z.object({ includeMarket: z.enum(['true', 'false']).default('false') });
const settingsBody = z.object({
  bufferMonths: z.number().int().min(1).max(24).optional(),
  target: z.partialRecord(z.enum(ASSET_CLASSES), z.number()).nullable().optional(),
});

export function registerAnalysisRoutes(app: FastifyInstance, db: Db, config: Config) {
  const destination = () => (config.ai ? describeDestination(config.ai) : null);

  app.get('/api/analysis', async () => ({
    surplus: surplusCash(db),
    balanceChecks: statementBalanceChecks(db),
    review: portfolioReview(db),
    bufferMonths: getBufferMonths(db),
    target: getTarget(db),
    market: getMarket(db),
    ai: {
      configured: config.ai !== null,
      provider: config.ai?.provider ?? null,
      model: config.ai?.model ?? null,
      destination: destination(),
      problem: config.aiProblem ?? null,
    },
    history: listAnalyses(db),
  }));

  app.post('/api/analysis/match-balance/:id', async (request) => matchStatementBalance(db, idParams.parse(request.params).id));

  app.put('/api/analysis/settings', async (request, reply) => {
    const body = settingsBody.parse(request.body);
    if (body.bufferMonths !== undefined) setSetting(db, BUFFER_KEY, String(body.bufferMonths));
    if (body.target !== undefined) setTarget(db, body.target);
    return reply.code(204).send();
  });

  // Exactly what would be sent to the model, so it can be read first.
  app.get('/api/analysis/preview', async (request) => ({
    destination: destination(),
    snapshot: buildSnapshot(db, { includeMarket: includeQuery.parse(request.query).includeMarket === 'true' }),
  }));

  // Fetches public fund history. Only public scheme codes go out.
  app.post('/api/analysis/market', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async () => {
    if (config.demoMode) throw new DomainError('invalid', 'Market data is turned off in demo mode');
    return fetchMarket(db, { amfiUrl: config.amfiUrl, mfapiUrl: config.mfapiUrl });
  });

  app.post('/api/analysis/run', { config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!config.ai) {
      throw new DomainError('invalid', config.demoMode ? 'The AI review is turned off in demo mode' : 'No AI provider is set up yet');
    }
    const { includeMarket } = z.object({ includeMarket: z.boolean().default(false) }).parse(request.body ?? {});
    return reply.code(201).send(await runAnalysis(db, config.ai, { includeMarket }));
  });

  // Tidying payee names: spellings and cut-off names found by plain matching, and more from a
  // model if you turn it on (the same switch as category suggestions: the same kind of text goes out).
  app.get('/api/payees/tidy', async () => ({
    suggestions: textSuggestions(payeeRows(db)),
    renamedBefore: aliasCount(db),
    ai: { enabled: aiCategorizeOn(db), configured: config.ai !== null, destination: destination(), send: tidySnapshot(db).send },
  }));
  app.post('/api/payees/tidy/ai', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async () => {
    if (!config.ai) throw new DomainError('invalid', config.demoMode ? 'The AI features are turned off in demo mode' : 'No AI provider is set up yet');
    return aiPayeeSuggestions(db, config.ai);
  });
  app.post('/api/rules/payees/ai', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async () => {
    if (!config.ai) throw new DomainError('invalid', config.demoMode ? 'The AI features are turned off in demo mode' : 'No AI provider is set up yet');
    return aiPayeePicks(db, config.ai);
  });
  app.post('/api/payees/aliases', async (request) => applyPayeeAliases(db, (request.body as { pairs?: never[] })?.pairs ?? []));

  // A fresh check-in written each month without pressing anything. Off until you turn it on.
  app.get('/api/ai/monthly', async () => ({ enabled: monthlyOn(db) }));
  app.put('/api/ai/monthly', async (request, reply) => {
    setMonthlyOn(db, z.object({ on: z.boolean() }).parse(request.body).on);
    return reply.code(204).send();
  });

  app.get('/api/ai/status', async () => ({ configured: config.ai !== null, destination: destination() }));

  // Questions in plain words. Off until turned on, and read-only.
  app.get('/api/ai/ask', async () => ({ enabled: askOn(db), configured: config.ai !== null, destination: destination() }));
  app.put('/api/ai/ask', async (request, reply) => {
    setAskOn(db, z.object({ on: z.boolean() }).parse(request.body).on);
    return reply.code(204).send();
  });
  app.post('/api/ai/ask', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    if (!config.ai) throw new DomainError('invalid', config.demoMode ? 'The AI features are turned off in demo mode' : 'No AI provider is set up yet');
    const body = z.object({ question: z.string().max(500), history: z.array(z.object({ question: z.string().max(500), answer: z.string().max(2000) })).max(5).optional() }).parse(request.body);
    return ask(db, config.ai, body);
  });

  // Asking the model to place payees that rules could not. Off until you turn it on.
  app.get('/api/ai/categorize', async () => ({
    enabled: aiCategorizeOn(db),
    configured: config.ai !== null,
    destination: destination(),
    send: categorizeSnapshot(db).send,
    log: getCategorizeLog(db),
  }));
  app.put('/api/ai/categorize', async (request, reply) => {
    setAiCategorize(db, z.object({ on: z.boolean() }).parse(request.body).on);
    return reply.code(204).send();
  });
  app.post('/api/ai/categorize/run', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async () => {
    if (!config.ai) throw new DomainError('invalid', config.demoMode ? 'The AI features are turned off in demo mode' : 'No AI provider is set up yet');
    return aiCategorize(db, config.ai);
  });

  // Letting a model work out how to read a new bank's statements. Off until you turn it on.
  app.get('/api/ai/parsers', async () => ({
    enabled: aiParsersOn(db),
    configured: config.ai !== null,
    destination: destination(),
    learned: listLearned(db).map((l) => ({ id: l.id, bank: l.recipe.bank, kind: l.recipe.accountKind, learnedAt: l.learnedAt })),
  }));
  app.put('/api/ai/parsers', async (request, reply) => {
    setAiParsers(db, z.object({ on: z.boolean() }).parse(request.body).on);
    return reply.code(204).send();
  });
  app.delete('/api/ai/parsers/:id', async (request, reply) => {
    forgetLearned(db, z.object({ id: z.string().max(100) }).parse(request.params).id);
    return reply.code(204).send();
  });

  app.get('/api/analysis/history/:id', async (request) => getAnalysis(db, idParams.parse(request.params).id));
}
