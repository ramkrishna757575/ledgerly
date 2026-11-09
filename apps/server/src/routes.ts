import {
  DomainError,
  addAlert,
  dismissAlert,
  getAutoAdd,
  listAlertEntries,
  setAutoAdd,
  hideSetup,
  setupProgress,
  statementCoverage,
  ensureStarterCategories,
  seedDefaults,
  accrueDeposits,
  archiveAccount,
  ruleHealth,
  createLoan,
  createPolicy,
  deleteLoan,
  deletePolicy,
  listLoans,
  listPolicies,
  createGoal,
  deleteGoal,
  listGoals,
  splitTransaction,
  updateGoal,
  fySchema,
  SECTIONS,
  setSectionMap,
  taxSummary,
  pruneOrphanDocuments,
  forecast,
  createAsset,
  deleteAsset,
  listAssets,
  updateAssetValue,
  createCategory,
  listCategories,
  mergeCategory,
  hideRecurring,
  recurringPayments,
  showRecurring,
  summarizeRecurring,
  budgetStatus,
  deleteBudget,
  monthSchema,
  setBudget,
  suggestBudgets,
  createAccount,
  deleteAccount,
  createSimpleTransaction,
  createTransaction,
  AUTO_RULE_MODES,
  applyCategoryToSimilar,
  categoryTrend,
  computeInsights,
  dismissInsight,
  fixInsight,
  getAutoRuleMode,
  runAutoRules,
  setAutoRuleMode,
  netWorthHistory,
  overview,
  periodSchema,
  periodSummary,
  rangeSchema,
  spendingByCategory,
  topPayees,
  setTransactionCategory,
  dateSchema,
  deleteTransaction,
  resetDemoData,
  getBalances,
  getCashFlow,
  getNetWorth,
  getTransaction,
  listTransactions,
  unarchiveAccount,
  updateAccount,
  updateTransaction,
} from '@ledgerly/core';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@ledgerly/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.ts';

const idParams = z.object({ id: z.coerce.number().int().positive() });
const asOfQuery = z.object({ asOf: dateSchema.optional() });

