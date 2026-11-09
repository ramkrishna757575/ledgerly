import type { Db } from '@ledgerly/db';
import { sql } from 'drizzle-orm';
import { createAccount, getBalances, listAccounts } from './accounts.ts';
import { matchStatementBalance, statementBalanceChecks } from './balance-check.ts';
import { statementCoverage } from './coverage.ts';
import { anomalies } from './anomalies.ts';
import { cardDues } from './cards.ts';
import { listPolicies } from './policies.ts';
import { forecast } from './forecast.ts';
import { listAssets } from './assets.ts';
import { budgetStatus } from './budgets.ts';
import { recurringPayments } from './recurring.ts';
import { DomainError } from './errors.ts';
import { listImportBatches } from './imports/batches.ts';
import { parseNarration } from './imports/narration.ts';
import { applyRule, createRule, getAutoRuleMode, suggestRules } from './imports/rules.ts';
import { formatAmount } from './money.ts';
import { countPendingProposals } from './proposals.ts';
import { dismiss, dismissedKeys } from './settings.ts';

export type InsightAction =
  | { type: 'link'; label: string; to: '/transactions' | '/rules' | '/agents' | '/import' | '/accounts' | '/budgets' | '/bills' | '/assets' | '/forecast' | '/loans' | '/reports'; search?: Record<string, string | number> }
  | { type: 'fix'; label: string; note: string };

export type Insight = {
  // Stable across runs, so a dismissed one stays dismissed.
  key: string;
  kind: 'investments' | 'card_payments' | 'uncategorized' | 'balance' | 'imports' | 'rules' | 'agents' | 'budgets' | 'bills' | 'assets' | 'forecast' | 'cards' | 'policies' | 'anomalies' | 'coverage';
  severity: 'attention' | 'info';
  title: string;
  detail: string;
  // Money involved, in paise, when there is some.
  amount: number | null;
  action: InsightAction | null;
};

type Built = Insight & { apply?: () => { message: string } };

type Row = { id: number; description: string; payee: string | null; amount: number };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const sum = (rows: Row[]) => rows.reduce((total, row) => total + row.amount, 0);

// Spending that nobody has sorted yet, in transactions with one money side and
// one category, which is the only shape a rule can change.
function unsortedSpending(db: Db) {
  return db.all<Row & { categoryId: number }>(sql`
    SELECT t.id AS id, t.description AS description, t.payee AS payee, p.amount AS amount, a.id AS categoryId
    FROM transactions t
    JOIN postings p ON p.transaction_id = t.id
    JOIN accounts a ON a.id = p.account_id
    WHERE a.type = 'expense' AND a.name = 'Uncategorized' AND p.amount > 0
      AND (SELECT COUNT(*) FROM postings q WHERE q.transaction_id = t.id) = 2`);
}

function totalSpending(db: Db) {
  return db.all<{ total: number | null }>(sql`
    SELECT SUM(p.amount) AS total FROM postings p JOIN accounts a ON a.id = p.account_id WHERE a.type = 'expense'`)[0]?.total ?? 0;
}

// ---- Money put into investments that is counted as spending ---------------

const INVESTMENTS = [
  { label: 'PPF', account: 'PPF', find: 'ppf', test: /\bppf\b/i, pattern: () => 'ppf', fallbackToOnlyInvestment: false },
  { label: 'NPS', account: 'NPS', find: 'nps', test: /\bnps\b|national pension/i, pattern: () => 'nps', fallbackToOnlyInvestment: false },
  { label: 'EPF', account: 'EPF', find: 'epf', test: /\bepf\b|provident fund/i, pattern: () => 'epf', fallbackToOnlyInvestment: false },
  {
    label: 'mutual funds',
    account: 'Mutual funds',
    find: 'mutual fund',
    test: /indian clearing|\biccl\b|scripbox|zerodha coin|\bgroww\b|kuvera|et ?money|bse star|mutual fund|\bsip\b|\bmfu\b/i,
    pattern: (row: Row, matched: string) => row.payee?.trim() || matched.toLowerCase(),
    fallbackToOnlyInvestment: true,
  },
] as const;

function investmentTarget(db: Db, spec: (typeof INVESTMENTS)[number]) {
  const assets = listAccounts(db).filter((a) => a.type === 'asset' && !a.isArchived);
  const named = assets.find((a) => a.name.toLowerCase().includes(spec.find));
  if (named) return named;
  const investments = assets.filter((a) => a.subtype === 'investment');
  return spec.fallbackToOnlyInvestment && investments.length === 1 ? investments[0] : undefined;
}

