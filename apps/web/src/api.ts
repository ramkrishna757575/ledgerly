import type {
  AccountCoverage,
  categoryTrend,
  computeInsights,
  budgetStatus,
  buildSnapshot,
  getAnalysis,
  statementBalanceChecks,
  forecast,
  getBalances,
  listLoans,
  listPolicies,
  sipPlans,
  listGoals,
  taxSummary,
  listAssets,
  getMarket,
  listAnalyses,
  portfolioReview,
  surplusCash,
  listCategories,
  recurringPayments,
  summarizeRecurring,
  getCashFlow,
  getHoldings,
  getImportBatch,
  getInvestmentImport,
  getNetWorth,
  listApiTokens,
  listAudit,
  listImportBatches,
  listInvestmentImports,
  listProposals,
  listRules,
  listTransactions,
  netWorthHistory,
  overview,
  periodSummary,
  previewRule,
  setTransactionCategory,
  setupProgress,
  suggestRules,
  spendingByCategory,
  suggestBudgets,
  topPayees,
  uncategorizedPayees,
} from '@ledgerly/core';

export type Account = ReturnType<typeof getBalances>[number];
export type NetWorth = ReturnType<typeof getNetWorth>;
export type CashFlow = ReturnType<typeof getCashFlow>;
export type TransactionPage = ReturnType<typeof listTransactions>;
export type Transaction = TransactionPage['items'][number];
export type AgentToken = ReturnType<typeof listApiTokens>[number];
export type Proposal = ReturnType<typeof listProposals>[number];
export type AuditRow = ReturnType<typeof listAudit>[number];
export type Rule = ReturnType<typeof listRules>[number];
export type Portfolio = ReturnType<typeof getHoldings>;
export type Holding = Portfolio['holdings'][number];
export type InvestmentImport = ReturnType<typeof getInvestmentImport>;
export type InvestmentImportSummary = ReturnType<typeof listInvestmentImports>[number];
export type Insight = ReturnType<typeof computeInsights>[number];
export type AutoRuleMode = 'off' | 'create' | 'create_and_apply';
export type AutoRuleOutcome = { created: number; sorted: number };
export type UncategorizedPayee = ReturnType<typeof uncategorizedPayees>[number];
export type RuleSuggestion = ReturnType<typeof suggestRules>[number];
export type RulePreview = ReturnType<typeof previewRule>;
export type CategoryChange = ReturnType<typeof setTransactionCategory> & { autoRules?: { created: number; sorted: number } };
export type Overview = ReturnType<typeof overview>;
export type CategorySpend = ReturnType<typeof spendingByCategory>[number];
export type PeriodRow = ReturnType<typeof periodSummary>[number];
export type CategoryTrend = ReturnType<typeof categoryTrend>;
export type Payee = ReturnType<typeof topPayees>[number];
export type NetWorthPoint = ReturnType<typeof netWorthHistory>[number];
export type BudgetStatus = ReturnType<typeof budgetStatus>;
export type BudgetItem = BudgetStatus['items'][number];
export type BudgetSuggestion = ReturnType<typeof suggestBudgets>[number];
export type RecurringPayment = ReturnType<typeof recurringPayments>[number];
export type Recurring = { items: RecurringPayment[] } & ReturnType<typeof summarizeRecurring>;
export type CategoryRow = ReturnType<typeof listCategories>[number];
export type AnalysisState = {
  surplus: ReturnType<typeof surplusCash>;
  balanceChecks: ReturnType<typeof statementBalanceChecks>;
  review: ReturnType<typeof portfolioReview>;
  bufferMonths: number;
  target: Record<string, number> | null;
  market: ReturnType<typeof getMarket>;
  ai: {
    configured: boolean;
    provider: string | null;
    model: string | null;
    destination: { host: string; local: boolean } | null;
    problem: string | null;
  };
  history: ReturnType<typeof listAnalyses>;
};
export type AnalysisRun = ReturnType<typeof getAnalysis>;
export type AnalysisPreview = { destination: AnalysisState['ai']['destination']; snapshot: ReturnType<typeof buildSnapshot> };
export type StagedStatement = { kind: 'bank' | 'investment'; id: number; filename: string };
export type CommitReady = {
  imported: { kind: 'bank' | 'investment'; id: number; filename: string }[];
  held: { kind: 'bank' | 'investment'; id: number; filename: string; reason: string }[];
};
export type AssetList = ReturnType<typeof listAssets>;
export type Asset = AssetList['items'][number];
export type Forecast = ReturnType<typeof forecast>;
export type AlertsState = {
  channels: { id: string; label: string; host: string }[];
  kinds: { kind: string; label: string; enabled: boolean }[];
  own: { id: string; kind: 'ntfy' | 'telegram' | 'webhook'; host: string }[];
  waiting: number;
  digest: 'off' | 'weekly' | 'monthly';
  log: { at: string; titles: string[]; channels: string[]; ok: boolean; error?: string }[];
};
export type Attachment = { id: number; filename: string; mimeType: string; size: number; createdAt: string; url: string };
export type TaxSummary = ReturnType<typeof taxSummary>;
export type Goal = ReturnType<typeof listGoals>[number];
export type SipPlans = ReturnType<typeof sipPlans>;
export type InboxState = {
  enabled: boolean;
  folder: string | null;
  lastScan: string | null;
  results: { at: string; file: string; outcome: 'staged' | 'already' | 'held'; note?: string }[];
  lastImport: { imported: number; held: number } | null;
};
export type Loan = ReturnType<typeof listLoans>[number];
export type Policy = ReturnType<typeof listPolicies>[number];
export type MailState = {
  enabled: boolean;
  problem: string | null;
  mailbox: string | null;
  senders: string[];
  lastCheck: string | null;
  lastError: string | null;
  results: { at: string; from: string; file: string; outcome: 'staged' | 'already' | 'held' | 'ignored' | 'alert'; note?: string }[];
  lastImport: { imported: number; held: number } | null;
  nextCheck: string | null;
};
export type RuleProblem = { ruleId: number; pattern: string; categoryName: string; kind: 'unused' | 'shadowed' | 'conflict'; reason: string };
export type DryRun = {
  imported: { kind: 'bank' | 'investment'; id: number; filename: string; transactions?: number; moneyIn?: number; moneyOut?: number; holdings?: number }[];
  held: CommitReady['held'];
  balances: { accountName: string; before: number; after: number }[];
};
export type PayeeSuggestion = { from: string; to: string; times: number; why: string; source: 'text' | 'ai' };
export type PayeePick = { payee: string; type: 'expense' | 'income'; categoryId: number | null; label: string; reason: string };
export type PayeeTidy = {
  suggestions: PayeeSuggestion[];
  renamedBefore: number;
  ai: { enabled: boolean; configured: boolean; destination: { host: string; local: boolean } | null; send: { id: number; payee: string; times: number; example: string }[] };
};

