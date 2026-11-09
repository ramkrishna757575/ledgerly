import { accounts, type Db } from '@ledgerly/db';
import { and, eq, sql } from 'drizzle-orm';
import { getSetting, setSetting } from './settings.ts';

const INCOME = ['Salary', 'Interest', 'Dividends', 'Refunds', 'Other Income'];

const EXPENSES = [
  'Groceries',
  'Food & Dining',
  'Rent',
  'Utilities',
  'Mobile & Internet',
  'Transport',
  'Fuel',
  'Shopping',
  'Health',
  'Insurance',
  'Education',
  'Entertainment',
  'Travel',
  'Subscriptions',
  'Loan EMI',
  'Bank Charges',
  'Taxes',
  'Gifts & Donations',
  'Friends & Family',
  'Uncategorized',
];

const STARTER_VERSION = 'starter_categories_version';
// Bump this and add to ensureStarterCategories when a new starter category is introduced.
const CURRENT_STARTER_VERSION = '2';

// Runs only on an empty database, so renamed or archived categories stay that way.
export function seedDefaults(db: Db) {
  const row = db.select({ total: sql<number>`count(*)` }).from(accounts).get();
  if (row?.total) return;

  db.insert(accounts)
    .values([
      { name: 'Opening Balances', type: 'equity' as const },
      ...INCOME.map((name) => ({ name, type: 'income' as const })),
      ...EXPENSES.map((name) => ({ name, type: 'expense' as const })),
    ])
    .run();
  setSetting(db, STARTER_VERSION, CURRENT_STARTER_VERSION);
}

// A database made before a starter category existed gets it once. After that it
// is yours: rename or archive it and it stays that way.
export function ensureStarterCategories(db: Db) {
  if (getSetting(db, STARTER_VERSION) === CURRENT_STARTER_VERSION) return;
  const exists = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.type, 'expense'), eq(accounts.name, 'Friends & Family')))
    .get();
  if (!exists) db.insert(accounts).values({ name: 'Friends & Family', type: 'expense' }).run();
  setSetting(db, STARTER_VERSION, CURRENT_STARTER_VERSION);
}
