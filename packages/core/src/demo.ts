import { accounts, tags, transactions, type Db } from '@ledgerly/db';
import { createAccount } from './accounts.ts';
import { DomainError } from './errors.ts';
import { seedDefaults } from './seed.ts';
import { createTransaction } from './transactions.ts';

const rupees = (amount: number) => Math.round(amount * 100);

// A small seeded generator keeps the demo identical on every start.
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const GROCERS = ['BigBasket', 'DMart', 'Local vegetable market', 'Reliance Fresh'];
const FOOD = ['Swiggy', 'Zomato', 'Cafe Coffee Day', 'Dominos Pizza', 'Office canteen'];
const SHOPS = ['Amazon', 'Flipkart', 'Myntra', 'Decathlon'];

export function seedDemoData(db: Db, options: { today?: string } = {}) {
  if (db.select().from(transactions).limit(1).get()) {
    throw new DomainError('conflict', 'Demo data can only be added to an empty ledger');
  }

  const today = new Date(`${options.today ?? isoDate(new Date())}T00:00:00Z`);
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1));
  const startDate = isoDate(start);
  const random = mulberry32(2026);
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;

  const savings = createAccount(db, {
    name: 'Demo Savings',
    type: 'asset',
    subtype: 'bank',
    institution: 'Demo Bank',
    // Matches the sample statements, so they find this account on their own.
    numberLast4: '2345',
    openingBalance: rupees(150000),
    openingDate: startDate,
  });
  const card = createAccount(db, {
    name: 'Demo Credit Card',
    type: 'liability',
    subtype: 'credit_card',
    institution: 'Demo Bank',
    numberLast4: '9876',
  });
  const cash = createAccount(db, {
    name: 'Cash',
    type: 'asset',
    subtype: 'cash',
    openingBalance: rupees(5000),
    openingDate: startDate,
  });
  const funds = createAccount(db, {
    name: 'Mutual Funds',
    type: 'asset',
    subtype: 'investment',
    openingBalance: rupees(200000),
    openingDate: startDate,
  });

  const category = new Map(
    db
      .select()
      .from(accounts)
      .all()
      .filter((a) => a.type === 'income' || a.type === 'expense')
      .map((a) => [a.name, a.id]),
  );
  const categoryId = (name: string) => {
    const id = category.get(name);
    if (!id) throw new Error(`Missing category ${name}`);
    return id;
  };

  const record = (
    date: string,
    description: string,
    from: number,
    to: number,
    amount: number,
    tagNames?: string[],
  ) =>
    createTransaction(db, {
      date,
      description,
      payee: description,
      source: 'demo',
      tags: tagNames,
      postings: [
        { accountId: from, amount: -amount },
        { accountId: to, amount },
      ],
    });

  const spend = (date: string, description: string, using: number, name: string, amount: number) =>
    record(date, description, using, categoryId(name), amount);
  const earn = (date: string, description: string, name: string, amount: number) =>
    record(date, description, categoryId(name), savings.id, amount);

  const cardSpend = new Map<string, number>();
  let cashLeft = rupees(5000);
  const payWith = (amount: number) => {
    const roll = random();
    if (roll < 0.5) return card.id;
    if (roll < 0.9 || cashLeft < amount) return savings.id;
    cashLeft -= amount;
    return cash.id;
  };
  const spendDaily = (date: string, description: string, name: string, amount: number) => {
    const using = payWith(amount);
    spend(date, description, using, name, amount);
    if (using === card.id) {
      const month = date.slice(0, 7);
      cardSpend.set(month, (cardSpend.get(month) ?? 0) + amount);
    }
  };
  const spendOnCard = (date: string, description: string, name: string, amount: number) => {
    spend(date, description, card.id, name, amount);
    const month = date.slice(0, 7);
    cardSpend.set(month, (cardSpend.get(month) ?? 0) + amount);
  };

  for (let day = start; day <= today; day = addDays(day, 1)) {
    const date = isoDate(day);
    const dayOfMonth = day.getUTCDate();

    if (dayOfMonth === 1) {
      earn(date, 'Salary - Acme Technologies', 'Salary', rupees(85000));
      earn(date, 'Savings account interest', 'Interest', rupees(between(380, 460)));
    }
    if (dayOfMonth === 3) {
      record(date, 'ATM cash withdrawal', savings.id, cash.id, rupees(5000));
      cashLeft += rupees(5000);
    }
    if (dayOfMonth === 5) spend(date, 'House rent', savings.id, 'Rent', rupees(22000));
    if (dayOfMonth === 7) {
      record(date, 'SIP - Index fund', savings.id, funds.id, rupees(15000), ['investing']);
    }
    if (dayOfMonth === 10) {
      spend(date, 'Electricity bill', savings.id, 'Utilities', rupees(between(1100, 2400)));
    }
    if (dayOfMonth === 12) {
      spend(date, 'Broadband', savings.id, 'Mobile & Internet', rupees(999));
      spend(date, 'Mobile recharge', savings.id, 'Mobile & Internet', rupees(299));
    }
    if (dayOfMonth === 15) spendOnCard(date, 'Netflix', 'Subscriptions', rupees(649));
    if (dayOfMonth === 16) spendOnCard(date, 'Spotify', 'Subscriptions', rupees(119));
    if (dayOfMonth === 20) {
      const previous = isoDate(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, 1)));
      const due = cardSpend.get(previous.slice(0, 7)) ?? 0;
      if (due > 0) record(date, 'Credit card bill payment', savings.id, card.id, due);
    }

    if (random() < 0.35) {
      const shop = pick(GROCERS);
      // A local shop nobody has sorted yet, so the demo has something to categorise.
      const name = shop === 'Local vegetable market' ? 'Uncategorized' : 'Groceries';
      spendDaily(date, shop, name, rupees(between(200, 1800)));
    }
    if (random() < 0.3) spendDaily(date, pick(FOOD), 'Food & Dining', rupees(between(150, 900)));
    if (random() < 0.2) spendDaily(date, 'Auto and cab rides', 'Transport', rupees(between(50, 400)));
    if (random() < 0.08) spendDaily(date, 'Fuel', 'Fuel', rupees(between(500, 2500)));
    if (random() < 0.05) spendDaily(date, pick(SHOPS), 'Shopping', rupees(between(800, 6000)));
    if (random() < 0.03) spendDaily(date, 'Pharmacy', 'Health', rupees(between(150, 1200)));
  }
}

// Removes everything, then loads the demo again. Never call this on a real database.
export function resetDemoData(db: Db, options: { today?: string } = {}) {
  db.transaction((tx) => {
    const store = tx as unknown as Db;
    store.delete(transactions).run();
    store.delete(tags).run();
    store.delete(accounts).run();
    seedDefaults(store);
    seedDemoData(store, options);
  });
}
