import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SUBTYPES = [
  'bank',
  'credit_card',
  'cash',
  'wallet',
  'loan',
  'investment',
  'other',
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

const createdAt = () =>
  text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

// Categories are income and expense accounts, so every transaction is a plain
// set of postings that sums to zero.
export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
    subtype: text('subtype', { enum: ACCOUNT_SUBTYPES }),
    currency: text('currency').notNull().default('INR'),
    institution: text('institution'),
    numberLast4: text('number_last4'),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('accounts_type_name_unique').on(t.type, t.name)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    date: text('date').notNull(),
    description: text('description').notNull(),
    payee: text('payee'),
    notes: text('notes'),
    source: text('source').notNull().default('manual'),
    createdAt: createdAt(),
    updatedAt: text('updated_at'),
  },
  (t) => [index('transactions_date_idx').on(t.date)],
);

// Amounts are integers in the smallest currency unit. Debits are positive and
// credits are negative.
export const postings = sqliteTable(
  'postings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    amount: integer('amount').notNull(),
    memo: text('memo'),
  },
  (t) => [
    index('postings_transaction_idx').on(t.transactionId),
    index('postings_account_idx').on(t.accountId),
    // Lets a balance or an account's transactions be read from the index alone.
    index('postings_account_tx_idx').on(t.accountId, t.transactionId, t.amount),
    check('postings_amount_nonzero_integer', sql`typeof(${t.amount}) = 'integer' AND ${t.amount} <> 0`),
  ],
);

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
});

export const transactionTags = sqliteTable(
  'transaction_tags',
  {
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] })],
);

export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  expiresAt: text('expires_at').notNull(),
  // A viewer can look at everything and change nothing.
  role: text('role', { enum: ['owner', 'viewer'] }).notNull().default('owner'),
  createdAt: createdAt(),
});

export const documents = sqliteTable('documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sha256: text('sha256').notNull().unique(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  storedName: text('stored_name').notNull(),
  createdAt: createdAt(),
});

export const BATCH_STATUSES = ['staged', 'committed', 'undone'] as const;
export const RECONCILIATIONS = ['ok', 'mismatch', 'unchecked'] as const;

export const importBatches = sqliteTable(
  'import_batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: integer('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    adapterId: text('adapter_id').notNull(),
    accountKind: text('account_kind', { enum: ['bank', 'credit_card'] }).notNull(),
    accountLast4: text('account_last4'),
    status: text('status', { enum: BATCH_STATUSES }).notNull().default('staged'),
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    openingBalance: integer('opening_balance'),
    closingBalance: integer('closing_balance'),
    // A card statement's payment due date and the smallest payment it allows.
    dueDate: text('due_date'),
    minimumDue: integer('minimum_due'),
    reconciliation: text('reconciliation', { enum: RECONCILIATIONS }).notNull().default('unchecked'),
    warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    createdAt: createdAt(),
    committedAt: text('committed_at'),
  },
  (t) => [index('import_batches_account_idx').on(t.accountId)],
);

export const STAGED_STATUSES = ['pending', 'duplicate', 'skipped', 'committed', 'undone'] as const;
export const CATEGORY_SOURCES = ['rule', 'history', 'builtin', 'manual'] as const;

// Amounts use the ledger's sign for the statement's account: negative is money
// going out (or a card charge), positive is money coming in.
export const stagedTransactions = sqliteTable(
  'staged_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    date: text('date').notNull(),
    description: text('description').notNull(),
    amount: integer('amount').notNull(),
    balance: integer('balance'),
    channel: text('channel'),
    payee: text('payee'),
    reference: text('reference'),
    fingerprint: text('fingerprint').notNull(),
    categoryId: integer('category_id').references(() => accounts.id, { onDelete: 'set null' }),
    categorySource: text('category_source', { enum: CATEGORY_SOURCES }),
    status: text('status', { enum: STAGED_STATUSES }).notNull().default('pending'),
    transactionId: integer('transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('staged_batch_idx').on(t.batchId),
    index('staged_fingerprint_idx').on(t.fingerprint),
  ],
);

export const rules = sqliteTable('rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pattern: text('pattern').notNull(),
  matchType: text('match_type', { enum: ['contains', 'regex'] }).notNull().default('contains'),
  categoryId: integer('category_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  priority: integer('priority').notNull().default(100),
  // Optional conditions beside the text: an amount range (the size of the
  // payment, in paise) and one account it must come from.
  minAmount: integer('min_amount'),
  maxAmount: integer('max_amount'),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  // Whether a person made the rule or Ledgerly did, so automatic ones can be told apart.
  createdBy: text('created_by', { enum: ['manual', 'auto'] }).notNull().default('manual'),
  createdAt: createdAt(),
});

