import { importBatches, openDb } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, createSimpleTransaction, listAccounts } from './index.ts';
import { cardDues } from './cards.ts';
import { forecast } from './forecast.ts';
import { assignAccount, commitBatch, stageStatement } from './imports/batches.ts';
import { getSampleStatement } from './imports/samples.ts';
import { computeInsights } from './insights.ts';
import { pendingAlerts } from './alerts.ts';
import { ensureStarterCategories, seedDefaults } from './seed.ts';

let db: ReturnType<typeof openDb>;
let card: number;
let bank: number;

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  ensureStarterCategories(db);
  bank = createAccount(db, { name: 'Bank', type: 'asset', subtype: 'bank', openingBalance: 5_00_000_00, openingDate: '2026-01-01' }).id;
  card = createAccount(db, { name: 'Axis Card', type: 'liability', subtype: 'credit_card' }).id;
  const batch = stageStatement(db, getSampleStatement('card')!);
  assignAccount(db, batch.id, card);
  commitBatch(db, batch.id);
});

describe('card statements', () => {
  it('keep their payment due date and minimum due', () => {
    const [batch] = db.select().from(importBatches).all();
    expect(batch).toMatchObject({ dueDate: '2026-11-01', minimumDue: 375_00 });
  });
});

describe('card dues', () => {
  it('shows what is still owed on the latest statement, as upcoming and then overdue', () => {
    expect(cardDues(db, { today: '2026-10-28' })).toMatchObject([{ name: 'Axis Card', dueDate: '2026-11-01', daysToDue: 4, statementAmount: 7_500_00, remaining: 7_500_00, overdue: false, partlyPaid: false }]);
    expect(cardDues(db, { today: '2026-11-03' })[0]).toMatchObject({ overdue: true, daysToDue: -2 });
    expect(cardDues(db, { today: '2027-01-15' })).toEqual([]);
  });

  it('lowers the amount when part of the bill has been paid, and drops it once paid in full', () => {
    const pay = (amount: number) =>
      createSimpleTransaction(db, { date: '2026-10-30', description: 'Card payment', kind: 'transfer', accountId: bank, counterAccountId: card, amount } as never);
    pay(3_000_00);
    expect(cardDues(db, { today: '2026-10-31' })[0]).toMatchObject({ remaining: 4_500_00, partlyPaid: true });
    pay(4_500_00);
    expect(cardDues(db, { today: '2026-10-31' })).toEqual([]);
    void listAccounts;
  });

  it('is counted in the forecast on the due date, raises a finding and goes out as an alert', () => {
    const f = forecast(db, { today: '2026-10-28', days: 14 });
    expect(f.events.find((e) => e.label === 'Card bill: Axis Card')).toMatchObject({ date: '2026-11-01', amount: -7_500_00 });
    const overdue = forecast(db, { today: '2026-11-03', days: 14 });
    expect(overdue.events.find((e) => e.label.startsWith('Card bill'))!.date).toBe('2026-11-04');

    // The findings use the real clock, so check the shape against a bill that is due about now.
    const [b] = db.select().from(importBatches).all();
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    db.update(importBatches).set({ dueDate: soon }).where(importBatchesId(b!.id)).run();
    const finding = computeInsights(db).find((i) => i.kind === 'cards')!;
    expect(finding).toMatchObject({ severity: 'info', amount: 7_500_00 });
    expect(pendingAlerts(db).some((i) => i.kind === 'cards')).toBe(true);
  });
});

import { eq } from 'drizzle-orm';
const importBatchesId = (id: number) => eq(importBatches.id, id);
