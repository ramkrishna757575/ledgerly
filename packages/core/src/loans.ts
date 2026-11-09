import { accounts, loans, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getBalances } from './accounts.ts';
import { DomainError } from './errors.ts';
import { dateSchema } from './transactions.ts';

export const loanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  accountId: z.number().int().positive().nullable().optional(),
  principal: z.number().int().safe().positive(),
  rateBps: z.number().int().min(0).max(5000),
  tenureMonths: z.number().int().min(1).max(600),
  // Worked out from the other terms when left out.
  emi: z.number().int().safe().positive().optional(),
  firstEmiDate: dateSchema,
});

// The standard EMI formula: P r (1+r)^n / ((1+r)^n - 1), r being the monthly rate.
export function computeEmi(principal: number, rateBps: number, months: number) {
  const r = rateBps / 10_000 / 12;
  if (r === 0) return Math.ceil(principal / months);
  const growth = (1 + r) ** months;
  return Math.round((principal * r * growth) / (growth - 1));
}

const addMonths = (date: string, months: number) => {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(Number(date.slice(8, 10)), last)).padStart(2, '0')}`;
};

export type Instalment = { number: number; date: string; interest: number; principal: number; paid: number; balance: number };

// Month by month: interest on what is still owed, the rest of the instalment
// reduces the debt. An extra amount paid at `prepay.at` (counted from now) cuts
// the balance, and the same instalment then clears the loan sooner.
export function schedule(loan: { principal: number; rateBps: number; emi: number; firstEmiDate: string; tenureMonths: number }, prepay?: { afterInstalment: number; amount: number }) {
  const r = loan.rateBps / 10_000 / 12;
  const out: Instalment[] = [];
  let balance = loan.principal;
  for (let n = 1; balance > 0 && n <= loan.tenureMonths * 2; n++) {
    if (prepay && n === prepay.afterInstalment + 1) balance = Math.max(0, balance - prepay.amount);
    if (balance === 0) break;
    const interest = Math.round(balance * r);
    // The last instalment is whatever clears it, as the rounded EMI leaves a few paise over.
    const paid = n >= loan.tenureMonths ? balance + interest : Math.min(loan.emi, balance + interest);
    const principalPart = paid - interest;
    // An EMI that does not cover the interest never pays the loan off.
    if (principalPart <= 0) break;
    balance -= principalPart;
    out.push({ number: n, date: addMonths(loan.firstEmiDate, n - 1), interest, principal: principalPart, paid, balance });
  }
  return out;
}

export function createLoan(db: Db, input: z.input<typeof loanSchema>) {
  const data = loanSchema.parse(input);
  if (data.accountId) {
    const account = db.select().from(accounts).where(eq(accounts.id, data.accountId)).get();
    if (!account || account.type !== 'liability') throw new DomainError('invalid', 'Link a loan or liability account, or leave it out');
  }
  const emi = data.emi ?? computeEmi(data.principal, data.rateBps, data.tenureMonths);
  return db.insert(loans).values({ ...data, accountId: data.accountId ?? null, emi }).returning().get().id;
}

export function deleteLoan(db: Db, id: number) {
  if (db.delete(loans).where(eq(loans.id, id)).returning().all().length === 0) throw new DomainError('not_found', 'No such loan');
}

export function listLoans(db: Db, input: { today?: string } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const balances = new Map(getBalances(db).map((b) => [b.id, b]));

  return db
    .select()
    .from(loans)
    .all()
    .map((loan) => {
      const plan = schedule(loan);
      const paid = plan.filter((i) => i.date <= today);
      const left = plan.filter((i) => i.date > today);
      const outstanding = paid.length === 0 ? loan.principal : paid.at(-1)!.balance;
      const interestLeft = left.reduce((s, i) => s + i.interest, 0);
      const ledger = loan.accountId ? balances.get(loan.accountId) : undefined;

      // What prepaying a lump sum now would do, with the same instalment.
      const example = Math.min(outstanding, Math.max(1_00_000_00, Math.round(outstanding * 0.1 / 1_00_000_00) * 1_00_000_00));
      const sooner = outstanding > 0 ? schedule(loan, { afterInstalment: paid.length, amount: example }) : [];
      const interestAfter = sooner.slice(paid.length).reduce((s, i) => s + i.interest, 0);

      return {
        id: loan.id,
        name: loan.name,
        accountId: loan.accountId,
        principal: loan.principal,
        rateBps: loan.rateBps,
        emi: loan.emi,
        tenureMonths: loan.tenureMonths,
        instalmentsPaid: paid.length,
        instalmentsLeft: left.length,
        outstanding,
        ledgerOwed: ledger ? Math.max(ledger.balance, 0) : null,
        nextDate: left[0]?.date ?? null,
        payoffDate: plan.at(-1)?.date ?? null,
        interestLeft,
        totalInterest: plan.reduce((s, i) => s + i.interest, 0),
        // Prepaying earns the loan's own rate, with no risk and no tax on it.
        prepay: outstanding > 0 && left.length > 0 ? { amount: example, interestSaved: interestLeft - interestAfter, monthsSaved: left.length - (sooner.length - paid.length), guaranteedReturnPercent: loan.rateBps / 100 } : null,
      };
    });
}

export type LoanSummary = ReturnType<typeof listLoans>[number];