export type AiParsers = {
  enabled: boolean;
  configured: boolean;
  destination: { host: string; local: boolean } | null;
  learned: { id: string; bank: string; kind: 'bank' | 'credit_card'; learnedAt: string }[];
};

export type AiCategorize = {
  enabled: boolean;
  configured: boolean;
  destination: { host: string; local: boolean } | null;
  send: { groups: { id: number; payee: string; kind: string; times: number; typicalRupees: number }[]; spendingCategories: string[]; incomeCategories: string[] };
  log: { at: string; sent: number; proposed: number; skipped: number; destination: string; local: boolean }[];
};
export type ReceiptReading = {
  read: { vendor: string | null; date: string | null; total: number | null; currency: string; confidence: number };
  comparison: { amount: boolean | null; amountDifference: number | null; date: boolean | null; vendor: boolean | null };
  transaction: { date: string; description: string; amount: number };
  destination: { host: string; local: boolean };
};
export type AskState = { enabled: boolean; configured: boolean; destination: { host: string; local: boolean } | null };
export type AskResult = { answer: string; steps: { tool: string; arguments: unknown; ok: boolean }[]; stoppedEarly: boolean };
export type SettingsState = {
  restricted: boolean;
  usage: { used: number; quota: number | null };
  ai: { own: { provider: string; model: string; baseUrl: string | null; region: string | null; hasKey: boolean } | null; usingServerDefault: boolean; destination: { host: string; local: boolean } | null; model: string | null; provider: string | null };
  mail: { own: { host: string; port: number; secure: boolean; user: string; folder: string; senders: string[]; requireAuth: boolean; hasPassword: boolean } | null; usingServerDefault: boolean };
  watch: { enabled: boolean; own: boolean; folder: string | null; passwords: number };
  summary: { enabled: boolean; email: string | null; canSend: boolean };
};
export type BackupOutcome = { at: string; ok: boolean; name: string; detail: string };
export type BackupStatus = { configured: boolean; where: string[]; problem: string | null; last: BackupOutcome | null; verified: BackupOutcome | null };
export type BackupInfo = { name: string; size: number; createdAt: string; encrypted: boolean };
export type GroupBy = 'month' | 'year' | 'fy';

