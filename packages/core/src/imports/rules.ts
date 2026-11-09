import { accounts, rules, type Db } from '@ledgerly/db';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from '../errors.ts';
import { dismiss, dismissedKeys, getSetting, setSetting, undismiss } from '../settings.ts';
import { builtinCategory } from './categorize.ts';
import { setTransactionCategory } from '../transactions.ts';

// Deleting a rule remembers its pattern, so a suggestion or an automatic run does not bring it back.
export const ruleKey = (pattern: string) => `rule:${pattern.toLowerCase()}`;

export const createRuleSchema = z.object({
  pattern: z.string().trim().min(2).max(200),
  matchType: z.enum(['contains', 'regex']).default('contains'),
  categoryId: z.number().int().positive(),
  priority: z.number().int().min(0).max(10_000).default(100),
  minAmount: z.number().int().safe().positive().nullable().optional(),
  maxAmount: z.number().int().safe().positive().nullable().optional(),
  accountId: z.number().int().positive().nullable().optional(),
});

type Rule = typeof rules.$inferSelect;

export function listRules(db: Db) {
  return db
    .select({
      id: rules.id,
      pattern: rules.pattern,
      matchType: rules.matchType,
      priority: rules.priority,
      minAmount: rules.minAmount,
      maxAmount: rules.maxAmount,
      accountId: rules.accountId,
      isActive: rules.isActive,
      createdBy: rules.createdBy,
      categoryId: rules.categoryId,
      categoryName: accounts.name,
    })
    .from(rules)
    .innerJoin(accounts, eq(accounts.id, rules.categoryId))
    .orderBy(asc(rules.priority), asc(rules.id))
    .all();
}

export function activeRules(db: Db) {
  return db
    .select()
    .from(rules)
    .where(eq(rules.isActive, true))
    .orderBy(asc(rules.priority), asc(rules.id))
    .all();
}

// Checks a rule without saving it, so a suggestion can be vetted before anyone sees it.
export function validateRule(db: Db, input: z.input<typeof createRuleSchema>) {
  const fields = createRuleSchema.parse(input);
  if (fields.matchType === 'regex') {
    try {
      new RegExp(fields.pattern, 'i');
    } catch {
      throw new DomainError('invalid', 'That is not a valid pattern');
    }
  }

  if (fields.minAmount && fields.maxAmount && fields.minAmount > fields.maxAmount) {
    throw new DomainError('invalid', 'The smallest amount is more than the largest');
  }
  if (fields.accountId && !db.select().from(accounts).where(eq(accounts.id, fields.accountId)).get()) {
    throw new DomainError('invalid', 'Choose one of your accounts');
  }
  const category = db.select().from(accounts).where(eq(accounts.id, fields.categoryId)).get();
  if (!category || category.type === 'equity') {
    throw new DomainError('invalid', 'Choose a category or an account for this rule');
  }
  return { fields, category };
}

export function createRule(db: Db, input: z.input<typeof createRuleSchema>, createdBy: 'manual' | 'auto' = 'manual') {
  const { fields } = validateRule(db, input);
  // Making a rule by hand overrides an earlier "no".
  if (createdBy === 'manual') undismiss(db, ruleKey(fields.pattern));

  const same = db
    .select()
    .from(rules)
    .all()
    .find(
      (r) =>
        r.pattern.toLowerCase() === fields.pattern.toLowerCase() &&
        r.matchType === fields.matchType &&
        (r.minAmount ?? null) === (fields.minAmount ?? null) &&
        (r.maxAmount ?? null) === (fields.maxAmount ?? null) &&
        (r.accountId ?? null) === (fields.accountId ?? null),
    );
  if (same) {
    return db.update(rules).set({ categoryId: fields.categoryId, isActive: true }).where(eq(rules.id, same.id)).returning().get();
  }
  return db.insert(rules).values({ ...fields, createdBy }).returning().get();
}

export function deleteRule(db: Db, id: number) {
  const rule = db.select().from(rules).where(eq(rules.id, id)).get();
  if (!rule) throw new DomainError('not_found', `Rule ${id} not found`);
  db.delete(rules).where(eq(rules.id, id)).run();
  dismiss(db, ruleKey(rule.pattern));
}

// What else is known about a payment, for the rule's conditions. A condition
// that cannot be checked (an unknown amount or account) does not match, so a
// rule never fires on a guess.
export type RuleContext = { amount?: number | null; accountId?: number | null };

export function ruleMatches(rule: Rule, text: string, context: RuleContext = {}) {
  if (rule.minAmount != null || rule.maxAmount != null) {
    if (context.amount == null) return false;
    const size = Math.abs(context.amount);
    if (rule.minAmount != null && size < rule.minAmount) return false;
    if (rule.maxAmount != null && size > rule.maxAmount) return false;
  }
  if (rule.accountId != null && context.accountId !== rule.accountId) return false;
  if (rule.matchType === 'contains') return text.toLowerCase().includes(rule.pattern.toLowerCase());
  try {
    return new RegExp(rule.pattern, 'i').test(text);
  } catch {
    return false;
  }
}

