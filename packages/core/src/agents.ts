import { createHash, randomBytes } from 'node:crypto';
import { apiTokens, auditLog, TOKEN_SCOPES, type Db, type TokenScope } from '@ledgerly/db';
import { desc, eq, like, lt, notLike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError } from './errors.ts';

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scope: z.enum(TOKEN_SCOPES),
});

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// The plain token is returned once, here. Only its hash is kept.
// With several people on one server, a token carries the id of whoever's books
// it opens, so the server knows which ledger to look in before it checks it.
export function createApiToken(db: Db, input: z.input<typeof createTokenSchema>, tenantId?: number) {
  const { name, scope } = createTokenSchema.parse(input);
  const token = `lg_${tenantId === undefined ? '' : `u${tenantId}.`}${randomBytes(32).toString('base64url')}`;
  const record = db
    .insert(apiTokens)
    .values({ name, scope, tokenHash: hashToken(token), tokenPrefix: token.slice(0, 9) })
    .returning({ id: apiTokens.id, name: apiTokens.name, scope: apiTokens.scope, tokenPrefix: apiTokens.tokenPrefix, createdAt: apiTokens.createdAt })
    .get();
  return { token, record };
}

export function listApiTokens(db: Db) {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scope: apiTokens.scope,
      tokenPrefix: apiTokens.tokenPrefix,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .orderBy(desc(apiTokens.id))
    .all();
}

export function revokeApiToken(db: Db, id: number) {
  const { changes } = db
    .update(apiTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(apiTokens.id, id))
    .run();
  if (changes === 0) throw new DomainError('not_found', `Token ${id} not found`);
}

export const tenantOfToken = (token: string | undefined) => {
  const match = /^lg_u(\d+)\./.exec(token ?? '');
  return match ? Number(match[1]) : undefined;
};

export type Agent = { id: number | null; name: string; scope: TokenScope };

export function authenticateToken(db: Db, token: string | undefined): Agent | undefined {
  if (!token?.startsWith('lg_')) return undefined;
  const row = db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashToken(token))).get();
  if (!row || row.revokedAt) return undefined;
  db.update(apiTokens).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiTokens.id, row.id)).run();
  return { id: row.id, name: row.name, scope: row.scope };
}

export type AuditEntry = {
  actor: string;
  tool: string;
  args?: unknown;
  outcome: 'ok' | 'error' | 'denied';
  detail?: string;
};

const KEEP = 5000;

// Every agent call is recorded, with its arguments cut down to a sensible size.
export function recordAudit(db: Db, entry: AuditEntry) {
  const args = entry.args === undefined ? null : JSON.stringify(entry.args).slice(0, 2000);
  const { id } = db
    .insert(auditLog)
    .values({ actor: entry.actor, tool: entry.tool, args, outcome: entry.outcome, detail: entry.detail?.slice(0, 500) })
    .returning({ id: auditLog.id })
    .get();
  if (id % 500 === 0) db.delete(auditLog).where(lt(auditLog.id, id - KEEP)).run();
}

// What agents did. The changes people make themselves are kept apart, under
// actors that start with "user:", and listed by listActivity.
export function listAudit(db: Db, limit = 50) {
  return db
    .select()
    .from(auditLog)
    .where(notLike(auditLog.actor, 'user:%'))
    .orderBy(desc(auditLog.id))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all();
}

export const countAudit = (db: Db) =>
  db.select({ total: sql<number>`count(*)` }).from(auditLog).where(notLike(auditLog.actor, 'user:%')).get()?.total ?? 0;

export function listActivity(db: Db, limit = 100) {
  return db
    .select()
    .from(auditLog)
    .where(like(auditLog.actor, 'user:%'))
    .orderBy(desc(auditLog.id))
    .limit(Math.min(Math.max(limit, 1), 500))
    .all();
}

// A line in the change log: who, what, and whether it went through. Never the
// request itself, so nothing typed (a password, an amount) is kept.
export function recordActivity(db: Db, entry: { actor: string; action: string; detail?: string; outcome: 'ok' | 'error' | 'denied' }) {
  const { id } = db
    .insert(auditLog)
    .values({ actor: `user:${entry.actor}`, tool: entry.action.slice(0, 200), outcome: entry.outcome, detail: entry.detail?.slice(0, 300) })
    .returning({ id: auditLog.id })
    .get();
  if (id % 500 === 0) db.delete(auditLog).where(lt(auditLog.id, id - 20_000)).run();
}