function investmentInsights(db: Db, rows: Row[]) {
  const found: Built[] = [];
  const flagged = new Set<number>();

  for (const spec of INVESTMENTS) {
    const matches: { row: Row; pattern: string }[] = [];
    for (const row of rows) {
      const text = `${row.payee ?? ''} ${row.description}`;
      const hit = spec.test.exec(text);
      if (hit) matches.push({ row, pattern: spec.pattern(row, hit[0]) });
    }
    if (matches.length === 0) continue;

    const picked = matches.map((m) => m.row);
    matches.forEach((m) => flagged.add(m.row.id));
    const patterns = [...new Set(matches.map((m) => m.pattern))];
    const total = sum(picked);

    found.push({
      key: `investments:${spec.account}`,
      kind: 'investments',
      severity: 'attention',
      title: `${formatAmount(total)} that looks like ${spec.label} is counted as spending`,
      detail: `${plural(picked.length, 'transaction')}, such as ${patterns.slice(0, 3).join(', ')}. Money put into an investment is not spent, so moving it to ${spec.account} fixes your savings and net worth.`,
      amount: total,
      action: { type: 'fix', label: `Move to ${spec.account}`, note: 'Creates the account if you have none, and a rule so future imports do the same.' },
      apply: () => {
        const target = investmentTarget(db, spec) ?? createAccount(db, { name: spec.account, type: 'asset', subtype: 'investment' });
        let moved = 0;
        for (const pattern of patterns) {
          const rule = createRule(db, { pattern, categoryId: target.id });
          moved += applyRule(db, rule.id).updated;
        }
        return { message: `Moved ${plural(moved, 'transaction')} to ${target.name}, and added ${plural(patterns.length, 'rule')} for future imports.` };
      },
    });
  }
  return { found, flagged };
}

// ---- Credit card payments counted as spending ------------------------------