export function firstMatchingRule(all: Rule[], row: { description: string; payee?: string | null; amount?: number | null; accountId?: number | null }) {
  const text = `${row.payee ?? ''} ${row.description}`;
  return all.find((rule) => ruleMatches(rule, text, row));
}

export const updateRuleSchema = z.object({
  pattern: z.string().trim().min(2).max(200).optional(),
  matchType: z.enum(['contains', 'regex']).optional(),
  categoryId: z.number().int().positive().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
  minAmount: z.number().int().safe().positive().nullable().optional(),
  maxAmount: z.number().int().safe().positive().nullable().optional(),
  accountId: z.number().int().positive().nullable().optional(),
});

export function updateRule(db: Db, id: number, input: z.input<typeof updateRuleSchema>) {
  const changes = updateRuleSchema.parse(input);
  const current = db.select().from(rules).where(eq(rules.id, id)).get();
  if (!current) throw new DomainError('not_found', `Rule ${id} not found`);
  validateRule(db, {
    pattern: changes.pattern ?? current.pattern,
    matchType: changes.matchType ?? current.matchType,
    categoryId: changes.categoryId ?? current.categoryId,
    priority: changes.priority ?? current.priority,
    minAmount: changes.minAmount === undefined ? current.minAmount : changes.minAmount,
    maxAmount: changes.maxAmount === undefined ? current.maxAmount : changes.maxAmount,
    accountId: changes.accountId === undefined ? current.accountId : changes.accountId,
  });
  if (Object.keys(changes).length === 0) return current;
  return db.update(rules).set(changes).where(eq(rules.id, id)).returning().get();
}

type Candidate = { id: number; description: string; payee: string | null; notes: string | null; category: string; categoryType: string; amount: number; accountId: number | null };

// Transactions with one money side and one category, which is what a rule can change.
function candidates(db: Db) {
  return db.all<Candidate>(sql`
    SELECT t.id AS id, t.description AS description, t.payee AS payee, t.notes AS notes, a.name AS category, a.type AS categoryType, p.amount AS amount,
      (SELECT q.account_id FROM postings q WHERE q.transaction_id = t.id AND q.id <> p.id) AS accountId
    FROM transactions t
    JOIN postings p ON p.transaction_id = t.id
    JOIN accounts a ON a.id = p.account_id
    WHERE a.type IN ('income', 'expense')
      AND (SELECT COUNT(*) FROM postings q WHERE q.transaction_id = t.id) = 2`);
}

const isCatchAll = (candidate: Candidate) => candidate.category === 'Uncategorized' || candidate.category === 'Other Income';
const textOf = (candidate: Candidate) => `${candidate.payee ?? ''} ${candidate.description}`;

// What a pattern would catch in the books today, so a rule is not saved blind.
export function previewRule(db: Db, input: { pattern: string; matchType?: 'contains' | 'regex'; minAmount?: number | null; maxAmount?: number | null; accountId?: number | null }) {
  const pattern = input.pattern.trim();
  const matchType = input.matchType ?? 'contains';
  if (pattern.length < 2) return { matches: 0, unsorted: 0, examples: [] as string[] };
  if (matchType === 'regex') {
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw new DomainError('invalid', 'That is not a valid pattern');
    }
  }
  const rule = { pattern, matchType, minAmount: input.minAmount ?? null, maxAmount: input.maxAmount ?? null, accountId: input.accountId ?? null } as typeof rules.$inferSelect;
  const found = candidates(db).filter((candidate) => ruleMatches(rule, textOf(candidate), candidate));
  return {
    matches: found.length,
    unsorted: found.filter(isCatchAll).length,
    examples: [...new Set(found.map((candidate) => candidate.payee ?? candidate.description))].slice(0, 5),
  };
}

