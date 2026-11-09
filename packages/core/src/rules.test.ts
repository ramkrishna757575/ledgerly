import { accounts, openDb, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyAllRules,
  applyRule,
  createAccount,
  createRule,
  createSimpleTransaction,
  createTransaction,
  deleteRule,
  ensureStarterCategories,
  getAutoRuleMode,
  listRules,
  listTransactions,
  previewRule,
  runAutoRules,
  seedDefaults,
  setAutoRuleMode,
  suggestRules,
  setTransactionCategory,
  uncategorizedPayees,
  updateRule,
} from './index.ts';

let db: Db;
let bank: number;

const category = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).get()!.id;

function spend(payee: string, name = 'Uncategorized', amount = 500) {
  return createSimpleTransaction(db, { kind: 'expense', date: '2026-10-01', description: `UPI/${payee}`, payee, accountId: bank, counterAccountId: category(name), amount });
}

const categoryOf = (id: number) =>
  listTransactions(db, { limit: 200 }).items.find((t) => t.id === id)!.postings.find((p) => p.accountType === 'expense' || p.accountType === 'income')!.accountName;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', openingBalance: 1000000 }).id;
});

describe('editing a rule', () => {
  it('changes its category, priority and whether it is on', () => {
    const rule = createRule(db, { pattern: 'swiggy', categoryId: category('Food & Dining') });
    updateRule(db, rule.id, { categoryId: category('Groceries'), priority: 5, isActive: false });
    expect(listRules(db)[0]).toMatchObject({ categoryName: 'Groceries', priority: 5, isActive: false });
  });

  it('checks the result as a whole', () => {
    const rule = createRule(db, { pattern: 'swiggy', categoryId: category('Food & Dining') });
    expect(() => updateRule(db, rule.id, { matchType: 'regex', pattern: '(abc' })).toThrow(/valid pattern/);
    expect(() => updateRule(db, rule.id, { categoryId: 99999 })).toThrow(/Choose a category/);
    expect(() => updateRule(db, 999, { priority: 1 })).toThrow(/not found/);
    expect(listRules(db)[0]?.pattern).toBe('swiggy');
  });
});

describe('previewing a rule', () => {
  it('counts what it would catch and how much of that is still unsorted', () => {
    spend('Swiggy');
    spend('swiggy instamart', 'Groceries');
    spend('Zomato');
    const preview = previewRule(db, { pattern: 'SWIGGY' });
    expect(preview).toMatchObject({ matches: 2, unsorted: 1 });
    expect(preview.examples.sort()).toEqual(['Swiggy', 'swiggy instamart']);
  });

  it('understands patterns, and says when one is not valid', () => {
    spend('Swiggy');
    spend('Zomato');
    expect(previewRule(db, { pattern: 'swiggy|zomato', matchType: 'regex' }).matches).toBe(2);
    expect(() => previewRule(db, { pattern: '(abc', matchType: 'regex' })).toThrow(/valid pattern/);
    expect(previewRule(db, { pattern: 'x' })).toEqual({ matches: 0, unsorted: 0, examples: [] });
  });
});