const query = (params: Record<string, string | number>) =>
  new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();

export type ImportBatch = ReturnType<typeof getImportBatch>;
export type ImportSummary = ReturnType<typeof listImportBatches>[number];
export type StagedRow = ImportBatch['items'][number];
export type RowPatch = { categoryId?: number | null; status?: 'pending' | 'skipped'; createRule?: boolean };
export type AuthStatus = { authRequired: boolean; authenticated: boolean; demo: boolean; role?: 'owner' | 'viewer' | 'local' | null; multiUser?: boolean; username?: string | null; isAdmin?: boolean; signup?: 'closed' | 'invite' | 'approval' | 'open'; twoFactor?: boolean; email?: boolean; address?: string | null; legal?: boolean; viewing?: { ownerId: number; username: string; role: 'editor' | 'viewer' } | null };
export type UserRow = { id: number; username: string; role: 'admin' | 'user'; disabled: boolean; pending: boolean; createdAt: string; holdsFirstBooks: boolean; twoFactor: boolean };
export type Invite = { id: number; role: 'admin' | 'user'; note: string | null; createdAt: string; expiresAt: string; usedBy: number | null; usedAt: string | null };
export type ActivityRow = { id: number; at: string; actor: string; tool: string; outcome: 'ok' | 'error' | 'denied'; detail: string | null };