function cardPaymentInsight(db: Db, rows: Row[], skip: Set<number>): Built | undefined {
  const payments = rows.filter((row) => !skip.has(row.id) && parseNarration(row.description).channel === 'card_payment');
  if (payments.length === 0) return undefined;

  // The wording before the reference carries the card's last four digits, so it names the card.
  const groups = new Map<string, Row[]>();
  for (const row of payments) {
    const pattern = row.description.split(/#|\bref\b/i)[0]!.replace(/\s+/g, ' ').trim();
    if (pattern.length >= 4) groups.set(pattern, [...(groups.get(pattern) ?? []), row]);
  }
  const grouped = [...groups.values()].flat();
  if (grouped.length === 0) return undefined;

  const cards = listAccounts(db).filter((a) => a.type === 'liability' && a.subtype === 'credit_card' && !a.isArchived);
  const targets = [...groups.keys()].map((pattern) => {
    const digits = /\b(\d{4})\b/.exec(pattern)?.[1];
    const byDigits = cards.filter((card) => digits && card.numberLast4 === digits);
    return { pattern, digits, card: byDigits.length === 1 ? byDigits[0] : cards.length === 1 ? cards[0] : undefined };
  });

  const total = sum(grouped);
  const base = {
    key: 'card_payments',
    kind: 'card_payments' as const,
    severity: 'attention' as const,
    title: `${formatAmount(total)} of credit card payments is counted as spending`,
    detail: `${plural(grouped.length, 'payment')}. Paying a card bill moves money you have already counted when you spent it on the card, so counting it again overstates your spending.`,
    amount: total,
  };

  if (targets.every((t) => t.card)) {
    return {
      ...base,
      action: { type: 'fix', label: 'Treat as card payments', note: 'Moves them to the card as transfers, with a rule for future imports.' },
      apply: () => {
        let moved = 0;
        for (const { pattern, card } of targets) {
          const rule = createRule(db, { pattern, categoryId: card!.id });
          moved += applyRule(db, rule.id).updated;
        }
        return { message: `Treated ${plural(moved, 'payment')} as card payments, with ${plural(targets.length, 'rule')} for future imports.` };
      },
    };
  }

  const digits = targets.find((t) => t.digits)?.digits;
  const unsortedAccount = unsortedSpending(db)[0]?.categoryId;
  return {
    ...base,
    action:
      cards.length === 0
        ? { type: 'link', label: 'Add your credit card', to: '/accounts', search: { add: 'credit_card', name: digits ? `Credit Card ${digits}` : 'Credit Card', ...(digits ? { last4: digits } : {}) } }
        : { type: 'link', label: 'Review them', to: '/transactions', search: { account: unsortedAccount ?? 0 } },
  };
}

// ---- Balances that disagree with the bank ------------------------------------

function statementBalanceInsights(db: Db): Built[] {
  return statementBalanceChecks(db).map((check) => ({
    key: `statement_balance:${check.accountId}:${check.asOf}:${check.difference}`,
    kind: 'balance' as const,
    severity: 'attention' as const,
    title: `${check.accountName} is ${formatAmount(check.ledger)} in your books but ${formatAmount(check.statement)} on its ${check.asOf} statement`,
    detail:
      'Net worth and idle cash rely on this balance. The gap is usually money the account held before your first imported statement, or a statement that is missing.',
    amount: Math.abs(check.difference),
    action: {
      type: 'fix' as const,
      label: 'Match the statement',
      note: `Adds ${formatAmount(Math.abs(check.difference))} as an opening balance before the first transaction. Nothing in your history changes.`,
    },
    apply: () => {
      matchStatementBalance(db, check.accountId);
      return { message: `${check.accountName} now matches its statement.` };
    },
  }));
}

// ---- Statements that were never imported -------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

// "Apr 2026 to Jun 2026, Sep 2026" from the months that have no statement.
function monthRanges(months: string[]) {
  const ranges: string[][] = [];
  for (const month of months) {
    const last = ranges[ranges.length - 1];
    const [y, m] = month.split('-').map(Number) as [number, number];
    const previous = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    if (last && last[last.length - 1] === previous) last.push(month);
    else ranges.push([month]);
  }
  return ranges.map((range) => (range.length === 1 ? monthLabel(range[0]!) : `${monthLabel(range[0]!)} to ${monthLabel(range[range.length - 1]!)}`)).join(', ');
}

function coverageInsights(db: Db): Built[] {
  return statementCoverage(db)
    .filter((account) => account.missing.length > 0)
    .map((account) => ({
      // Changes with the set of missing months, so importing some of them does not hide the rest.
      key: `coverage:${account.accountId}:${account.missing.join(',').slice(0, 120)}`,
      kind: 'coverage' as const,
      severity: 'info' as const,
      title: `${account.accountName} has no statement for ${monthRanges(account.missing)}`,
      detail:
        account.kind === 'credit_card'
          ? 'Card payments from your bank are recorded for those months, but the purchases are not, so the card can show a credit. Import those statements.'
          : 'Transactions for those months are missing, so balances and reports for them are incomplete. Import those statements.',
      amount: null,
      action: { type: 'link' as const, label: 'Import statements', to: '/import' as const },
    }));
}

// ---- The rest ---------------------------------------------------------------

function balanceInsights(db: Db): Built[] {
  const found: Built[] = [];
  for (const account of getBalances(db)) {
    if (account.isArchived || account.balance >= 0) continue;
    if (account.type === 'asset' && ['bank', 'cash', 'wallet'].includes(account.subtype ?? 'bank')) {
      found.push({
        key: `balance:${account.id}`,
        kind: 'balance',
        severity: 'info',
        title: `${account.name} is ${formatAmount(-account.balance)} below zero`,
        detail: 'If that is not right, add its opening balance on the Accounts page, or an earlier statement may be missing.',
        amount: -account.balance,
        action: { type: 'link', label: 'Open accounts', to: '/accounts' },
      });
    } else if (account.type === 'liability') {
      found.push({
        key: `balance:${account.id}`,
        kind: 'balance',
        severity: 'info',
        title: `${account.name} shows a credit of ${formatAmount(-account.balance)}`,
        detail: 'More has been paid to it than charged. A payment may be counted twice, or earlier charges may be missing.',
        amount: -account.balance,
        action: { type: 'link', label: 'See its transactions', to: '/transactions', search: { account: account.id } },
      });
    }
  }
  return found;
}

export function buildInsights(db: Db): Built[] {
  const rows = unsortedSpending(db);
  const { found: investments, flagged } = investmentInsights(db, rows);
  const cards = cardPaymentInsight(db, rows, flagged);
  const handled = new Set(flagged);
  if (cards) for (const row of rows) if (parseNarration(row.description).channel === 'card_payment') handled.add(row.id);

  const found: Built[] = [...investments];
  if (cards) found.push(cards);

  // What is left uncategorised once the more specific findings are set aside.
  const remainder = rows.filter((row) => !handled.has(row.id));
  const left = sum(remainder);
  const spending = totalSpending(db);
  if (left >= 100_000 && spending > 0 && left / spending >= 0.2) {
    const share = left / spending;
    found.push({
      key: 'uncategorized',
      kind: 'uncategorized',
      severity: share >= 0.5 ? 'attention' : 'info',
      title: `${formatAmount(left)} of your spending (${Math.round(share * 100)}%) is still uncategorised`,
      detail: `${plural(remainder.length, 'transaction')}. Reports and budgets are only as good as the categories. Sorting a payee once with a rule sorts it for good.`,
      amount: left,
      action: { type: 'link', label: 'Sort them', to: '/transactions', search: { account: rows[0]!.categoryId } },
    });
  }

  found.push(...statementBalanceInsights(db));
  found.push(...coverageInsights(db));
  found.push(...balanceInsights(db));

  const staged = listImportBatches(db).filter((batch) => batch.status === 'staged').length;
  if (staged > 0) {
    found.push({
      key: 'imports',
      kind: 'imports',
      severity: 'info',
      title: `${plural(staged, 'statement import is', 'statement imports are')} waiting for review`,
      detail: 'Nothing from them is in your books until you review and import them.',
      amount: null,
      action: { type: 'link', label: 'Review', to: '/import' },
    });
  }

  const suggestions = suggestRules(db);
  if (suggestions.length > 0 && getAutoRuleMode(db) === 'off') {
    found.push({
      key: 'rules',
      kind: 'rules',
      severity: 'info',
      title: `${plural(suggestions.length, 'rule')} suggested from your own choices`,
      detail: 'A rule files a payee the same way every time. Add them in one click, or turn on automatic rules.',
      amount: null,
      action: { type: 'link', label: 'See suggested rules', to: '/rules' },
    });
  }

  const budgets = budgetStatus(db);
  const over = budgets.items.filter((item) => item.state === 'over');
  const watch = budgets.items.filter((item) => item.state === 'watch');
  if (over.length + watch.length > 0) {
    const names = (list: typeof over) => list.slice(0, 3).map((item) => item.name).join(', ');
    found.push({
      // Per month, so turning it down does not hide next month's.
      key: `budgets:${budgets.month}`,
      kind: 'budgets',
      severity: over.length > 0 ? 'attention' : 'info',
      title:
        over.length > 0
          ? `${plural(over.length, 'budget is', 'budgets are')} over this month`
          : `${plural(watch.length, 'budget is', 'budgets are')} close to the limit`,
      detail: [over.length > 0 && `Over: ${names(over)}.`, watch.length > 0 && `Close: ${names(watch)}.`].filter(Boolean).join(' '),
      amount: over.reduce((total, item) => total - item.remaining, 0) || null,
      action: { type: 'link', label: 'See budgets', to: '/budgets' },
    });
  }

  const week = recurringPayments(db).filter((item) => item.status === 'upcoming' && item.dueIn <= 7);
  if (week.length > 0) {
    const names = week.slice(0, 3).map((item) => item.label).join(', ');
    found.push({
      // Changes as the set changes, so a turned-down week does not hide the next one.
      key: `bills:${week.map((item) => `${item.key}@${item.nextDue}`).join(',').slice(0, 150)}`,
      kind: 'bills',
      severity: 'info',
      title: `${plural(week.length, 'bill')} expected in the next 7 days`,
      detail: `${names}${week.length > 3 ? ` and ${week.length - 3} more` : ''}. Make sure the money is there.`,
      amount: week.reduce((total, item) => total + item.amount, 0),
      action: { type: 'link', label: 'See bills', to: '/bills' },
    });
  }

  const ahead = forecast(db, { days: 30 });
  // An account that is already below zero is a data problem, found elsewhere.
  if (ahead.start >= 0 && (ahead.includesEverydaySpending || ahead.events.length > 0) && ahead.firstBelowZero) {
    found.push({
      key: `forecast:${ahead.firstBelowZero}`,
      kind: 'forecast',
      severity: 'attention',
      title: `Your bank balance is on course to run out around ${ahead.firstBelowZero}`,
      detail: `At your usual pace of bills, income and spending it would fall to ${formatAmount(ahead.lowest.balance)}. Move money in, or see what is due.`,
      amount: Math.abs(ahead.lowest.balance),
      action: { type: 'link', label: 'See the forecast', to: '/forecast' },
    });
  }

  const odd = anomalies(db);
  if (odd.length > 0) {
    found.push({
      // Changes as the set changes, so a new one is never hidden by turning an old one down.
      key: `anomalies:${odd.map((a) => a.key).join(',').slice(0, 180)}`,
      kind: 'anomalies',
      severity: odd.some((a) => a.kind === 'duplicate' || a.kind === 'unusual') ? 'attention' : 'info',
      title: odd.length === 1 ? odd[0]!.title : `${odd.length} things in your spending look off`,
      detail: odd.length === 1 ? odd[0]!.detail : odd.slice(0, 3).map((a) => a.title).join('. '),
      amount: odd.reduce((t, a) => t + a.amount, 0),
      action: { type: 'link', label: 'Look at transactions', to: '/transactions' },
    });
  }

  const bills = cardDues(db).filter((d) => d.daysToDue <= 5);
  if (bills.length > 0) {
    found.push({
      key: `cards:${bills.map((d) => `${d.accountId}@${d.dueDate}`).join(',')}`,
      kind: 'cards',
      severity: bills.some((d) => d.overdue) ? 'attention' : 'info',
      title: bills.length === 1 ? `${bills[0]!.name} bill ${bills[0]!.overdue ? 'is overdue' : bills[0]!.daysToDue === 0 ? 'is due today' : `is due in ${bills[0]!.daysToDue} days`}` : `${bills.length} card bills are due soon`,
      detail: bills.map((d) => `${d.name}: ${formatAmount(d.remaining)} by ${d.dueDate}`).join('. ') + '. Paying only the minimum costs heavy interest.',
      amount: bills.reduce((t, d) => t + d.remaining, 0),
      action: { type: 'link', label: 'See accounts', to: '/accounts' },
    });
  }

  const renewals = listPolicies(db).filter((p) => p.daysToDue <= 14);
  if (renewals.length > 0) {
    found.push({
      key: `policies:${renewals.map((p) => `${p.id}@${p.nextDue}`).join(',')}`,
      kind: 'policies',
      severity: renewals.some((p) => p.daysToDue <= 3) ? 'attention' : 'info',
      title: `${plural(renewals.length, 'insurance premium')} due within 2 weeks`,
      detail: `${renewals.map((p) => `${p.name} on ${p.nextDue}`).join(', ')}. A lapsed policy can cost you cover or a waiting period.`,
      amount: renewals.reduce((t, p) => t + p.premium, 0),
      action: { type: 'link', label: 'See policies', to: '/loans' },
    });
  }

  const maturing = listAssets(db).items.filter((a) => a.daysToMaturity !== null && a.daysToMaturity >= 0 && a.daysToMaturity <= 30);
  if (maturing.length > 0) {
    found.push({
      key: `maturing:${maturing.map((a) => `${a.accountId}@${a.maturityDate}`).join(',').slice(0, 150)}`,
      kind: 'assets',
      severity: 'info',
      title: `${plural(maturing.length, 'deposit')} maturing within 30 days`,
      detail: `${maturing.slice(0, 3).map((a) => `${a.name} on ${a.maturityDate}`).join(', ')}. Decide whether to renew or move the money.`,
      amount: maturing.reduce((total, a) => total + a.value, 0),
      action: { type: 'link', label: 'See assets', to: '/assets' },
    });
  }

  const pending = countPendingProposals(db);
  if (pending > 0) {
    found.push({
      key: 'agents',
      kind: 'agents',
      severity: 'info',
      title: `${plural(pending, 'suggestion')} from agents ${pending === 1 ? 'is' : 'are'} waiting for you`,
      detail: 'Nothing changes until you approve it.',
      amount: null,
      action: { type: 'link', label: 'Review', to: '/agents' },
    });
  }

  return found.sort(
    (a, b) => Number(b.severity === 'attention') - Number(a.severity === 'attention') || (b.amount ?? 0) - (a.amount ?? 0),
  );
}

const dismissKey = (key: string) => `insight:${key}`;

// What needs your attention, worked out from your own books.
export function computeInsights(db: Db): Insight[] {
  const turnedDown = dismissedKeys(db);
  return buildInsights(db)
    .filter((insight) => !turnedDown.has(dismissKey(insight.key)))
    .map(({ apply: _apply, ...insight }) => insight);
}

export function fixInsight(db: Db, key: string) {
  const insight = buildInsights(db).find((item) => item.key === key);
  if (!insight?.apply) throw new DomainError('not_found', 'That is no longer something to fix');
  return db.transaction((tx) => {
    const store = tx as unknown as Db;
    const fresh = buildInsights(store).find((item) => item.key === key);
    if (!fresh?.apply) throw new DomainError('not_found', 'That is no longer something to fix');
    return fresh.apply();
  });
}

export function dismissInsight(db: Db, key: string) {
  dismiss(db, dismissKey(key));
}
