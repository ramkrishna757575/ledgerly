import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from './accounts.ts';
import { computeInsights } from './insights.ts';
import { hideRecurring, recurringPayments, showRecurring, summarizeRecurring } from './recurring.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';
import { createSimpleTransaction } from './transactions.ts';

let db: ReturnType<typeof openDb>;
let bank: number;
const category = (name: string) => listAccounts(db).find((a) => a.name === name && a.type === 'expense')!.id;

function pay(date: string, description: string, amount: number, name = 'Subscriptions', payee?: string) {
  createSimpleTransaction(db, { date, description, payee, kind: 'expense', accountId: bank, counterAccountId: category(name), amount } as never);
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank' }).id;
});

describe('recurring payments', () => {
  it('finds a monthly payment, its typical amount and when it is next due', () => {
    for (const d of ['2026-07-15', '2026-08-15', '2026-09-15', '2026-10-15']) pay(d, `UPI/${d.replaceAll('-', '')}/Netflix`, 649_00, 'Subscriptions', 'Netflix');
    const [netflix, ...rest] = recurringPayments(db, { today: '2026-11-05' });
    expect(rest).toEqual([]);
    expect(netflix).toMatchObject({ label: 'Netflix', cadence: 'monthly', amount: 649_00, monthly: 649_00, occurrences: 4, lastDate: '2026-10-15', nextDue: '2026-11-15', dueIn: 10, status: 'upcoming', category: 'Subscriptions', varies: false });
  });

  it('groups a narration whose reference numbers change', () => {
    pay('2026-08-02', 'NEFT-AXIS0012345-LANDLORD K', 22_000_00, 'Rent');
    pay('2026-09-02', 'NEFT-AXIS0099871-LANDLORD K', 22_000_00, 'Rent');
    pay('2026-10-03', 'NEFT-AXIS0123400-LANDLORD K', 22_000_00, 'Rent');
    expect(recurringPayments(db, { today: '2026-10-20' })).toMatchObject([{ cadence: 'monthly', amount: 22_000_00, nextDue: '2026-11-03' }]);
  });

  it('ignores irregular spending and a payee seen only twice', () => {
    for (const d of ['2026-08-01', '2026-08-09', '2026-09-20', '2026-10-02']) pay(d, 'Swiggy', 300_00, 'Food & Dining');
    pay('2026-09-01', 'Gym', 1_000_00, 'Health');
    pay('2026-10-01', 'Gym', 1_000_00, 'Health');
    expect(recurringPayments(db, { today: '2026-10-10' })).toEqual([]);
  });

  it('marks a bill overdue shortly after it was due, and lapsed if it has gone quiet', () => {
    for (const d of ['2026-07-10', '2026-08-10', '2026-09-10']) pay(d, 'Hathway', 800_00, 'Mobile & Internet');
    expect(recurringPayments(db, { today: '2026-10-13' })[0]).toMatchObject({ status: 'overdue', dueIn: -3 });
    expect(recurringPayments(db, { today: '2026-10-25' })[0]).toMatchObject({ status: 'lapsed' });
    expect(recurringPayments(db, { today: '2027-01-15' })).toEqual([]);
  });

  it('flags a bill whose amount changes and keeps it in the totals', () => {
    pay('2026-08-05', 'BESCOM', 900_00, 'Utilities');
    pay('2026-09-05', 'BESCOM', 1_500_00, 'Utilities');
    pay('2026-10-05', 'BESCOM', 1_100_00, 'Utilities');
    const items = recurringPayments(db, { today: '2026-10-20' });
    expect(items[0]).toMatchObject({ amount: 1_100_00, varies: true });
    expect(summarizeRecurring(items)).toEqual({ monthly: 1_100_00, dueSoon: { days: 30, count: 1, amount: 1_100_00 } });
  });

  it('handles weekly, quarterly and yearly rhythms and month ends', () => {
    for (const d of ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']) pay(d, 'Milk', 200_00, 'Groceries');
    pay('2026-01-31', 'Insurance', 12_000_00, 'Insurance');
    pay('2026-04-30', 'Insurance', 12_000_00, 'Insurance');
    pay('2026-07-30', 'Insurance', 12_000_00, 'Insurance');
    pay('2025-10-08', 'Policy', 24_000_00, 'Insurance');
    pay('2026-10-08', 'Policy', 24_000_00, 'Insurance');
    const by = Object.fromEntries(recurringPayments(db, { today: '2026-10-01' }).map((i) => [i.label, i]));
    expect(by.Milk).toMatchObject({ cadence: 'weekly', nextDue: '2026-10-05' });
    expect(by.Insurance).toMatchObject({ cadence: 'quarterly', nextDue: '2026-10-30', monthly: 4_000_00 });
    expect(by.Policy).toBeUndefined(); // dated after "today"
    expect(recurringPayments(db, { today: '2026-10-09' }).find((i) => i.label === 'Policy')).toMatchObject({ cadence: 'yearly', nextDue: '2027-10-08', monthly: 2_000_00 });
  });

  it('can hide a payment and bring it back', () => {
    for (const d of ['2026-08-15', '2026-09-15', '2026-10-15']) pay(d, 'Spotify', 119_00);
    const [item] = recurringPayments(db, { today: '2026-10-20' });
    hideRecurring(db, item!.key);
    expect(recurringPayments(db, { today: '2026-10-20' })).toEqual([]);
    expect(recurringPayments(db, { today: '2026-10-20', includeHidden: true })[0]!.hidden).toBe(true);
    showRecurring(db, item!.key);
    expect(recurringPayments(db, { today: '2026-10-20' })).toHaveLength(1);
  });

  it('raises an insight for bills due this week', () => {
    const back = (months: number) => {
      const d = new Date(Date.now() + 3 * 86_400_000);
      d.setUTCMonth(d.getUTCMonth() - months);
      return d.toISOString().slice(0, 10);
    };
    for (const m of [1, 2, 3]) pay(back(m), 'Hathway', 800_00, 'Mobile & Internet');
    const insight = computeInsights(db).find((i) => i.kind === 'bills')!;
    expect(insight).toMatchObject({ severity: 'info', amount: 800_00 });
    expect(insight.title).toMatch(/1 bill expected/);
  });
});