// Applies rules to transactions that are still in a catch-all category, never to
// one you sorted yourself, and never turns spending into income or the reverse.
function applyTo(db: Db, ruleList: (typeof rules.$inferSelect)[]) {
  const targets = new Map(
    db.select().from(accounts).all().map((account) => [account.id, account]),
  );
  const changed = new Set<number>();
  for (const candidate of candidates(db)) {
    if (!isCatchAll(candidate) || changed.has(candidate.id)) continue;
    const rule = ruleList.find((r) => ruleMatches(r, textOf(candidate), candidate));
    const target = rule && targets.get(rule.categoryId);
    if (!rule || !target) continue;
    const sameKind = target.type === candidate.categoryType;
    const transferOut = (target.type === 'asset' || target.type === 'liability') && candidate.categoryType === 'expense';
    if (!sameKind && !transferOut) continue;
    try {
      setTransactionCategory(db, candidate.id, rule.categoryId);
      changed.add(candidate.id);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return { updated: changed.size };
}

export function applyRule(db: Db, id: number) {
  const rule = db.select().from(rules).where(eq(rules.id, id)).get();
  if (!rule) throw new DomainError('not_found', `Rule ${id} not found`);
  return db.transaction((tx) => applyTo(tx as unknown as Db, [rule]));
}

export function applyAllRules(db: Db) {
  return db.transaction((tx) => applyTo(tx as unknown as Db, activeRules(tx as unknown as Db)));
}

const MIN_SEEN = 3;
const MIN_SHARE = 0.8;

// Payees you have put in the same category again and again, and no rule covers
// yet. Suggesting them is safe; creating them unasked would not be, since a
// wrong rule quietly mislabels every later import.
export function suggestRules(db: Db) {
  const rows = db.all<{ payee: string; name: string; categoryId: number; categoryName: string; count: number }>(sql`
    SELECT lower(t.payee) AS payee, MAX(t.payee) AS name, a.id AS categoryId, a.name AS categoryName, COUNT(*) AS count
    FROM transactions t
    JOIN postings p ON p.transaction_id = t.id
    JOIN accounts a ON a.id = p.account_id
    WHERE t.payee IS NOT NULL AND a.type IN ('income', 'expense')
      AND a.name NOT IN ('Uncategorized', 'Other Income')
      AND (SELECT COUNT(*) FROM postings q WHERE q.transaction_id = t.id) = 2
    GROUP BY lower(t.payee), a.id`);

  const byPayee = new Map<string, typeof rows>();
  for (const row of rows) byPayee.set(row.payee, [...(byPayee.get(row.payee) ?? []), row]);

  const all = candidates(db);
  const unsorted = new Map<string, number>();
  for (const candidate of all) {
    if (candidate.payee && isCatchAll(candidate)) {
      const key = candidate.payee.toLowerCase();
      unsorted.set(key, (unsorted.get(key) ?? 0) + 1);
    }
  }

  // Any existing rule counts, switched on or off, and so does one you deleted.
  const every = db.select().from(rules).all();
  const turnedDown = dismissedKeys(db);
  const active = every.filter((rule) => rule.isActive);

  const suggestions: {
    pattern: string;
    categoryId: number;
    categoryName: string;
    seen: number;
    unsorted: number;
    // Transactions the pattern would also catch that you put somewhere else.
    conflicts: number;
  }[] = [];
  for (const [payee, choices] of byPayee) {
    const total = choices.reduce((sum, choice) => sum + choice.count, 0);
    const best = choices.reduce((top, choice) => (choice.count > top.count ? choice : top));
    if (best.count < MIN_SEEN || best.count / total < MIN_SHARE || best.name.length < 2) continue;
    if (turnedDown.has(ruleKey(best.name))) continue;
    if (every.some((rule) => rule.pattern.toLowerCase() === best.name.toLowerCase())) continue;
    if (active.some((rule) => ruleMatches(rule, best.name))) continue;

    const needle = best.name.toLowerCase();
    const conflicts = all.filter(
      (candidate) => !isCatchAll(candidate) && candidate.category !== best.categoryName && textOf(candidate).toLowerCase().includes(needle),
    ).length;
    suggestions.push({ pattern: best.name, categoryId: best.categoryId, categoryName: best.categoryName, seen: best.count, unsorted: unsorted.get(payee) ?? 0, conflicts });
  }
  return suggestions.sort((a, b) => b.unsorted - a.unsorted || b.seen - a.seen).slice(0, 20);
}

export const AUTO_RULE_MODES = ['off', 'create', 'create_and_apply'] as const;
export type AutoRuleMode = (typeof AUTO_RULE_MODES)[number];
const AUTO_KEY = 'auto_rules';
const AUTO_MIN_LENGTH = 4;

export function getAutoRuleMode(db: Db): AutoRuleMode {
  const saved = getSetting(db, AUTO_KEY);
  return AUTO_RULE_MODES.find((mode) => mode === saved) ?? 'off';
}

export function setAutoRuleMode(db: Db, mode: AutoRuleMode) {
  if (!AUTO_RULE_MODES.includes(mode)) throw new DomainError('invalid', 'Unknown setting');
  setSetting(db, AUTO_KEY, mode);
}

// Creates the rules that would otherwise be suggested, when you have asked for
// that. It only acts on a payee seen several times with one clear category,
// whose name is not so short that it would match unrelated things, and which
// would not catch anything you filed elsewhere.
export function runAutoRules(db: Db) {
  const mode = getAutoRuleMode(db);
  const outcome = { created: 0, sorted: 0 };
  if (mode === 'off') return outcome;

  for (const suggestion of suggestRules(db)) {
    if (suggestion.conflicts > 0 || suggestion.pattern.length < AUTO_MIN_LENGTH) continue;
    const rule = createRule(db, { pattern: suggestion.pattern, categoryId: suggestion.categoryId }, 'auto');
    outcome.created += 1;
    if (mode === 'create_and_apply' && suggestion.unsorted > 0) outcome.sorted += applyRule(db, rule.id).updated;
  }
  return outcome;
}

// The payees whose transactions are still uncategorised, biggest first. This is
// where to start when little is sorted yet, since a rule can only be suggested
// from choices you have already made. Each comes with a guess where the built-in
// merchant list knows it, and a flag for payments to individuals, which are
// worth deciding together.
export function uncategorizedPayees(db: Db, limit = 40) {
  const active = db.select().from(rules).where(eq(rules.isActive, true)).all();
  const spending = new Map(
    db.select().from(accounts).where(eq(accounts.type, 'expense')).all().filter((a) => !a.isArchived).map((a) => [a.name, a.id]),
  );
  const groups = new Map<
    string,
    { payee: string; type: 'expense' | 'income'; transactions: number; total: number; person: boolean }
  >();

  for (const candidate of candidates(db)) {
    if (!isCatchAll(candidate) || !candidate.payee) continue;
    if (active.some((rule) => ruleMatches(rule, candidate.payee!))) continue;
    const type = candidate.categoryType as 'expense' | 'income';
    const key = `${candidate.payee.toLowerCase()}|${type}`;
    const group = groups.get(key) ?? { payee: candidate.payee, type, transactions: 0, total: 0, person: false };
    group.transactions += 1;
    group.total += Math.abs(candidate.amount);
    // Axis marks a payment to a person's account P2A, and one to a merchant P2M.
    if (/\/P2A\//i.test(candidate.notes ?? '')) group.person = true;
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, Math.min(Math.max(limit, 1), 200))
    .map((group) => {
      const guess =
        group.type === 'expense' && !group.person
          ? builtinCategory({ channel: 'upi', payee: group.payee }, group.payee, 'out')
          : undefined;
      const categoryId = guess ? spending.get(guess) : undefined;
      return { ...group, suggestion: categoryId ? { categoryId, categoryName: guess! } : null };
    });
}


export type RuleProblem = { ruleId: number; pattern: string; categoryName: string; kind: 'unused' | 'shadowed' | 'conflict'; reason: string };

const sameConditions = (a: Rule, b: Rule) => (a.minAmount ?? null) === (b.minAmount ?? null) && (a.maxAmount ?? null) === (b.maxAmount ?? null) && (a.accountId ?? null) === (b.accountId ?? null);

// Rules that do nothing useful: one that matches nothing in your books, one that
// a broader rule above it always gets to first, and a pair that send the same
// kind of payment to different places. Found by comparing the rules with your own
// transactions and with each other. Nothing is removed for you.
export function ruleHealth(db: Db, input: { today?: string } = {}): RuleProblem[] {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const all = db.select().from(rules).orderBy(asc(rules.priority), asc(rules.id)).all();
  const names = new Map(db.select().from(accounts).all().map((a) => [a.id, a.name]));
  const seen = candidates(db);
  const problems: RuleProblem[] = [];
  const add = (rule: Rule, kind: RuleProblem['kind'], reason: string) =>
    problems.push({ ruleId: rule.id, pattern: rule.pattern, categoryName: names.get(rule.categoryId) ?? 'a category', kind, reason });

  for (const [index, rule] of all.entries()) {
    const ageDays = (Date.parse(today) - Date.parse(rule.createdAt.slice(0, 10))) / 86_400_000;
    if (ageDays > 60 && !seen.some((c) => ruleMatches(rule, textOf(c), c))) {
      add(rule, 'unused', 'It matches nothing in your books, so it can go.');
      continue;
    }
    // A simple "contains" rule above this one whose text is part of this one's: it always wins.
    const above = all.slice(0, index).find((other) => other.matchType === 'contains' && rule.matchType === 'contains' && other.isActive && sameConditions(other, rule) && rule.pattern.toLowerCase().includes(other.pattern.toLowerCase()));
    if (above) {
      add(
        rule,
        above.categoryId === rule.categoryId ? 'shadowed' : 'conflict',
        above.categoryId === rule.categoryId
          ? `"${above.pattern}" already covers it, in the same category.`
          : `"${above.pattern}" comes first and sends these to ${names.get(above.categoryId) ?? 'another category'}, so this one never applies. Lower the other one's order or remove it.`,
      );
    }
  }
  return problems;
}
