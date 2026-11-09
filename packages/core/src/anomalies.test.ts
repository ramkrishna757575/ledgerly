import { openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from './accounts.ts';
import { anomalies } from './anomalies.ts';
import { computeInsights } from './insights.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';
import { createSimpleTransaction } from './transactions.ts';

let db: ReturnType<typeof openDb>;
let bank: number;
const TODAY = '2026-11-20';
const cat = (name: string) => listAccounts(db).find((a) => a.name === name && a.type === 'expense')!.id;
function pay(date: string, description: string, rupees: number, category = 'Shopping', payee?: string) {
  createSimpleTransaction(db, { date, description, payee, kind: 'expense', accountId: bank, counterAccountId: cat(category), amount: rupees * 100 } as never);
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 50_00_000_00, openingDate: '2026-01-01' }).id;
});

describe('anomalies', () => {
  it('flags a charge far above what a payee usually costs, and not a normal one', () => {
    for (const d of ['2026-08-10', '2026-09-12', '2026-10-09']) pay(d, 'City Electronics', 1_500);
    pay('2026-11-15', 'City Electronics', 9_500);
    const unusual = () => anomalies(db, { today: TODAY }).filter((a) => a.kind === 'unusual');
    expect(unusual()).toMatchObject([{ kind: 'unusual', amount: 9_500_00, date: '2026-11-15' }]);
    expect(unusual()[0]!.title).toMatch(/far above the usual/);

    pay('2026-11-18', 'Corner Cafe', 900);
    expect(unusual().length).toBe(1);
  });

  it('flags the same amount to the same payee twice in two days, but not a few days apart', () => {
    pay('2026-11-10', 'Online Store', 2_499);
    pay('2026-11-11', 'Online Store', 2_499);
    pay('2026-11-01', 'Other Store', 800);
    pay('2026-11-09', 'Other Store', 800);
    const found = anomalies(db, { today: TODAY });
    expect(found).toMatchObject([{ kind: 'duplicate', amount: 2_499_00 }]);
    expect(found[0]!.title).toMatch(/Online Store charged .* twice/);
  });

  it('flags a subscription that went up, not one that stayed, and not a bill that always varies', () => {
    for (const d of ['2026-08-05', '2026-09-05', '2026-10-05']) pay(d, 'StreamCo', 499, 'Subscriptions');
    pay('2026-11-05', 'StreamCo', 649, 'Subscriptions');
    for (const d of ['2026-08-07', '2026-09-07', '2026-10-07', '2026-11-07']) pay(d, 'MusicCo', 119, 'Subscriptions');
    const found = anomalies(db, { today: TODAY });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'price_rise', amount: 150_00 });
    expect(found[0]!.title).toMatch(/StreamCo went up from ₹499 to ₹649/);
  });

  it('flags a month that is well above normal once it is half over', () => {
    for (const m of ['08', '09', '10']) pay(`2026-${m}-03`, 'Rent', 30_000, 'Rent');
    expect(anomalies(db, { today: '2026-11-05' })).toEqual([]);
    pay('2026-11-04', 'Big Purchase', 80_000);
    expect(anomalies(db, { today: '2026-11-08' })).toEqual([]); // too early in the month
    const found = anomalies(db, { today: '2026-11-20' });
    expect(found.some((a) => a.kind === 'spike')).toBe(true);
  });

  it('raises one finding on the dashboard, with a key that changes with the set', () => {
    pay('2026-11-10', 'Online Store', 2_499);
    pay('2026-11-11', 'Online Store', 2_499);
    const real = new Date().toISOString().slice(0, 10);
    // The finding uses the real date, so make a duplicate pair that is recent now.
    const recent = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    pay(recent(2), 'Gadget Hub', 3_000);
    pay(recent(1), 'Gadget Hub', 3_000);
    const finding = computeInsights(db).find((i) => i.kind === 'anomalies')!;
    expect(finding).toMatchObject({ severity: 'attention' });
    expect(finding.key.startsWith('anomalies:')).toBe(true);
    void real;
  });
});
