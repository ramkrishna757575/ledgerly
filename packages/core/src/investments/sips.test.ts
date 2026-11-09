import { investmentImports, investmentTransactions, openDb, positions } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, listAccounts } from '../accounts.ts';
import { forecast } from '../forecast.ts';
import { ensureStarterCategories, seedDefaults } from '../seed.ts';
import { createSimpleTransaction } from '../transactions.ts';
import { sipPlans } from './sips.ts';

let db: ReturnType<typeof openDb>;
let importId: number;
let n = 0;

function sip(positionId: number, date: string, rupees: number) {
  db.insert(investmentTransactions).values({ importId, positionId, date, kind: 'sip', amount: rupees * 100, units: 50_000_000, description: 'SIP', fingerprint: `s${n++}` }).run();
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  importId = db.insert(investmentImports).values({ source: 'cdsl', asOf: '2026-11-01', payload: {} as never, warnings: [] }).returning().get().id;
});

describe('SIP plans', () => {
  it('finds a monthly plan, checks the bank for each instalment, and works out the next one', () => {
    const fund = db.insert(positions).values({ name: 'Index Fund', assetClass: 'equity' }).returning().get().id;
    const bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 5_00_000_00, openingDate: '2026-01-01' }).id;
    const funds = createAccount(db, { name: 'Funds', type: 'asset', subtype: 'investment' }).id;
    for (const d of ['2026-08-05', '2026-09-05', '2026-10-05']) sip(fund, d, 5_000);
    // Two of the three debits show up in the bank, a day late.
    for (const d of ['2026-08-06', '2026-09-05']) {
      createSimpleTransaction(db, { date: d, description: 'SIP', kind: 'transfer', accountId: bank, counterAccountId: funds, amount: 5_000_00 } as never);
    }
    const { plans, monthlyTotal } = sipPlans(db, { today: '2026-11-10' });
    expect(plans).toMatchObject([{ fund: 'Index Fund', amount: 5_000_00, instalments: 3, lastDate: '2026-10-05', nextDue: '2026-11-05', active: true, inBankStatement: 2 }]);
    expect(monthlyTotal).toBe(5_000_00);
  });

  it('ignores a single instalment, and marks a plan that stopped', () => {
    const one = db.insert(positions).values({ name: 'One-off', assetClass: 'equity' }).returning().get().id;
    sip(one, '2026-10-05', 1_000);
    const old = db.insert(positions).values({ name: 'Stopped', assetClass: 'equity' }).returning().get().id;
    for (const d of ['2026-01-05', '2026-02-05', '2026-03-05']) sip(old, d, 2_000);
    const { plans, monthlyTotal } = sipPlans(db, { today: '2026-11-10' });
    expect(plans).toMatchObject([{ fund: 'Stopped', active: false, nextDue: null }]);
    expect(monthlyTotal).toBe(0);
  });

  it('is counted in the cash-flow forecast', () => {
    createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 5_00_000_00, openingDate: '2026-01-01' });
    const fund = db.insert(positions).values({ name: 'Index Fund', assetClass: 'equity' }).returning().get().id;
    for (const d of ['2026-08-15', '2026-09-15', '2026-10-15']) sip(fund, d, 5_000);
    const f = forecast(db, { today: '2026-11-10', days: 70 });
    expect(f.events.filter((e) => e.label.startsWith('SIP:')).map((e) => e.date)).toEqual(['2026-11-15', '2026-12-15', '2027-01-15']);
    expect(f.end).toBe(f.start - 3 * 5_000_00);
    void listAccounts;
  });
});
