import { policies, POLICY_FREQUENCIES, POLICY_KINDS, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from './errors.ts';
import { dateSchema } from './transactions.ts';

export const policySchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(POLICY_KINDS),
  insurer: z.string().trim().max(100).nullable().optional(),
  premium: z.number().int().safe().positive(),
  frequency: z.enum(POLICY_FREQUENCIES),
  nextDue: dateSchema,
  sumAssured: z.number().int().safe().positive().nullable().optional(),
});

const MONTHS = { monthly: 1, quarterly: 3, yearly: 12 } as const;
export const addMonths = (date: string, months: number) => {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(Number(date.slice(8, 10)), last)).padStart(2, '0')}`;
};

export function createPolicy(db: Db, input: z.input<typeof policySchema>) {
  const data = policySchema.parse(input);
  return db.insert(policies).values({ ...data, insurer: data.insurer ?? null, sumAssured: data.sumAssured ?? null }).returning().get().id;
}

export function deletePolicy(db: Db, id: number) {
  if (db.delete(policies).where(eq(policies.id, id)).returning().all().length === 0) throw new DomainError('not_found', 'No such policy');
}

// The date moves on by itself once a premium date has passed, so a policy is
// always shown with the next one coming and never needs editing.
export function listPolicies(db: Db, input: { today?: string } = {}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(policies)
    .all()
    .map((policy) => {
      let next = policy.nextDue;
      while (next < today) next = addMonths(next, MONTHS[policy.frequency]);
      const daysToDue = Math.round((Date.parse(next) - Date.parse(today)) / 86_400_000);
      const perYear = policy.premium * (12 / MONTHS[policy.frequency]);
      return { ...policy, nextDue: next, daysToDue, premiumPerYear: perYear };
    })
    .sort((a, b) => a.daysToDue - b.daysToDue);
}

export type Policy = ReturnType<typeof listPolicies>[number];
