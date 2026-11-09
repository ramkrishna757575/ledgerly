import { importBatches, documents, openDb, type Db } from '@ledgerly/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount, hideSetup, listAccounts, seedDefaults, setBudget, setupProgress } from './index.ts';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
  seedDefaults(db);
});
const done = () => Object.fromEntries(setupProgress(db).steps.map((s) => [s.key, s.done]));

describe('the getting started list', () => {
  it('starts with nothing done and ticks steps off as the books fill', () => {
    expect(done()).toEqual({ accounts: false, import: false, categories: false, budget: false });
    createAccount(db, { name: 'Savings', type: 'asset', subtype: 'bank' });
    expect(done().accounts).toBe(true);
    const doc = db.insert(documents).values({ sha256: 'a', filename: 'a.pdf', mimeType: 'application/pdf', size: 1, storedName: 'a.pdf' }).returning().get();
    db.insert(importBatches).values({ documentId: doc.id, adapterId: 'x', accountKind: 'bank', status: 'committed' }).run();
    expect(done().import).toBe(true);
    const food = listAccounts(db).find((a) => a.name === 'Groceries')!;
    setBudget(db, { categoryId: food.id, amount: 1000000 });
    expect(done().budget).toBe(true);
  });

  it('can be hidden, and hides itself once everything is done', () => {
    expect(setupProgress(db).hidden).toBe(false);
    hideSetup(db);
    expect(setupProgress(db).hidden).toBe(true);
  });
});