export const TOKEN_SCOPES = ['read', 'propose'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

// Only a hash of each token is stored, so a lost token has to be replaced.
export const apiTokens = sqliteTable('api_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  scope: text('scope', { enum: TOKEN_SCOPES }).notNull(),
  createdAt: createdAt(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

export const PROPOSAL_KINDS = ['categorize_transaction', 'categorize_import_row', 'create_rule'] as const;
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'failed'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

// A change an agent suggests. Nothing happens until you approve it.
export const proposals = sqliteTable(
  'proposals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: PROPOSAL_KINDS }).notNull(),
    status: text('status', { enum: PROPOSAL_STATUSES }).notNull().default('pending'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    reason: text('reason'),
    source: text('source').notNull(),
    createdAt: createdAt(),
    decidedAt: text('decided_at'),
    error: text('error'),
  },
  (t) => [index('proposals_status_idx').on(t.status)],
);

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: createdAt(),
  actor: text('actor').notNull(),
  tool: text('tool').notNull(),
  args: text('args'),
  outcome: text('outcome', { enum: ['ok', 'error', 'denied'] }).notNull(),
  detail: text('detail'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Things you turned down, so they are not suggested or created again.
export const dismissals = sqliteTable('dismissals', {
  key: text('key').primaryKey(),
  createdAt: createdAt(),
});

export const ASSET_CLASSES = ['equity', 'debt', 'hybrid', 'gold', 'other'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

// A fund within a folio. Units are stored in millionths and prices in millionths
// of a rupee, so nothing in the investment tables is a floating point number.
export const positions = sqliteTable(
  'positions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    isin: text('isin'),
    folio: text('folio'),
    schemeCode: text('scheme_code'),
    assetClass: text('asset_class', { enum: ASSET_CLASSES }).notNull().default('other'),
    // The ledger account this holding is valued in.
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    // Earliest date from which every transaction is known, so a return can be worked out.
    historyFrom: text('history_from'),
    createdAt: createdAt(),
  },
  (t) => [index('positions_isin_idx').on(t.isin), index('positions_folio_idx').on(t.folio)],
);

export const INVESTMENT_SOURCES = ['cdsl', 'scripbox', 'amfi', 'csv'] as const;
export type InvestmentSource = (typeof INVESTMENT_SOURCES)[number];

export const investmentImports = sqliteTable('investment_imports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  documentId: integer('document_id').references(() => documents.id, { onDelete: 'restrict' }),
  source: text('source', { enum: INVESTMENT_SOURCES }).notNull(),
  asOf: text('as_of').notNull(),
  status: text('status', { enum: BATCH_STATUSES }).notNull().default('staged'),
  // What was read from the statement, kept until it is imported.
  payload: text('payload', { mode: 'json' }).$type<unknown>(),
  warnings: text('warnings', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: createdAt(),
  committedAt: text('committed_at'),
});

export const valuations = sqliteTable(
  'valuations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    importId: integer('import_id')
      .notNull()
      .references(() => investmentImports.id, { onDelete: 'cascade' }),
    positionId: integer('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    units: integer('units').notNull(),
    nav: integer('nav').notNull(),
    value: integer('value').notNull(),
    invested: integer('invested'),
    xirrBps: integer('xirr_bps'),
  },
  (t) => [
    uniqueIndex('valuations_import_position_unique').on(t.importId, t.positionId),
    index('valuations_position_idx').on(t.positionId, t.asOf),
  ],
);

export const INVESTMENT_KINDS = ['purchase', 'sip', 'redemption', 'switch_in', 'switch_out', 'dividend', 'other'] as const;
export type InvestmentKind = (typeof INVESTMENT_KINDS)[number];

export const investmentTransactions = sqliteTable(
  'investment_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    importId: integer('import_id')
      .notNull()
      .references(() => investmentImports.id, { onDelete: 'cascade' }),
    positionId: integer('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    kind: text('kind', { enum: INVESTMENT_KINDS }).notNull(),
    // Always positive. Units carry the direction.
    amount: integer('amount').notNull(),
    units: integer('units').notNull(),
    nav: integer('nav'),
    description: text('description').notNull(),
    fingerprint: text('fingerprint').notNull(),
  },
  (t) => [index('investment_tx_position_idx').on(t.positionId, t.date), index('investment_tx_fingerprint_idx').on(t.fingerprint)],
);

// One month's payslip, as numbers. The PDF itself is not kept: it carries identity numbers
// the books have no use for. The ledger entry it made is what the bank statement later takes over.
export const payslips = sqliteTable('payslips', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  month: text('month').notNull(),
  employer: text('employer').notNull(),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  gross: integer('gross').notNull(),
  net: integer('net').notNull(),
  deductions: text('deductions', { mode: 'json' }).$type<{ label: string; kind: 'tax' | 'pf' | 'professional_tax' | 'other'; amount: number }[]>().notNull(),
  transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

// A transaction the bank announced by email (an alert), before any statement has it. Each
// is read from the message text, shown for review, and later matched to the statement that
// brings the same transaction.
export const ALERT_STATUSES = ['new', 'added', 'dismissed'] as const;
export const alertEntries = sqliteTable(
  'alert_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    date: text('date').notNull(),
    description: text('description').notNull(),
    // The ledger's sign for the account: negative is money out, or a card charge.
    amount: integer('amount').notNull(),
    last4: text('last4').notNull(),
    reference: text('reference'),
    fingerprint: text('fingerprint').notNull().unique(),
    sender: text('sender').notNull(),
    status: text('status', { enum: ALERT_STATUSES }).notNull().default('new'),
    transactionId: integer('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('alert_entries_status_idx').on(t.status)],
);

// A monthly limit for one expense category. One per category.
export const budgets = sqliteTable('budgets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  categoryId: integer('category_id')
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  createdAt: createdAt(),
});

// What an AI review was shown and what it answered, so you can see afterwards
// exactly what left the machine.
export const analyses = sqliteTable('analyses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: createdAt(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  destination: text('destination').notNull(),
  snapshot: text('snapshot').notNull(),
  output: text('output').notNull(),
});

export const ASSET_KINDS = ['fd', 'rd', 'ppf', 'epf', 'nps', 'stocks', 'gold', 'property', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

// Details for an asset kept by hand (a fixed deposit, PPF, a flat). Its money
// lives in an ordinary asset account, so net worth already counts it.
export const manualAssets = sqliteTable('manual_assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id')
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ASSET_KINDS }).notNull(),
  // The amount put in, when known, so a gain can be shown.
  invested: integer('invested'),
  // Yearly rate in basis points, for a fixed deposit that grows by itself.
  rateBps: integer('rate_bps'),
  startDate: text('start_date'),
  maturityDate: text('maturity_date'),
  note: text('note'),
  createdAt: createdAt(),
});

// A bill, invoice or receipt kept with the transaction it belongs to.
export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    transactionId: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    documentId: integer('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_transaction_idx').on(t.transactionId)],
);

