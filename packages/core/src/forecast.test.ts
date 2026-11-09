import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from './accounts.ts';
import { forecast } from './forecast.ts';
import { recurringPayments } from './recurring.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';
import { createSimpleTransaction } from './transactions.ts';

let db: ReturnType<typeof openDb>;
let bank: number;
const cat = (name: string, type = 'expense') => listAccounts(db).find((a) => a.name === name && a.type === type)!.id;
const TODAY = '2026-11-10';

function spend(date: string, name: string, amount: number) {
  createSimpleTransaction(db, { date, description: name, kind: 'expense', accountId: bank, counterAccountId: cat(name), amount } as never);
}
function earn(date: string, amount: number) {
  createSimpleTransaction(db, { date, description: 'Employer', kind: 'income', accountId: bank, counterAccountId: cat('Salary', 'income'), amount } as never);
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 1_00_000_00, openingDate: '2026-01-01' }).id;
});

describe('cash-flow forecast', () => {
  it('finds recurring income as well as bills', () => {
    for (const m of ['08', '09', '10']) earn(`2026-${m}-01`, 80_000_00);
    expect(recurringPayments(db, { today: TODAY, income: true })).toMatchObject([{ cadence: 'monthly', amount: 80_000_00, nextDue: '2026-11-01' }]);
    expect(recurringPayments(db, { today: TODAY })).toEqual([]);
  });

  it('projects the balance through bills and income, and finds the low point', () => {
    for (const m of ['08', '09', '10']) {
      earn(`2026-${m}-08`, 80_000_00);
      spend(`2026-${m}-05`, 'Rent', 50_000_00);
    }
    const f = forecast(db, { today: TODAY, days: 40 });
    const rent = f.events.filter((e) => e.kind === 'bill');
    expect(rent.map((e) => e.date)).toEqual(['2026-11-11', '2026-12-05']);
    // Rent was due on the 5th and salary on the 8th; neither has arrived, so each is expected tomorrow.
    expect(f.events.find((e) => e.kind === 'income')).toMatchObject({ date: '2026-11-11', amount: 80_000_00 });
    expect(f.start).toBe(1_00_000_00 + 3 * 30_000_00);
    expect(f.points).toHaveLength(41);
    expect(f.includesEverydaySpending).toBe(true);
    // Rent is the only spending, so nothing is left over for everyday costs.
    expect(f.everydaySpendingPerMonth).toBe(0);
    expect(f.end).toBe(f.start + 2 * 80_000_00 - 2 * 50_000_00);
    expect(f.lowest.balance).toBeLessThanOrEqual(f.start);
    expect(f.firstBelowZero).toBeNull();
  });

  it('spreads everyday spending across the days and flags a balance that would run out', () => {
    for (const m of ['08', '09', '10']) {
      spend(`2026-${m}-05`, 'Rent', 30_000_00);
    }
    // Irregular, so it is not a bill: it counts as everyday spending.
    spend('2026-08-12', 'Groceries', 30_000_00);
    spend('2026-09-26', 'Groceries', 30_000_00);
    spend('2026-10-03', 'Groceries', 30_000_00);
    // 1,00,000 - 3 x 60,000 leaves a negative start: the account starts overdrawn in this setup.
    const f = forecast(db, { today: TODAY, days: 60 });
    expect(f.everydaySpendingPerMonth).toBe(30_000_00);
    expect(f.firstBelowZero).not.toBeNull();
    expect(f.lowest.date).toBe(f.points.at(-1)!.date);
  });

  it('keeps going with no history, leaving everyday spending out', () => {
    const f = forecast(db, { today: TODAY, days: 30 });
    expect(f).toMatchObject({ includesEverydaySpending: false, events: [], end: 1_00_000_00 });
  });
});
