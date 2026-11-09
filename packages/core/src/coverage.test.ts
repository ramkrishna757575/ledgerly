import { documents, importBatches, openDb, type Db } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeInsights, createAccount, seedDefaults, statementCoverage } from './index.ts';

let db: Db;
let card: number;

function statement(accountId: number, start: string, end: string, status: 'committed' | 'staged' = 'committed') {
  const doc = db
    .insert(documents)
    .values({ sha256: `${start}${end}${accountId}`, filename: 'x.pdf', mimeType: 'application/pdf', size: 1, storedName: `${start}${end}${accountId}.pdf` })
    .returning()
    .get();
  db.insert(importBatches).values({ documentId: doc.id, accountId, adapterId: 'x', accountKind: 'credit_card', status, periodStart: start, periodEnd: end }).run();
}

beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
  card = createAccount(db, { name: 'Axis Card', type: 'liability', subtype: 'credit_card' }).id;
});

describe('which months have statements', () => {
  it('shows a month nobody imported as a gap, and a card cycle that does not follow the calendar as covered', () => {
    statement(card, '2026-01-10', '2026-02-09');
    statement(card, '2026-02-10', '2026-03-09');
    statement(card, '2026-05-10', '2026-06-09');
    const [coverage] = statementCoverage(db, '2026-07-05');
    const state = Object.fromEntries(coverage!.months.map((m) => [m.month, m.state]));
    expect(state['2026-01']).toBe('partial'); // the first statement starts on the 10th
    expect(state['2026-02']).toBe('covered');
    expect(state['2026-04']).toBe('gap');
    expect(coverage!.missing).toEqual(['2026-04']);
    expect(coverage!.months.at(-1)!.month).toBe('2026-06'); // this month's statement is not out yet
  });

  it('counts months since the last statement as missing, and ignores statements not yet imported', () => {
    statement(card, '2026-01-01', '2026-01-31');
    statement(card, '2026-02-01', '2026-02-28', 'staged');
    const [coverage] = statementCoverage(db, '2026-05-02');
    expect(coverage!.missing).toEqual(['2026-02', '2026-03', '2026-04']);
  });

  it('has nothing to say about an account with no imported statements', () => {
    expect(statementCoverage(db, '2026-05-02')).toEqual([]);
  });

  it('raises an alert that names the missing months and explains the credit on a card', () => {
    statement(card, '2026-01-01', '2026-01-31');
    statement(card, '2026-04-01', '2026-04-30');
    const insight = computeInsights(db).find((item) => item.kind === 'coverage')!;
    expect(insight.title).toMatch(/Axis Card has no statement for Feb 2026 to Mar 2026, May 2026/);
    expect(insight.detail).toMatch(/purchases are not/);
    expect(insight.action).toMatchObject({ type: 'link', to: '/import' });
  });
});