// Something to save up for, measured against the accounts set aside for it.
export const goals = sqliteTable('goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  targetAmount: integer('target_amount').notNull(),
  targetDate: text('target_date'),
  // Accounts whose balances count toward it, plus anything saved by hand.
  accountIds: text('account_ids', { mode: 'json' }).$type<number[]>().notNull().default(sql`'[]'`),
  savedByHand: integer('saved_by_hand').notNull().default(0),
  createdAt: createdAt(),
});

// A loan with its terms, so its schedule and payoff can be worked out.
export const loans = sqliteTable('loans', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  // The liability account that holds what is owed, when there is one.
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  principal: integer('principal').notNull(),
  rateBps: integer('rate_bps').notNull(),
  tenureMonths: integer('tenure_months').notNull(),
  emi: integer('emi').notNull(),
  // The date of the first instalment; later ones fall on the same day each month.
  firstEmiDate: text('first_emi_date').notNull(),
  createdAt: createdAt(),
});

export const POLICY_KINDS = ['life', 'term', 'health', 'vehicle', 'home', 'other'] as const;
export const POLICY_FREQUENCIES = ['monthly', 'quarterly', 'yearly'] as const;

export const policies = sqliteTable('policies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind', { enum: POLICY_KINDS }).notNull(),
  insurer: text('insurer'),
  premium: integer('premium').notNull(),
  frequency: text('frequency', { enum: POLICY_FREQUENCIES }).notNull(),
  nextDue: text('next_due').notNull(),
  sumAssured: integer('sum_assured'),
  createdAt: createdAt(),
});