describe('applying rules to what is already in the books', () => {
  it('sorts unsorted transactions and leaves the ones you chose alone', () => {
    const loose = spend('Swiggy');
    const chosen = spend('Swiggy', 'Travel');
    const rule = createRule(db, { pattern: 'swiggy', categoryId: category('Food & Dining') });

    expect(applyRule(db, rule.id)).toEqual({ updated: 1 });
    expect(categoryOf(loose.id)).toBe('Food & Dining');
    expect(categoryOf(chosen.id)).toBe('Travel');
    expect(applyRule(db, rule.id)).toEqual({ updated: 0 });
  });

  it('never turns spending into income or the reverse', () => {
    const out = spend('Acme');
    const incoming = createSimpleTransaction(db, { kind: 'income', date: '2026-10-02', description: 'Acme refund', payee: 'Acme', accountId: bank, counterAccountId: category('Other Income'), amount: 700 });
    const rule = createRule(db, { pattern: 'acme', categoryId: category('Shopping') });
    expect(applyRule(db, rule.id)).toEqual({ updated: 1 });
    expect(categoryOf(out.id)).toBe('Shopping');
    expect(categoryOf(incoming.id)).toBe('Other Income');
  });

  it('can send spending to a card as a transfer', () => {
    const card = createAccount(db, { name: 'Card', type: 'liability', subtype: 'credit_card' }).id;
    const payment = spend('Axis card payment');
    const rule = createRule(db, { pattern: 'card payment', categoryId: card });
    expect(applyRule(db, rule.id)).toEqual({ updated: 1 });
    expect(categoryOf).toBeDefined();
    expect(listTransactions(db).items.find((t) => t.id === payment.id)!.postings.map((p) => p.accountName).sort()).toEqual(['Bank', 'Card']);
  });

  it('applies every rule in priority order, the first match winning', () => {
    const tx = spend('Amazon Pay Groceries');
    createRule(db, { pattern: 'amazon', categoryId: category('Shopping'), priority: 200 });
    createRule(db, { pattern: 'groceries', categoryId: category('Groceries'), priority: 10 });
    createRule(db, { pattern: 'nothing here', categoryId: category('Health') });
    expect(applyAllRules(db)).toEqual({ updated: 1 });
    expect(categoryOf(tx.id)).toBe('Groceries');
  });

  it('skips turned-off rules and transactions with several categories', () => {
    const split = createTransaction(db, {
      date: '2026-10-03',
      description: 'Swiggy split',
      payee: 'Swiggy',
      postings: [
        { accountId: bank, amount: -300 },
        { accountId: category('Uncategorized'), amount: 200 },
        { accountId: category('Health'), amount: 100 },
      ],
    });
    const rule = createRule(db, { pattern: 'swiggy', categoryId: category('Food & Dining') });
    expect(applyRule(db, rule.id)).toEqual({ updated: 0 });
    updateRule(db, rule.id, { isActive: false });
    const loose = spend('Swiggy');
    expect(applyAllRules(db)).toEqual({ updated: 0 });
    expect(categoryOf(loose.id)).toBe('Uncategorized');
    expect(split.postings).toHaveLength(3);
  });

  it('is undone by changing the category back, like any other change', () => {
    const tx = spend('Swiggy');
    const rule = createRule(db, { pattern: 'swiggy', categoryId: category('Food & Dining') });
    applyRule(db, rule.id);
    setTransactionCategory(db, tx.id, category('Uncategorized'));
    expect(categoryOf(tx.id)).toBe('Uncategorized');
  });
});

describe('suggesting rules', () => {
  const many = (payee: string, name: string, times: number) => Array.from({ length: times }, () => spend(payee, name));

  it('offers a payee you keep putting in the same category', () => {
    many('Swiggy', 'Food & Dining', 4);
    spend('Swiggy');
    spend('Swiggy');
    expect(suggestRules(db)).toEqual([{ pattern: 'Swiggy', categoryId: category('Food & Dining'), categoryName: 'Food & Dining', seen: 4, unsorted: 2, conflicts: 0 }]);
  });

  it('waits until a payee has been seen enough, and agrees with itself', () => {
    many('Zomato', 'Food & Dining', 2);
    many('Amazon', 'Shopping', 3);
    many('Amazon', 'Groceries', 3);
    expect(suggestRules(db)).toEqual([]);
  });

  it('is happy with an odd one out when the rest agree', () => {
    many('BigBasket', 'Groceries', 9);
    spend('BigBasket', 'Shopping');
    expect(suggestRules(db)[0]).toMatchObject({ pattern: 'BigBasket', categoryName: 'Groceries', seen: 9 });
  });

  it('leaves out payees an active rule already covers, and brings them back if it is switched off', () => {
    many('Swiggy', 'Food & Dining', 3);
    const rule = createRule(db, { pattern: 'swig', categoryId: category('Food & Dining') });
    expect(suggestRules(db)).toEqual([]);
    updateRule(db, rule.id, { isActive: false });
    expect(suggestRules(db)).toHaveLength(1);
  });

  it('puts what would help most first, and ignores transfers and payee-less rows', () => {
    many('Netflix', 'Subscriptions', 5);
    many('Swiggy', 'Food & Dining', 3);
    spend('Swiggy');
    many('', 'Rent', 4);
    expect(suggestRules(db).map((s) => s.pattern)).toEqual(['Swiggy', 'Netflix']);
  });
});

