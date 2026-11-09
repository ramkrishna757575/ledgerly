// Times the main queries on 100,000 made-up transactions: node apps/server/src/scripts/perf.ts
import { computeInsights, createAccount, ensureStarterCategories, forecast, getBalances, getNetWorth, listAccounts, listTransactions, netWorthHistory, overview, recurringPayments, seedDefaults, spendingByCategory, periodSummary, budgetStatus, topPayees } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { sql } from 'drizzle-orm';

const db = openDb(':memory:');
seedDefaults(db);
ensureStarterCategories(db);
const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' }).id;
const cats = listAccounts(db).filter((a) => a.type === 'expense').map((a) => a.id);
const N = 100_000;
const t0 = Date.now();
db.run(sql`BEGIN`);
for (let i = 0; i < N; i++) {
  const d = new Date(Date.UTC(2019, 0, 1) + (i % 2800) * 86_400_000).toISOString().slice(0, 10);
  const amount = 100_00 + (i % 90) * 100;
  const tx = db.all<{ id: number }>(sql`INSERT INTO transactions (date, description, payee, source) VALUES (${d}, ${'Shop ' + (i % 300)}, ${'Payee ' + (i % 300)}, 'import:1') RETURNING id`)[0]!.id;
  db.run(sql`INSERT INTO postings (transaction_id, account_id, amount) VALUES (${tx}, ${bank}, ${-amount}), (${tx}, ${cats[i % cats.length]!}, ${amount})`);
}
db.run(sql`COMMIT`);
console.log(`seeded ${N} transactions in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const time = (label: string, fn: () => unknown) => {
  const s = performance.now();
  fn();
  console.log(`${label.padEnd(34)} ${(performance.now() - s).toFixed(0).padStart(6)} ms`);
};
time('transactions page 1', () => listTransactions(db, { limit: 50 }));
time('transactions search', () => listTransactions(db, { search: 'shop 12', limit: 50 }));
time('transactions by account+range', () => listTransactions(db, { accountId: bank, from: '2024-01-01', to: '2024-12-31', limit: 50 }));
time('balances', () => getBalances(db));
time('net worth', () => getNetWorth(db));
time('net worth history 60m', () => netWorthHistory(db, { months: 60 }));
time('spending by category (year)', () => spendingByCategory(db, { from: '2025-01-01', to: '2025-12-31' }));
time('period summary 5y', () => periodSummary(db, { from: '2020-01-01', to: '2025-12-31', period: 'month' }));
time('overview', () => overview(db, { from: '2025-01-01', to: '2025-12-31' } as never));
time('top payees', () => topPayees(db, { from: '2025-01-01', to: '2025-12-31' } as never));
time('recurring payments', () => recurringPayments(db));
time('budget status', () => budgetStatus(db));
time('forecast 60d', () => forecast(db));
time('insights', () => computeInsights(db));