export type BankAlert = { id: number; accountId: number | null; accountName: string | null; date: string; description: string; amount: number; last4: string; status: 'new' | 'added' | 'dismissed' };
export type PayslipDraft = { month: string | null; gross: number | null; net: number | null; deductions: { label: string; kind: 'tax' | 'pf' | 'professional_tax' | 'other'; amount: number }[]; notes: string[] };
export type Payslip = { id: number; month: string; employer: string; gross: number; net: number; deductions: PayslipDraft['deductions'] };
export type AdminOverview = {
  counts: { total: number; active: number; waiting: number; unconfirmed: number; disabled: number; administrators: number; twoFactor: number };
  signupMode: 'closed' | 'invite' | 'approval' | 'open';
  mailOn: boolean;
  openLedgers: number;
  totalBytes: number;
  quotaBytes: number | null;
  signups: { date: string; count: number }[];
  people: { id: number; username: string; role: 'admin' | 'user'; bytes: number; lastLoginAt: string | null; createdAt: string; twoFactor: boolean; status: 'active' | 'waiting' | 'unconfirmed' | 'disabled' }[];
  failures: { at: string; kind: 'wrong_password' | 'wrong_code' | 'paused' | 'unknown_name'; username: string | null; ip: string }[];
};
export type Legal = { enabled: boolean; terms: string; privacy: string };

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Whose books to read and write: someone else's when this person has been let into them.
const LEDGER_KEY = 'ledgerly.ledger';
export function activeLedger(): number | null {
  try {
    const n = Number(localStorage.getItem(LEDGER_KEY));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
export function chooseLedger(ownerId: number | null) {
  try {
    if (ownerId) localStorage.setItem(LEDGER_KEY, String(ownerId));
    else localStorage.removeItem(LEDGER_KEY);
  } catch {
    // Choosing is a convenience only.
  }
  window.location.assign('/');
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  // A form carries its own content type, which includes the multipart boundary.
  const isForm = body instanceof FormData;
  const ledger = activeLedger();
  const headers: Record<string, string> = {};
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  if (ledger) headers['x-ledger'] = String(ledger);
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.issues?.[0]?.message;
    throw new ApiError(response.status, detail ?? data.error ?? 'Request failed', data.code);
  }
  return data;
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  login: (password: string, username?: string, code?: string) =>
    request('/api/auth/login', 'POST', { password, ...(username === undefined ? {} : { username }), ...(code ? { code } : {}) }),
  twoFactorSetup: (password: string) => request<{ secret: string; uri: string; qr: string }>('/api/account/2fa/setup', 'POST', { password }),
  twoFactorEnable: (code: string) => request<{ recoveryCodes: string[] }>('/api/account/2fa/enable', 'POST', { code }),
  twoFactorDisable: (password: string, code: string) => request('/api/account/2fa/disable', 'POST', { password, code }),
  resetTwoFactor: (id: number) => request(`/api/users/${id}/2fa/reset`, 'POST', {}),
  challenge: () => request<{ token: string; difficulty: number }>('/api/auth/challenge'),
  signup: (input: { username: string; password: string; code?: string; email?: string; accept?: boolean; challenge: string; nonce: string; website?: string }) => request<{ pending?: boolean; authenticated?: boolean; verify?: boolean }>('/api/auth/signup', 'POST', input),
  shares: () => request<{ granted: { memberId: number; username: string; role: 'editor' | 'viewer' }[]; received: { ownerId: number; username: string; role: 'editor' | 'viewer' }[] }>('/api/shares'),
  share: (username: string, role: 'editor' | 'viewer') => request('/api/shares', 'POST', { username, role }),
  unshare: (memberId: number) => request(`/api/shares/${memberId}`, 'DELETE'),
  leaveShare: (ownerId: number) => request(`/api/shares/received/${ownerId}`, 'DELETE'),
  adminOverview: () => request<AdminOverview>('/api/admin/overview'),
  legal: () => request<Legal>('/api/legal'),
  adminLegal: () => request<Legal & { templates: { terms: string; privacy: string } }>('/api/admin/legal'),
  saveLegal: (input: Legal) => request('/api/admin/legal', 'PUT', input),
  verifyEmail: (token: string) => request<{ confirmed: boolean; pending: boolean }>('/api/auth/verify', 'POST', { token }),
  resendVerification: (email: string) => request('/api/auth/resend', 'POST', { email }),
  forgotPassword: (email: string) => request('/api/auth/forgot', 'POST', { email }),
  resetPassword: (token: string, password: string) => request('/api/auth/reset', 'POST', { token, password }),
  changeEmail: (email: string, password: string) => request<{ changed: boolean; sentTo?: string }>('/api/account/email', 'POST', { email, password }),
  saveSummary: (enabled: boolean) => request('/api/settings/summary', 'PUT', { enabled }),
  signupSettings: () => request<{ mode: 'closed' | 'invite' | 'approval' | 'open'; invites: Invite[] }>('/api/admin/signup'),
  setSignupMode: (mode: string) => request('/api/admin/signup', 'PUT', { mode }),
  createInvite: (input: { role: 'admin' | 'user'; note?: string; days?: number }) => request<{ id: number; code: string; expiresAt: string }>('/api/invites', 'POST', input),
  revokeInvite: (id: number) => request(`/api/invites/${id}`, 'DELETE'),
  closeAccount: (password: string, confirm: string) => request('/api/account/delete', 'POST', { password, confirm }),
  users: () => request<UserRow[]>('/api/users'),
  createUser: (input: { username: string; password: string; role: 'admin' | 'user' }) => request<UserRow>('/api/users', 'POST', input),
  updateUser: (id: number, patch: { disabled?: boolean; role?: 'admin' | 'user'; password?: string; approve?: boolean }) => request(`/api/users/${id}`, 'PATCH', patch),
  deleteUser: (id: number, confirm: string) => request(`/api/users/${id}`, 'DELETE', { confirm }),
  changePassword: (current: string, next: string) => request('/api/account/password', 'POST', { current, next }),
  logout: () => request('/api/auth/logout', 'POST'),
  resetAccount: (confirm: string) => request('/api/account/reset', 'POST', { confirm }),
  resetDemo: () => request('/api/demo/reset', 'POST'),
  accounts: () => request<Account[]>('/api/accounts'),
  createAccount: (input: unknown) => request('/api/accounts', 'POST', input),
  updateAccount: (id: number, patch: unknown) => request(`/api/accounts/${id}`, 'PATCH', patch),
  archiveAccount: (id: number) => request(`/api/accounts/${id}/archive`, 'POST'),
  unarchiveAccount: (id: number) => request(`/api/accounts/${id}/unarchive`, 'POST'),
  deleteAccount: (id: number) => request(`/api/accounts/${id}`, 'DELETE'),
  netWorth: () => request<NetWorth>('/api/reports/net-worth'),
  cashFlow: (from: string, to: string) =>
    request<CashFlow>(`/api/reports/cash-flow?${new URLSearchParams({ from, to })}`),
  transactions: (params: Record<string, string>) =>
    request<TransactionPage>(`/api/transactions?${new URLSearchParams(params)}`),
  createSimpleTransaction: (input: unknown) => request('/api/transactions/simple', 'POST', input),
  deleteTransaction: (id: number) => request(`/api/transactions/${id}`, 'DELETE'),
  setCategory: (id: number, categoryId: number) =>
    request<CategoryChange>(`/api/transactions/${id}/category`, 'PATCH', { categoryId }),
  applySimilar: (id: number, categoryId: number) =>
    request<{ updated: number }>(`/api/transactions/${id}/category/similar`, 'POST', { categoryId }),
  overview: (from: string, to: string) => request<Overview>(`/api/reports/overview?${query({ from, to })}`),
  spendingByCategory: (from: string, to: string) =>
    request<CategorySpend[]>(`/api/reports/spending-by-category?${query({ from, to })}`),
  periods: (from: string, to: string, period: GroupBy) =>
    request<PeriodRow[]>(`/api/reports/periods?${query({ from, to, period })}`),
  categoryTrend: (from: string, to: string, period: GroupBy) =>
    request<CategoryTrend>(`/api/reports/category-trend?${query({ from, to, period, top: 5 })}`),
  topPayees: (from: string, to: string) =>
    request<Payee[]>(`/api/reports/top-payees?${query({ from, to, limit: 8 })}`),
  netWorthHistory: (months: number, to: string) =>
    request<NetWorthPoint[]>(`/api/reports/net-worth-history?${query({ months, to })}`),
  investments: () => request<Portfolio>('/api/investments'),
  investmentImports: () => request<InvestmentImportSummary[]>('/api/investments/imports'),
  investmentImport: (id: number) => request<InvestmentImport>(`/api/investments/imports/${id}`),
  uploadInvestment: (file: File, password?: string) => {
    const form = new FormData();
    if (password) form.append('password', password);
    form.append('file', file);
    return request<InvestmentImport>('/api/investments/imports', 'POST', form);
  },
  commitInvestment: (id: number, accountId?: number) =>
    request<InvestmentImport>(`/api/investments/imports/${id}/commit`, 'POST', accountId ? { accountId } : {}),
  undoInvestment: (id: number) => request<InvestmentImport>(`/api/investments/imports/${id}/undo`, 'POST'),
  discardInvestment: (id: number) => request(`/api/investments/imports/${id}`, 'DELETE'),
  updatePrices: () => request<{ updated: number; skipped: number; asOf: string | null }>('/api/investments/prices', 'POST'),
  investmentSamples: () => request<{ id: string; label: string }[]>('/api/demo/investment-samples'),
  stageInvestmentSample: (id: string) => request<InvestmentImport>(`/api/demo/investment-samples/${id}`, 'POST'),
  budgets: (month: string) => request<BudgetStatus>(`/api/budgets?month=${month}`),
  budgetSuggestions: () => request<BudgetSuggestion[]>('/api/budgets/suggestions'),
  setBudget: (categoryId: number, amount: number) => request(`/api/budgets/${categoryId}`, 'PUT', { amount }),
  deleteBudget: (categoryId: number) => request(`/api/budgets/${categoryId}`, 'DELETE'),
  recurring: () => request<Recurring>('/api/recurring'),
  hideRecurring: (key: string) => request('/api/recurring/hide', 'POST', { key }),
  showRecurring: (key: string) => request('/api/recurring/show', 'POST', { key }),
  categories: () => request<CategoryRow[]>('/api/categories'),
  createCategory: (name: string, type: 'income' | 'expense') => request('/api/categories', 'POST', { name, type }),
  mergeCategory: (id: number, intoId: number) =>
    request<{ into: string; transactions: number; rules: number }>(`/api/categories/${id}/merge`, 'POST', { intoId }),
  analysis: () => request<AnalysisState>('/api/analysis'),
  analysisSettings: (settings: { bufferMonths?: number; target?: Record<string, number> | null }) => request('/api/analysis/settings', 'PUT', settings),
  analysisPreview: (includeMarket: boolean) => request<AnalysisPreview>(`/api/analysis/preview?includeMarket=${includeMarket}`),
  matchBalance: (accountId: number) => request(`/api/analysis/match-balance/${accountId}`, 'POST'),
  fetchMarket: () => request<NonNullable<AnalysisState['market']>>('/api/analysis/market', 'POST'),
  runAnalysis: (includeMarket: boolean) => request<AnalysisRun>('/api/analysis/run', 'POST', { includeMarket }),
  analysisRun: (id: number) => request<AnalysisRun>(`/api/analysis/history/${id}`),
  uploadStatement: (file: File, password?: string) => {
    const form = new FormData();
    if (password) form.append('password', password);
    form.append('file', file);
    return request<StagedStatement>('/api/statements', 'POST', form);
  },
  payeePicksAi: () => request<{ picks: PayeePick[]; sent: number; destination: string }>('/api/rules/payees/ai', 'POST'),
  payeeTidy: () => request<PayeeTidy>('/api/payees/tidy'),
  payeeTidyAi: () => request<{ suggestions: PayeeSuggestion[]; sent: number; destination: string }>('/api/payees/tidy/ai', 'POST'),
  applyPayeeAliases: (pairs: { from: string; to: string }[]) => request<{ renamed: number; rules: number }>('/api/payees/aliases', 'POST', { pairs }),
  aiMonthly: () => request<{ enabled: boolean }>('/api/ai/monthly'),
  setAiMonthly: (on: boolean) => request('/api/ai/monthly', 'PUT', { on }),
  aiParsers: () => request<AiParsers>('/api/ai/parsers'),
  setAiParsers: (on: boolean) => request('/api/ai/parsers', 'PUT', { on }),
  forgetParser: (id: string) => request(`/api/ai/parsers/${encodeURIComponent(id)}`, 'DELETE'),
  learnStatement: (file: File, password?: string) => {
    const form = new FormData();
    if (password) form.append('password', password);
    form.append('file', file);
    return request<{ bank: string; rows: number; checked: boolean }>('/api/statements/learn', 'POST', form);
  },
  previewReady: () => request<DryRun>('/api/statements/preview-ready', 'POST'),
  commitReady: () => request<CommitReady>('/api/statements/commit-ready', 'POST'),
  assets: () => request<AssetList>('/api/assets'),
  createAsset: (input: unknown) => request('/api/assets', 'POST', input),
  updateAssetValue: (id: number, value: number, asOf: string) => request(`/api/assets/${id}/value`, 'PUT', { value, asOf }),
  deleteAsset: (id: number) => request(`/api/assets/${id}`, 'DELETE'),
  forecast: (days: number) => request<Forecast>(`/api/forecast?days=${days}`),
  alerts: () => request<AlertsState>('/api/alerts'),
  setAlertKinds: (kinds: string[]) => request('/api/alerts/kinds', 'PUT', { kinds }),
  setDigest: (mode: string) => request('/api/alerts/digest', 'PUT', { mode }),
  autoPrices: () => request<{ on: boolean; last: string | null }>('/api/investments/auto-prices'),
  setAutoPrices: (on: boolean) => request('/api/investments/auto-prices', 'PUT', { on }),
  addChannel: (input: { kind: string; url?: string; token?: string; chat?: string }) => request('/api/alerts/channels', 'POST', input),
  removeChannel: (id: string) => request(`/api/alerts/channels/${id}`, 'DELETE'),
  testAlert: () => request<AlertsState['log'][number]>('/api/alerts/test', 'POST'),
  attachments: (transactionId: number) => request<Attachment[]>(`/api/transactions/${transactionId}/attachments`),
  attach: (transactionId: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Attachment>(`/api/transactions/${transactionId}/attachments`, 'POST', form);
  },
  deleteAttachment: (id: number) => request(`/api/attachments/${id}`, 'DELETE'),
  tax: (fy?: string) => request<TaxSummary>(`/api/tax${fy ? `?fy=${fy}` : ''}`),
  setTaxSections: (map: Record<string, string | null>) => request('/api/tax/sections', 'PUT', { map }),
  split: (id: number, parts: { categoryId: number; amount: number }[]) => request<Transaction>(`/api/transactions/${id}/split`, 'POST', { parts }),
  goals: () => request<Goal[]>('/api/goals'),
  createGoal: (input: unknown) => request('/api/goals', 'POST', input),
  updateGoal: (id: number, input: unknown) => request(`/api/goals/${id}`, 'PUT', input),
  deleteGoal: (id: number) => request(`/api/goals/${id}`, 'DELETE'),
  sips: () => request<SipPlans>('/api/investments/sips'),
  inbox: () => request<InboxState>('/api/inbox'),
  scanInbox: () => request('/api/inbox/scan', 'POST'),
  loans: () => request<Loan[]>('/api/loans'),
  createLoan: (input: unknown) => request('/api/loans', 'POST', input),
  deleteLoan: (id: number) => request(`/api/loans/${id}`, 'DELETE'),
  policies: () => request<Policy[]>('/api/policies'),
  createPolicy: (input: unknown) => request('/api/policies', 'POST', input),
  deletePolicy: (id: number) => request(`/api/policies/${id}`, 'DELETE'),
  activity: () => request<ActivityRow[]>('/api/activity'),
  mail: () => request<MailState>('/api/mail'),
  readPayslip: (file: File, password?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (password) form.append('password', password);
    return request<PayslipDraft>('/api/payslips/read', 'POST', form);
  },
  payslips: () => request<Payslip[]>('/api/payslips'),
  savePayslip: (input: { month: string; employer: string; accountId: number; gross: number; deductions: PayslipDraft['deductions'] }) => request('/api/payslips', 'POST', input),
  deletePayslip: (id: number) => request(`/api/payslips/${id}`, 'DELETE'),
  bankAlerts: () => request<{ auto: boolean; items: BankAlert[] }>('/api/bank-alerts'),
  addBankAlert: (id: number, accountId?: number) => request(`/api/bank-alerts/${id}/add`, 'POST', accountId ? { accountId } : {}),
  dismissBankAlert: (id: number) => request(`/api/bank-alerts/${id}/dismiss`, 'POST'),
  setBankAlertAuto: (auto: boolean) => request('/api/bank-alerts/settings', 'PUT', { auto }),
  setup: () => request<ReturnType<typeof setupProgress>>('/api/setup'),
  hideSetup: () => request('/api/setup/hide', 'POST'),
  coverage: () => request<AccountCoverage[]>('/api/imports/coverage'),
  scanMail: () => request('/api/mail/scan', 'POST'),
  ruleHealth: () => request<RuleProblem[]>('/api/rules/health'),
  aiCategorize: () => request<AiCategorize>('/api/ai/categorize'),
  setAiCategorize: (on: boolean) => request('/api/ai/categorize', 'PUT', { on }),
  runAiCategorize: () => request<AiCategorize['log'][number]>('/api/ai/categorize/run', 'POST'),
  aiStatus: () => request<{ configured: boolean; destination: { host: string; local: boolean } | null }>('/api/ai/status'),
  readReceipt: (id: number) => request<ReceiptReading>(`/api/attachments/${id}/read`, 'POST'),
  askState: () => request<AskState>('/api/ai/ask'),
  setAsk: (on: boolean) => request('/api/ai/ask', 'PUT', { on }),
  ask: (question: string, history: { question: string; answer: string }[]) => request<AskResult>('/api/ai/ask', 'POST', { question, history }),
  settings: () => request<SettingsState>('/api/settings'),
  saveAiSettings: (input: unknown) => request('/api/settings/ai', 'PUT', input),
  clearAiSettings: () => request('/api/settings/ai', 'DELETE'),
  testAi: () => request<{ ok: boolean; reply: string; milliseconds: number; destination: { host: string; local: boolean } }>('/api/settings/ai/test', 'POST'),
  saveMailSettings: (input: unknown) => request('/api/settings/mail', 'PUT', input),
  clearMailSettings: () => request('/api/settings/mail', 'DELETE'),
  testMail: () => request<{ ok: boolean; error?: string }>('/api/settings/mail/test', 'POST'),
  saveWatchSettings: (input: { enabled?: boolean; passwords?: string[] }) => request('/api/settings/watch', 'PUT', input),
  backups: () => request<{ enabled: boolean; keep: number; items: BackupInfo[] }>('/api/backups'),
  backupStatus: () => request<BackupStatus>('/api/backups/status'),
  verifyBackup: () => request<BackupOutcome>('/api/backups/verify', 'POST'),
  copyBackupOut: () => request<BackupOutcome>('/api/backups/offsite', 'POST'),
  createBackup: () => request<BackupInfo>('/api/backups', 'POST'),
  deleteBackup: (name: string) => request(`/api/backups/${name}`, 'DELETE'),
  insights: () => request<Insight[]>('/api/insights'),
  fixInsight: (key: string) => request<{ message: string }>('/api/insights/fix', 'POST', { key }),
  dismissInsight: (key: string) => request('/api/insights/dismiss', 'POST', { key }),
  autoRules: () => request<{ mode: AutoRuleMode }>('/api/settings/auto-rules'),
  setAutoRules: (mode: AutoRuleMode) =>
    request<{ mode: AutoRuleMode } & AutoRuleOutcome>('/api/settings/auto-rules', 'PUT', { mode }),
  rules: () => request<Rule[]>('/api/rules'),
  createRule: (input: { pattern: string; matchType: 'contains' | 'regex'; categoryId: number; minAmount?: number | null; maxAmount?: number | null; accountId?: number | null }) =>
    request<{ id: number }>('/api/rules', 'POST', input),
  ruleSuggestions: () => request<RuleSuggestion[]>('/api/rules/suggestions'),
  uncategorizedPayees: () => request<UncategorizedPayee[]>('/api/rules/payees'),
  updateRule: (id: number, patch: Partial<{ pattern: string; matchType: 'contains' | 'regex'; categoryId: number; priority: number; isActive: boolean }>) =>
    request(`/api/rules/${id}`, 'PATCH', patch),
  deleteRule: (id: number) => request(`/api/rules/${id}`, 'DELETE'),
  previewRule: (pattern: string, matchType: 'contains' | 'regex', conditions: { minAmount?: number | null; maxAmount?: number | null; accountId?: number | null } = {}) =>
    request<RulePreview>('/api/rules/preview', 'POST', { pattern, matchType, ...conditions }),
  applyRule: (id: number) => request<{ updated: number }>(`/api/rules/${id}/apply`, 'POST'),
  applyAllRules: () => request<{ updated: number }>('/api/rules/apply', 'POST'),
  agentTokens: () => request<AgentToken[]>('/api/agents/tokens'),
  createAgentToken: (name: string, scope: 'read' | 'propose') =>
    request<AgentToken & { token: string }>('/api/agents/tokens', 'POST', { name, scope }),
  revokeAgentToken: (id: number) => request(`/api/agents/tokens/${id}`, 'DELETE'),
  agentSummary: () => request<{ pending: number }>('/api/agents/summary'),
  proposals: (status?: 'pending') => request<Proposal[]>(`/api/agents/proposals${status ? `?status=${status}` : ''}`),
  approveProposal: (id: number) => request<Proposal>(`/api/agents/proposals/${id}/approve`, 'POST'),
  rejectProposal: (id: number) => request<Proposal>(`/api/agents/proposals/${id}/reject`, 'POST'),
  decideSome: (decision: 'approve' | 'reject', ids: number[]) =>
    request<{ done: number; failed: number }>('/api/agents/proposals/decide-all', 'POST', { decision, ids }),
  decideAll: (decision: 'approve' | 'reject') =>
    request<{ done: number; failed: number }>('/api/agents/proposals/decide-all', 'POST', { decision }),
  agentActivity: () => request<AuditRow[]>('/api/agents/activity'),
  imports: () => request<ImportSummary[]>('/api/imports'),
  importBatch: (id: number) => request<ImportBatch>(`/api/imports/${id}`),
  upload: (file: File, accountId?: number, password?: string) => {
    const form = new FormData();
    if (accountId) form.append('accountId', String(accountId));
    if (password) form.append('password', password);
    form.append('file', file);
    return request<ImportBatch>('/api/imports', 'POST', form);
  },
  assignAccount: (id: number, accountId: number) =>
    request<ImportBatch>(`/api/imports/${id}`, 'PATCH', { accountId }),
  updateRow: (rowId: number, patch: RowPatch) =>
    request(`/api/imports/rows/${rowId}`, 'PATCH', patch),
  commitImport: (id: number, acceptMismatch: boolean) =>
    request<ImportBatch & { autoRules?: AutoRuleOutcome }>(`/api/imports/${id}/commit`, 'POST', { acceptMismatch }),
  undoImport: (id: number) => request<ImportBatch>(`/api/imports/${id}/undo`, 'POST'),
  discardImport: (id: number) => request(`/api/imports/${id}`, 'DELETE'),
  refreshSuggestions: (id: number) => request<ImportBatch>(`/api/imports/${id}/suggestions`, 'POST'),
  demoSamples: () => request<{ id: string; label: string }[]>('/api/demo/samples'),
  stageSample: (id: string) => request<ImportBatch>(`/api/demo/samples/${id}`, 'POST'),
};

export const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

export const isMoneyAccount = (a: { type: string }) => a.type === 'asset' || a.type === 'liability';

// en-CA formats as YYYY-MM-DD in the viewer's own time zone.
export const today = () => new Date().toLocaleDateString('en-CA');

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