describe('suggestions that must not be pushed', () => {
  const many = (payee: string, name: string, times: number) => Array.from({ length: times }, () => spend(payee, name));

  it('warns when a pattern would also catch something filed elsewhere', () => {
    many('Amazon', 'Shopping', 3);
    spend('Amazon Pay Groceries', 'Groceries');
    expect(suggestRules(db).find((s) => s.pattern === 'Amazon')).toMatchObject({ conflicts: 1 });
  });

  it('does not bring back a rule you deleted, and lets you make it again by hand', () => {
    many('Swiggy', 'Food & Dining', 3);
    const rule = createRule(db, { pattern: 'Swiggy', categoryId: category('Food & Dining') });
    deleteRule(db, rule.id);
    expect(suggestRules(db)).toEqual([]);
    createRule(db, { pattern: 'Swiggy', categoryId: category('Food & Dining') });
    expect(listRules(db)).toHaveLength(1);
    expect(suggestRules(db)).toEqual([]);
  });

  it('does not bring back a rule you switched off', () => {
    many('Swiggy', 'Food & Dining', 3);
    const rule = createRule(db, { pattern: 'Swiggy', categoryId: category('Food & Dining') });
    updateRule(db, rule.id, { isActive: false });
    expect(suggestRules(db)).toEqual([]);
  });
});

describe('automatic rules', () => {
  const many = (payee: string, name: string, times: number) => Array.from({ length: times }, () => spend(payee, name));

  it('does nothing unless asked', () => {
    many('Swiggy', 'Food & Dining', 3);
    expect(getAutoRuleMode(db)).toBe('off');
    expect(runAutoRules(db)).toEqual({ created: 0, sorted: 0 });
    expect(listRules(db)).toEqual([]);
  });

  it('creates rules, marked as automatic, without touching existing transactions', () => {
    many('Swiggy', 'Food & Dining', 3);
    const loose = spend('Swiggy');
    setAutoRuleMode(db, 'create');
    expect(runAutoRules(db)).toEqual({ created: 1, sorted: 0 });
    expect(listRules(db)[0]).toMatchObject({ pattern: 'Swiggy', createdBy: 'auto', categoryName: 'Food & Dining' });
    expect(categoryOf(loose.id)).toBe('Uncategorized');
  });

  it('can also sort what is still uncategorised', () => {
    many('Swiggy', 'Food & Dining', 3);
    const loose = spend('Swiggy');
    setAutoRuleMode(db, 'create_and_apply');
    expect(runAutoRules(db)).toEqual({ created: 1, sorted: 1 });
    expect(categoryOf(loose.id)).toBe('Food & Dining');
  });

  it('is finished after one run', () => {
    many('Swiggy', 'Food & Dining', 3);
    setAutoRuleMode(db, 'create');
    runAutoRules(db);
    expect(runAutoRules(db)).toEqual({ created: 0, sorted: 0 });
  });

  it('skips names too short to be safe and patterns that would catch other things', () => {
    many('Ola', 'Transport', 4);
    many('Amazon', 'Shopping', 3);
    spend('Amazon Pay Groceries', 'Groceries');
    setAutoRuleMode(db, 'create');
    expect(runAutoRules(db)).toEqual({ created: 0, sorted: 0 });
    // They are still offered, for a person to decide.
    expect(suggestRules(db).map((s) => s.pattern).sort()).toEqual(['Amazon', 'Ola']);
  });

  it('respects a rule you deleted', () => {
    many('Swiggy', 'Food & Dining', 3);
    setAutoRuleMode(db, 'create');
    runAutoRules(db);
    deleteRule(db, listRules(db)[0]!.id);
    expect(runAutoRules(db)).toEqual({ created: 0, sorted: 0 });
    expect(listRules(db)).toEqual([]);
  });

  it('knows only the settings that exist', () => {
    expect(() => setAutoRuleMode(db, 'always' as never)).toThrow(/Unknown setting/);
  });
});

