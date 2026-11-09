import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from './accounts.ts';
import { forecast } from './forecast.ts';
import { computeEmi, createLoan, deleteLoan, listLoans, schedule } from './loans.ts';
import { createPolicy, deletePolicy, listPolicies } from './policies.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';
import { createSimpleTransaction } from './transactions.ts';

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
});

describe('loans', () => {
  it('works out the EMI by the standard formula', () => {
    // 10 lakh at 9% for 10 years is about 12,668 a month.
    expect(computeEmi(10_00_000_00, 900, 120)).toBeGreaterThan(12_660_00);
    expect(computeEmi(10_00_000_00, 900, 120)).toBeLessThan(12_680_00);
    expect(computeEmi(12_000_00, 0, 12)).toBe(1_000_00);
  });

  it('builds a schedule that clears the debt, with interest first', () => {
    const emi = computeEmi(5_00_000_00, 1000, 60);
    const plan = schedule({ principal: 5_00_000_00, rateBps: 1000, emi, firstEmiDate: '2026-01-05', tenureMonths: 60 });
    expect(plan).toHaveLength(60);
    expect(plan[0]).toMatchObject({ number: 1, date: '2026-01-05', interest: Math.round(5_00_000_00 * 0.1 / 12) });
    expect(plan.at(-1)!.balance).toBe(0);
    expect(plan.at(-1)!.date).toBe('2030-12-05');
    expect(plan[1]!.interest).toBeLessThan(plan[0]!.interest);
  });

  it('shows where a loan stands, and what a prepayment would save', () => {
    createLoan(db, { name: 'Home loan', principal: 30_00_000_00, rateBps: 850, tenureMonths: 240, firstEmiDate: '2025-01-05' });
    const [loan] = listLoans(db, { today: '2026-11-10' });
    expect(loan).toMatchObject({ name: 'Home loan', instalmentsPaid: 23, instalmentsLeft: 217, nextDate: '2026-12-05', payoffDate: '2044-12-05' });
    expect(loan!.outstanding).toBeLessThan(30_00_000_00);
    expect(loan!.outstanding).toBeGreaterThan(28_00_000_00);
    expect(loan!.prepay).toMatchObject({ guaranteedReturnPercent: 8.5 });
    expect(loan!.prepay!.interestSaved).toBeGreaterThan(0);
    expect(loan!.prepay!.monthsSaved).toBeGreaterThan(0);
  });

  it('refuses an account that is not a liability, and removes a loan', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' }).id;
    expect(() => createLoan(db, { name: 'x', accountId: bank, principal: 1, rateBps: 1, tenureMonths: 1, firstEmiDate: '2026-01-01' })).toThrow(/liability/);
    const id = createLoan(db, { name: 'Car', principal: 5_00_000_00, rateBps: 900, tenureMonths: 60, firstEmiDate: '2026-01-05' });
    deleteLoan(db, id);
    expect(listLoans(db)).toEqual([]);
    expect(() => deleteLoan(db, id)).toThrow(/No such loan/);
  });
});

describe('insurance policies', () => {
  it('moves the premium date on by itself and counts the year\'s cost', () => {
    createPolicy(db, { name: 'Term plan', kind: 'term', insurer: 'Some Insurer', premium: 12_000_00, frequency: 'yearly', nextDue: '2025-12-15', sumAssured: 1_00_00_000_00 });
    createPolicy(db, { name: 'Health', kind: 'health', premium: 2_000_00, frequency: 'quarterly', nextDue: '2026-09-01' });
    const [soonest, later] = listPolicies(db, { today: '2026-11-10' });
    expect(soonest).toMatchObject({ name: 'Health', nextDue: '2026-12-01', daysToDue: 21, premiumPerYear: 8_000_00 });
    expect(later).toMatchObject({ name: 'Term plan', nextDue: '2026-12-15', premiumPerYear: 12_000_00 });
    deletePolicy(db, soonest!.id);
    expect(listPolicies(db)).toHaveLength(1);
    expect(() => createPolicy(db, { name: 'x', kind: 'life', premium: 0, frequency: 'yearly', nextDue: '2026-01-01' })).toThrow();
  });
});

describe('in the forecast', () => {
  it('counts EMIs and premiums once, and not again when the bank history already shows them', () => {
    const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 10_00_000_00, openingDate: '2026-01-01' }).id;
    createLoan(db, { name: 'Car loan', principal: 5_00_000_00, rateBps: 900, tenureMonths: 60, firstEmiDate: '2026-01-15' });
    createPolicy(db, { name: 'Term plan', kind: 'term', premium: 12_000_00, frequency: 'yearly', nextDue: '2026-12-20' });
    let f = forecast(db, { today: '2026-11-10', days: 60 });
    expect(f.events.filter((e) => e.label.startsWith('EMI:')).map((e) => e.date)).toEqual(['2026-11-15', '2026-12-15']);
    expect(f.events.filter((e) => e.label.startsWith('Premium:')).map((e) => e.date)).toEqual(['2026-12-20']);

    // Once the EMI shows up in the bank as a monthly payment, it is not added a second time.
    const emi = computeEmi(5_00_000_00, 900, 60);
    const rent = listAccounts(db).find((a) => a.name === 'Loan EMI')!.id;
    for (const d of ['2026-08-15', '2026-09-15', '2026-10-15']) {
      createSimpleTransaction(db, { date: d, description: 'Car loan EMI', kind: 'expense', accountId: bank, counterAccountId: rent, amount: emi } as never);
    }
    f = forecast(db, { today: '2026-11-10', days: 60 });
    const emiEvents = f.events.filter((e) => /\bemi\b/i.test(e.label));
    expect(emiEvents.map((e) => e.date)).toEqual(['2026-11-15', '2026-12-15']);
    expect(emiEvents.every((e) => e.label === 'Car loan EMI')).toBe(true);
  });
});