export function registerRoutes(app: FastifyInstance, db: Db, config: Config) {
  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/insights', async () => computeInsights(db));
  // Transactions the bank announced by email, before any statement has them.
  app.get('/api/bank-alerts', async () => ({ auto: getAutoAdd(db), items: listAlertEntries(db) }));
  app.post('/api/bank-alerts/:id/add', async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const { accountId } = z.object({ accountId: z.number().int().positive().optional() }).parse(request.body ?? {});
    return addAlert(db, id, accountId);
  });
  app.post('/api/bank-alerts/:id/dismiss', async (request, reply) => {
    dismissAlert(db, z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id);
    return reply.code(204).send();
  });
  app.put('/api/bank-alerts/settings', async (request, reply) => {
    setAutoAdd(db, z.object({ auto: z.boolean() }).parse(request.body).auto);
    return reply.code(204).send();
  });

  app.get('/api/setup', async () => setupProgress(db));
  app.post('/api/setup/hide', async (_request, reply) => {
    hideSetup(db);
    return reply.code(204).send();
  });
  app.get('/api/imports/coverage', async () => statementCoverage(db));

  const monthQuery = z.object({ month: monthSchema.optional() });
  app.get('/api/forecast', async (request) => forecast(db, { days: z.coerce.number().int().min(7).max(365).default(60).parse((request.query as { days?: string }).days) }));

  app.get('/api/tax', async (request) => taxSummary(db, fySchema.optional().parse((request.query as { fy?: string }).fy)));
  app.put('/api/tax/sections', async (request, reply) => {
    const { map } = z.object({ map: z.record(z.string(), z.enum(Object.keys(SECTIONS) as [string, ...string[]]).nullable()) }).parse(request.body);
    setSectionMap(db, map as never);
    return reply.code(204).send();
  });

  app.post('/api/transactions/:id/split', async (request) => splitTransaction(db, idParams.parse(request.params).id, (request.body as { parts?: never })?.parts ?? []));

  app.get('/api/goals', async () => listGoals(db));
  app.post('/api/goals', async (request, reply) => reply.code(201).send({ id: createGoal(db, request.body as never) }));
  app.put('/api/goals/:id', async (request, reply) => {
    updateGoal(db, idParams.parse(request.params).id, request.body as never);
    return reply.code(204).send();
  });
  app.delete('/api/goals/:id', async (request, reply) => {
    deleteGoal(db, idParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get('/api/loans', async () => listLoans(db));
  app.post('/api/loans', async (request, reply) => reply.code(201).send({ id: createLoan(db, request.body as never) }));
  app.delete('/api/loans/:id', async (request, reply) => {
    deleteLoan(db, idParams.parse(request.params).id);
    return reply.code(204).send();
  });
  app.get('/api/policies', async () => listPolicies(db));
  app.post('/api/policies', async (request, reply) => reply.code(201).send({ id: createPolicy(db, request.body as never) }));
  app.delete('/api/policies/:id', async (request, reply) => {
    deletePolicy(db, idParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get('/api/assets', async () => {
    accrueDeposits(db);
    return listAssets(db);
  });
  app.post('/api/assets', async (request, reply) => reply.code(201).send({ accountId: createAsset(db, request.body as never) }));
  app.put('/api/assets/:id/value', async (request, reply) => {
    updateAssetValue(db, idParams.parse(request.params).id, request.body as never);
    return reply.code(204).send();
  });
  app.delete('/api/assets/:id', async (request, reply) => {
    deleteAsset(db, idParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get('/api/rules/health', async () => ruleHealth(db));

  app.get('/api/categories', async () => listCategories(db));
  app.post('/api/categories', async (request, reply) => {
    const body = z.object({ name: z.string(), type: z.enum(['income', 'expense']) }).parse(request.body);
    return reply.code(201).send(createCategory(db, body));
  });
  app.post('/api/categories/:id/merge', async (request) =>
    mergeCategory(db, idParams.parse(request.params).id, z.object({ intoId: z.number().int().positive() }).parse(request.body).intoId),
  );

  app.get('/api/recurring', async (request) => {
    const items = recurringPayments(db, { includeHidden: true });
    return { items, ...summarizeRecurring(items.filter((item) => !item.hidden)) };
  });
  const recurringKey = z.object({ key: z.string().min(3).max(60) });
  app.post('/api/recurring/hide', async (request, reply) => {
    hideRecurring(db, recurringKey.parse(request.body).key);
    return reply.code(204).send();
  });
  app.post('/api/recurring/show', async (request, reply) => {
    showRecurring(db, recurringKey.parse(request.body).key);
    return reply.code(204).send();
  });

  app.get('/api/budgets', async (request) => budgetStatus(db, monthQuery.parse(request.query)));
  app.get('/api/budgets/suggestions', async () => suggestBudgets(db));
  app.put('/api/budgets/:id', async (request) =>
    setBudget(db, { categoryId: idParams.parse(request.params).id, amount: z.object({ amount: z.number() }).parse(request.body).amount }),
  );
  app.delete('/api/budgets/:id', async (request, reply) => {
    deleteBudget(db, idParams.parse(request.params).id);
    return reply.code(204).send();
  });

  const keyBody = z.object({ key: z.string().min(1).max(200) });
  app.post('/api/insights/fix', async (request) => fixInsight(db, keyBody.parse(request.body).key));
  app.post('/api/insights/dismiss', async (request, reply) => {
    dismissInsight(db, keyBody.parse(request.body).key);
    return reply.code(204).send();
  });

  app.get('/api/settings/auto-rules', async () => ({ mode: getAutoRuleMode(db) }));

  // Turning it on acts straight away on what is already there, so it is not a promise about later.
  app.put('/api/settings/auto-rules', async (request) => {
    const { mode } = z.object({ mode: z.enum(AUTO_RULE_MODES) }).parse(request.body);
    setAutoRuleMode(db, mode);
    return { mode, ...runAutoRules(db) };
  });

  // Only exists in demo mode, where the database holds nothing but sample data.
  // Wipes the books, statements and receipts and starts again from the starter categories.
  // Sign-in, agent tokens, and the settings under "cfg." (AI key, mailbox, folder) stay.
  app.post('/api/account/reset', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { confirm } = z.object({ confirm: z.string().max(40) }).parse(request.body);
    if (confirm !== 'DELETE EVERYTHING') throw new DomainError('invalid', 'Type DELETE EVERYTHING to confirm');
    const sqlite = db.$client;
    const keep = new Set(['sessions', 'api_tokens', 'settings']);
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts%' ESCAPE '\\'").all() as { name: string }[])
      .map((row) => row.name)
      .filter((name) => !keep.has(name) && !name.startsWith('__'));
    sqlite.pragma('foreign_keys = OFF');
    try {
      sqlite.transaction(() => {
        for (const name of tables) sqlite.prepare(`DELETE FROM "${name}"`).run();
        sqlite.prepare("DELETE FROM settings WHERE key NOT LIKE 'cfg.%'").run();
        sqlite.prepare("DELETE FROM sqlite_sequence").run();
      })();
    } finally {
      sqlite.pragma('foreign_keys = ON');
    }
    seedDefaults(db);
    ensureStarterCategories(db);
    await rm(join(config.dataDir, 'documents'), { recursive: true, force: true });
    return reply.code(200).send({ reset: true });
  });

  if (config.demoMode) {
    app.post(
      '/api/demo/reset',
      { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
      async () => {
        resetDemoData(db);
        return { reset: true };
      },
    );
  }

  app.get('/api/accounts', async (request) => {
    return getBalances(db, asOfQuery.parse(request.query));
  });

  app.post('/api/accounts', async (request, reply) => {
    return reply.code(201).send(createAccount(db, request.body as never));
  });

  app.patch('/api/accounts/:id', async (request) => {
    return updateAccount(db, idParams.parse(request.params).id, request.body as never);
  });

  app.post('/api/accounts/:id/archive', async (request) => {
    return archiveAccount(db, idParams.parse(request.params).id);
  });

  app.post('/api/accounts/:id/unarchive', async (request) => {
    return unarchiveAccount(db, idParams.parse(request.params).id);
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    deleteAccount(db, idParams.parse(request.params).id);
    return reply.code(204).send();
  });

  app.get('/api/transactions', async (request) => {
    return listTransactions(db, request.query as never);
  });

  app.get('/api/transactions/:id', async (request) => {
    return getTransaction(db, idParams.parse(request.params).id);
  });

  app.post('/api/transactions', async (request, reply) => {
    return reply.code(201).send(createTransaction(db, request.body as never));
  });

  app.post('/api/transactions/simple', async (request, reply) => {
    return reply.code(201).send(createSimpleTransaction(db, request.body as never));
  });

  const categoryBody = z.object({ categoryId: z.number().int().positive() });

  app.patch('/api/transactions/:id/category', async (request) => {
    const { categoryId } = categoryBody.parse(request.body);
    const result = setTransactionCategory(db, idParams.parse(request.params).id, categoryId);
    // A choice you just made may be the third that tips a payee into a rule.
    return { ...result, autoRules: runAutoRules(db) };
  });

  app.post('/api/transactions/:id/category/similar', async (request) => {
    const { categoryId } = categoryBody.parse(request.body);
    return applyCategoryToSimilar(db, idParams.parse(request.params).id, categoryId);
  });

  app.put('/api/transactions/:id', async (request) => {
    return updateTransaction(db, idParams.parse(request.params).id, request.body as never);
  });

  app.delete('/api/transactions/:id', async (request, reply) => {
    deleteTransaction(db, idParams.parse(request.params).id);
    // Receipts attached to it go too, so no orphaned file is left on disk.
    for (const name of pruneOrphanDocuments(db)) await rm(join(config.dataDir, 'documents', name), { force: true });
    return reply.code(204).send();
  });

  app.get('/api/reports/net-worth', async (request) => {
    return getNetWorth(db, asOfQuery.parse(request.query));
  });

  const periodQuery = rangeSchema.extend({ period: periodSchema.default('month') });

  app.get('/api/reports/overview', async (request) => overview(db, rangeSchema.parse(request.query)));

  app.get('/api/reports/spending-by-category', async (request) => {
    return spendingByCategory(db, rangeSchema.parse(request.query));
  });

  app.get('/api/reports/periods', async (request) => {
    return periodSummary(db, periodQuery.parse(request.query));
  });

  app.get('/api/reports/category-trend', async (request) => {
    const query = periodQuery.extend({ top: z.coerce.number().int().min(1).max(8).default(5) });
    return categoryTrend(db, query.parse(request.query));
  });

  app.get('/api/reports/top-payees', async (request) => {
    const query = rangeSchema.extend({ limit: z.coerce.number().int().min(1).max(50).default(10) });
    return topPayees(db, query.parse(request.query));
  });

  app.get('/api/reports/net-worth-history', async (request) => {
    const query = z.object({ months: z.coerce.number().int().min(1).max(60).default(12), to: dateSchema.optional() });
    const { months, to } = query.parse(request.query);
    return netWorthHistory(db, { months, today: to });
  });

  app.get('/api/reports/cash-flow', async (request) => {
    return getCashFlow(db, z.object({ from: dateSchema, to: dateSchema }).parse(request.query));
  });
}