describe('uncategorised payees', () => {
  it('groups what is still unsorted by payee, biggest first', () => {
    spend('Ravi Kumar', 'Uncategorized', 2000);
    spend('Cafe', 'Uncategorized', 300);
    spend('cafe', 'Uncategorized', 450);
    spend('Rent', 'Rent', 9000);
    expect(uncategorizedPayees(db).map((g) => [g.payee, g.type, g.transactions, g.total])).toEqual([
      ['Ravi Kumar', 'expense', 1, 2000],
      ['Cafe', 'expense', 2, 750],
    ]);
  });

  it('guesses a category where the built-in list knows the merchant', () => {
    spend('Canva', 'Uncategorized', 100);
    spend('Axis Max', 'Uncategorized', 700);
    spend('Google Pl', 'Uncategorized', 300);
    spend('Guddu Kumar', 'Uncategorized', 500);
    const guesses = Object.fromEntries(uncategorizedPayees(db).map((g) => [g.payee, g.suggestion?.categoryName ?? null]));
    expect(guesses).toEqual({ Canva: 'Subscriptions', 'Axis Max': 'Insurance', 'Google Pl': 'Subscriptions', 'Guddu Kumar': null });
  });

  it('flags payments to individuals, and does not guess for them', () => {
    const person = (name: string, rupees: number, notes: string) =>
      createSimpleTransaction(db, { kind: 'expense', date: '2026-10-01', description: name, payee: name, notes, accountId: bank, counterAccountId: category('Uncategorized'), amount: rupees });
    person('Guddu Kumar', 11171, 'UPI/P2A/628682171779/Guddu Kumar/UPI/Axis Bank');
    person('Canva', 100, 'UPI/P2M/628682171780/Canva/UPI/Axis Bank');
    // A person who happens to share a name with a merchant is still a person.
    person('Amazon Das', 500, 'UPI/P2A/628682171781/Amazon Das/UPI/Axis Bank');
    const byPayee = Object.fromEntries(uncategorizedPayees(db).map((g) => [g.payee, g]));
    expect(byPayee['Guddu Kumar']).toMatchObject({ person: true, suggestion: null });
    expect(byPayee['Amazon Das']).toMatchObject({ person: true, suggestion: null });
    expect(byPayee['Canva']).toMatchObject({ person: false, suggestion: { categoryName: 'Subscriptions' } });
  });

  it('keeps money in and money out apart, and skips rows with no payee', () => {
    spend('Acme', 'Uncategorized', 500);
    createSimpleTransaction(db, { kind: 'income', date: '2026-10-02', description: 'Acme refund', payee: 'Acme', accountId: bank, counterAccountId: category('Other Income'), amount: 70000 });
    createSimpleTransaction(db, { kind: 'expense', date: '2026-10-03', description: 'PPF/1/2', accountId: bank, counterAccountId: category('Uncategorized'), amount: 80000 });
    expect(uncategorizedPayees(db).map((g) => [g.payee, g.type])).toEqual([['Acme', 'income'], ['Acme', 'expense']]);
  });

  it('leaves out payees an active rule already covers', () => {
    spend('Swiggy', 'Uncategorized', 400);
    spend('Zomato', 'Uncategorized', 300);
    const rule = createRule(db, { pattern: 'swiggy', categoryId: category('Food & Dining') });
    expect(uncategorizedPayees(db).map((g) => g.payee)).toEqual(['Zomato']);
    updateRule(db, rule.id, { isActive: false });
    expect(uncategorizedPayees(db).map((g) => g.payee).sort()).toEqual(['Swiggy', 'Zomato']);
  });

  it('stops at the limit', () => {
    ['A1', 'B2', 'C3', 'D4'].forEach((name, i) => spend(name, 'Uncategorized', 100 + i));
    expect(uncategorizedPayees(db, 2)).toHaveLength(2);
  });
});

describe('the Friends & Family category', () => {
  const named = () => db.select().from(accounts).where(eq(accounts.name, 'Friends & Family')).all();

  it('is part of a fresh database', () => {
    expect(named()).toHaveLength(1);
    ensureStarterCategories(db);
    expect(named()).toHaveLength(1);
  });

  it('is added once to a database made before it existed, and then left alone', async () => {
    const { settings } = await import('@ledgerly/db');
    db.delete(accounts).where(eq(accounts.name, 'Friends & Family')).run();
    db.delete(settings).run();
    ensureStarterCategories(db);
    expect(named()).toHaveLength(1);

    // Renamed or removed by the person afterwards, it stays that way.
    db.update(accounts).set({ name: 'People' }).where(eq(accounts.name, 'Friends & Family')).run();
    ensureStarterCategories(db);
    expect(named()).toHaveLength(0);
  });
});
