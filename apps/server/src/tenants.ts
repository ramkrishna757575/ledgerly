import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DomainError, ensureStarterCategories, seedDefaults } from '@ledgerly/core';
import { createHash } from 'node:crypto';
import { directorySettings, invites, shares, openDb, openDirectory, userSessions, users, type Db, type Directory } from '@ledgerly/db';
import { canSendMail } from './mailer.ts';
import { passwordProblem } from './signup-guards.ts';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Config } from './config.ts';
import { readAi, readMail, readWatch } from './ledger-settings.ts';

const derive = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return { hash: (await derive(password, salt, 32)).toString('base64'), salt: salt.toString('base64') };
}

export async function checkPassword(user: { passwordHash: string; passwordSalt: string } | undefined, password: string) {
  // An unknown name takes as long as a known one, so timing does not reveal which exist.
  const salt = Buffer.from(user?.passwordSalt ?? 'AAAAAAAAAAAAAAAAAAAAAA==', 'base64');
  const given = await derive(password, salt, 32);
  const expected = Buffer.from(user?.passwordHash ?? Buffer.alloc(32).toString('base64'), 'base64');
  return Boolean(user) && expected.length === given.length && timingSafeEqual(given, expected);
}

export type UserRow = typeof users.$inferSelect;
export type Tenant = {
  id: number;
  username: string;
  isAdmin: boolean;
  db: Db;
  dataDir: string;
  // The address this person gets mail at, looked up when needed since it can change.
  emailOf?: () => string | null;
  // Bumped when this person's settings change, so their effective settings are worked out again.
  version?: number;
  cached?: { version: number; config: Config };
};

export function touchSettings(tenant: Tenant | undefined) {
  if (tenant) tenant.version = (tenant.version ?? 0) + 1;
}

// Whose books a request is about. Set once the person is known, and everything
// that runs for that request, however deep, reads and writes only their database.
export const tenantStore = new AsyncLocalStorage<Tenant>();

// The ledger database for whoever is asking. Code written for one person's
// books keeps using `db` as before; this hands it the right one.
export function tenantDb(fallback: Db): Db {
  return new Proxy(fallback, {
    get(target, property) {
      const real = (tenantStore.getStore()?.db ?? target) as Db;
      const value = Reflect.get(real, property, real);
      return typeof value === 'function' ? value.bind(real) : value;
    },
  });
}

// The settings that depend on whose books they are: where the files are, and
// the things that belong to the person running the server (the folder it
// watches, the places alerts go, and the AI key unless they chose to share it).
export function tenantConfig(base: Config): Config {
  return new Proxy(base, {
    get(target, property, receiver) {
      const tenant = tenantStore.getStore();
      if (!tenant) return Reflect.get(target, property, receiver);
      return Reflect.get(resolveConfig(target, tenant), property);
    },
  });
}

export function configFor(base: Config, tenant: Pick<Tenant, 'isAdmin' | 'dataDir'>): Config {
  const shared = base.aiForAllUsers || tenant.isAdmin;
  return {
    ...base,
    dataDir: tenant.dataDir,
    dbPath: join(tenant.dataDir, 'ledgerly.db'),
    channels: tenant.isAdmin ? base.channels : [],
    restrictOutbound: base.multiUser && !tenant.isAdmin,
    quotaBytes: tenant.isAdmin ? 0 : base.quotaBytes,
    backupKeep: tenant.isAdmin ? base.backupKeep : Math.min(3, base.backupKeep),
    watchDir: tenant.isAdmin ? base.watchDir : undefined,
    mail: tenant.isAdmin ? base.mail : undefined,
    mailProblem: tenant.isAdmin ? base.mailProblem : undefined,
    ai: shared ? base.ai : null,
    aiProblem: shared ? base.aiProblem : undefined,
  };
}

// What is true for these books right now: the server's settings, where this
// person may use them, with their own settings laid over the top. Worked out
// again only when their settings change.
export function resolveConfig(base: Config, tenant: Tenant): Config {
  const version = tenant.version ?? 0;
  if (tenant.cached?.version === version) return tenant.cached.config;

  const env = configFor(base, tenant);
  const own = { ai: readAi(tenant.db), mail: readMail(tenant.db), watch: readWatch(tenant.db) };
  const inbox = join(tenant.dataDir, 'inbox');
  const config: Config = {
    ...env,
    ai: own.ai ?? env.ai,
    aiProblem: own.ai ? undefined : env.aiProblem,
    mail: own.mail ?? env.mail,
    mailProblem: own.mail ? undefined : env.mailProblem,
    // The server owner's folder is the one they named. Everyone else's lives in their own data folder.
    watchDir: tenant.isAdmin && env.watchDir ? env.watchDir : own.watch.enabled ? inbox : undefined,
    watchPasswords: [...own.watch.passwords, ...(tenant.isAdmin ? base.watchPasswords : [])],
  };
  tenant.cached = { version, config };
  return config;
}

// The same, as an object that stays current, for jobs that run for a long time.
export function liveConfig(base: Config, tenant: Tenant): Config {
  return new Proxy(base, { get: (_target, property) => Reflect.get(resolveConfig(base, tenant), property) });
}

const hashCode = (code: string) => createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');

export const EMAIL = /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]{2,}$/;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;

// Everyone who can sign in, and a ledger for each, opened when first needed.
export class Tenants {
  directory: Directory;
  base: Config;
  private open = new Map<number, Tenant>();
  private lastUsed = new Map<number, number>();
  // How many people's books may be open at once, and how long one must be idle before it can be closed.
  maxOpen = Number(process.env.MAX_OPEN_LEDGERS) || 50;
  idleMs = 5 * 60_000;
  onOpen?: (tenant: Tenant) => void;
  onClose?: (tenant: Tenant) => void;

  constructor(base: Config) {
    this.base = base;
    this.directory = openDirectory(join(base.dataDir, 'directory.db'));
  }

  // The first administrator keeps the books that were here before there were
  // users: no data moves, they simply become theirs.
  async bootstrap(username: string, password: string) {
    if (this.directory.select().from(users).all().length > 0) return;
    const { hash, salt } = await hashPassword(password);
    this.directory.insert(users).values({ username: username.toLowerCase(), passwordHash: hash, passwordSalt: salt, role: 'admin', dataPath: '' }).run();
  }

  list() {
    return this.directory.select().from(users).all();
  }

  find(id: number) {
    return this.directory.select().from(users).where(eq(users.id, id)).get();
  }

  dataDirOf(user: UserRow) {
    return user.dataPath ? join(this.base.dataDir, user.dataPath) : this.base.dataDir;
  }

  // ---- Letting someone else into your books ------------------------------------------

  grantAccess(ownerId: number, username: string, role: 'editor' | 'viewer') {
    const member = this.findByName(username);
    if (!member || member.disabled || member.pending) throw new DomainError('not_found', 'There is no one with that username');
    if (member.id === ownerId) throw new DomainError('invalid', 'These are already your books');
    this.directory
      .insert(shares)
      .values({ ownerId, memberId: member.id, role })
      .onConflictDoUpdate({ target: [shares.ownerId, shares.memberId], set: { role } })
      .run();
    return member;
  }

  revokeAccess(ownerId: number, memberId: number) {
    this.directory.delete(shares).where(and(eq(shares.ownerId, ownerId), eq(shares.memberId, memberId))).run();
  }

  // Who may open this person's books.
  sharedBy(ownerId: number) {
    return this.directory
      .select()
      .from(shares)
      .where(eq(shares.ownerId, ownerId))
      .all()
      .flatMap((s) => {
        const member = this.find(s.memberId);
        return member ? [{ memberId: member.id, username: member.username, role: s.role }] : [];
      });
  }

  // Whose books this person may open.
  sharedWith(memberId: number) {
    return this.directory
      .select()
      .from(shares)
      .where(eq(shares.memberId, memberId))
      .all()
      .flatMap((s) => {
        const owner = this.find(s.ownerId);
        return owner && !owner.disabled && !owner.pending ? [{ ownerId: owner.id, username: owner.username, role: s.role }] : [];
      });
  }

  accessTo(memberId: number, ownerId: number) {
    return this.directory.select().from(shares).where(and(eq(shares.ownerId, ownerId), eq(shares.memberId, memberId))).get()?.role ?? null;
  }

  findByEmail(email: string) {
    return this.directory.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
  }

  findByName(username: string) {
    return this.directory.select().from(users).where(eq(users.username, username.trim().toLowerCase())).get();
  }

  tenantFor(user: UserRow): Tenant {
    const existing = this.open.get(user.id);
    this.lastUsed.set(user.id, Date.now());
    if (existing) return existing;
    const dataDir = user.dataPath ? join(this.base.dataDir, user.dataPath) : this.base.dataDir;
    const db = openDb(join(dataDir, 'ledgerly.db'));
    seedDefaults(db);
    ensureStarterCategories(db);
    const tenant: Tenant = { id: user.id, username: user.username, isAdmin: user.role === 'admin', db, dataDir, emailOf: () => this.find(user.id)?.email ?? null };
    this.open.set(user.id, tenant);
    this.onOpen?.(tenant);
    return tenant;
  }

  // Closes the books of people who have not been using them, once too many are open.
  evictIdle(now = Date.now()) {
    if (this.open.size <= this.maxOpen) return;
    const idle = [...this.open.keys()]
      .filter((id) => now - (this.lastUsed.get(id) ?? 0) > this.idleMs)
      .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
    for (const id of idle) {
      if (this.open.size <= this.maxOpen) break;
      this.closeTenant(id);
    }
  }

  get openCount() {
    return this.open.size;
  }

  openAll() {
    return this.list().filter((u) => !u.disabled && !u.pending).map((u) => this.tenantFor(u));
  }

  async create(input: { username: string; password: string; role: 'admin' | 'user' }) {
    const username = input.username.trim().toLowerCase();
    if (!USERNAME.test(username)) throw new DomainError('invalid', 'A username is 3 to 40 letters, numbers, dots, dashes or underscores');
    const problem = passwordProblem(input.password, username);
    if (problem) throw new DomainError('invalid', problem);
    if (this.findByName(username)) throw new DomainError('conflict', 'That username is taken');
    const created = await this.createUserRecord({ username, password: input.password, role: input.role, pending: false });
    return this.tenantFor(created);
  }

  // The account itself. Their books are made the first time they are used, so a
  // pending or abandoned sign-up leaves no database behind.
  private async createUserRecord(input: { username: string; password: string; role: 'admin' | 'user'; pending: boolean; email?: string; emailVerified?: boolean }) {
    const username = input.username.trim().toLowerCase();
    if (!USERNAME.test(username)) throw new DomainError('invalid', 'A username is 3 to 40 letters, numbers, dots, dashes or underscores');
    const problem = passwordProblem(input.password, username);
    if (problem) throw new DomainError('invalid', problem);
    if (this.findByName(username)) throw new DomainError('conflict', 'That username is taken');
    const { hash, salt } = await hashPassword(input.password);
    const created = this.directory.insert(users).values({ username, passwordHash: hash, passwordSalt: salt, role: input.role, dataPath: 'pending', pending: input.pending, email: input.email ?? null, emailVerified: input.emailVerified ?? true }).returning().get();
    const dataPath = join('users', String(created.id));
    this.directory.update(users).set({ dataPath }).where(eq(users.id, created.id)).run();
    return { ...created, dataPath };
  }

  // ---- Who may sign up ---------------------------------------------------------

  signupMode(): Config['signupMode'] {
    const stored = this.directory.select().from(directorySettings).where(eq(directorySettings.key, 'signup.mode')).get()?.value;
    return (['closed', 'invite', 'approval', 'open'] as const).find((m) => m === stored) ?? this.base.signupMode;
  }

  setSignupMode(mode: Config['signupMode']) {
    this.directory.insert(directorySettings).values({ key: 'signup.mode', value: mode }).onConflictDoUpdate({ target: directorySettings.key, set: { value: mode } }).run();
  }

  // An invite is a code, shown once. Only its hash is kept.
  createInvite(input: { role: 'admin' | 'user'; note?: string; createdBy: number; days?: number }) {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const raw = Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join('');
    const code = raw.match(/.{4}/g)!.join('-');
    const expiresAt = new Date(Date.now() + (input.days ?? 7) * 86_400_000).toISOString();
    const row = this.directory.insert(invites).values({ codeHash: hashCode(code), role: input.role, note: input.note?.slice(0, 100) ?? null, createdBy: input.createdBy, expiresAt }).returning().get();
    return { id: row.id, code, expiresAt };
  }

  listInvites() {
    return this.directory.select().from(invites).all().map(({ codeHash: _h, ...rest }) => rest);
  }

  revokeInvite(id: number) {
    const removed = this.directory.delete(invites).where(and(eq(invites.id, id), isNull(invites.usedBy))).returning().all();
    if (removed.length === 0) throw new DomainError('not_found', 'No such unused invite');
  }

  // Creating your own account. What happens depends on the mode: a valid code
  // always lets you in (unless sign-up is closed), and without one it needs the
  // mode to be open, or open with approval.
  async register(input: { username: string; password: string; code?: string; email?: string }) {
    const mode = this.signupMode();
    if (mode === 'closed') throw new DomainError('invalid', 'Sign-up is closed. Ask an administrator for an account.');
    const invite = input.code ? this.directory.select().from(invites).where(eq(invites.codeHash, hashCode(input.code))).get() : undefined;
    const valid = invite && !invite.usedBy && invite.expiresAt > new Date().toISOString();
    if (input.code && !valid) throw new DomainError('invalid', 'That invite code is not valid, or has been used or expired');
    if (!valid && mode === 'invite') throw new DomainError('invalid', 'Sign-up needs an invite code');

    // When the server can send mail, an address is needed and must be confirmed before the first login.
    const mailOn = canSendMail(this.base);
    const email = input.email?.trim().toLowerCase();
    if (mailOn && !(email && EMAIL.test(email))) throw new DomainError('invalid', 'Enter a valid email address');
    if (email && !EMAIL.test(email)) throw new DomainError('invalid', 'That does not look like an email address');
    if (email && this.findByEmail(email)) throw new DomainError('conflict', 'That email address is already used');

    const pending = !valid && mode === 'approval';
    const tenantless = await this.createUserRecord({ username: input.username, password: input.password, role: valid ? invite!.role : 'user', pending, email, emailVerified: !mailOn });
    if (valid) this.directory.update(invites).set({ usedBy: tenantless.id, usedAt: new Date().toISOString() }).where(eq(invites.id, invite!.id)).run();
    return { user: tenantless, pending };
  }

  approve(id: number) {
    const user = this.find(id);
    if (!user?.pending) throw new DomainError('not_found', 'No one is waiting with that id');
    this.directory.update(users).set({ pending: false }).where(eq(users.id, id)).run();
  }

  async setPassword(id: number, password: string) {
    const problem = passwordProblem(password, this.find(id)?.username ?? '');
    if (problem) throw new DomainError('invalid', problem);
    const { hash, salt } = await hashPassword(password);
    this.directory.update(users).set({ passwordHash: hash, passwordSalt: salt }).where(eq(users.id, id)).run();
    // Signing in again is needed everywhere after a new password.
    this.directory.delete(userSessions).where(eq(userSessions.userId, id)).run();
  }

  private admins() {
    return this.list().filter((u) => u.role === 'admin' && !u.disabled);
  }

  update(id: number, change: { disabled?: boolean; role?: 'admin' | 'user' }) {
    const user = this.find(id);
    if (!user) throw new DomainError('not_found', 'No such user');
    const losesAdmin = (change.disabled === true || change.role === 'user') && user.role === 'admin';
    if (losesAdmin && this.admins().length <= 1) throw new DomainError('conflict', 'There must be at least one administrator');
    if (change.disabled !== undefined || change.role !== undefined) this.directory.update(users).set(change).where(eq(users.id, id)).run();
    if (change.disabled) {
      this.directory.delete(userSessions).where(eq(userSessions.userId, id)).run();
      this.closeTenant(id);
    }
  }

  private closeTenant(id: number) {
    this.lastUsed.delete(id);
    const tenant = this.open.get(id);
    if (!tenant) return;
    this.onClose?.(tenant);
    tenant.db.close();
    this.open.delete(id);
  }

  // Removes the account and everything in its folder. Only a person who is
  // already disabled can be removed, and never the first administrator's books.
  async remove(id: number) {
    const user = this.find(id);
    if (!user) throw new DomainError('not_found', 'No such user');
    if (!user.disabled && !user.pending) throw new DomainError('conflict', 'Disable the account first');
    if (user.dataPath === '') throw new DomainError('conflict', 'This account holds the books that were here first, and is not removed from the app');
    this.closeTenant(id);
    this.directory.delete(userSessions).where(eq(userSessions.userId, id)).run();
    this.directory.delete(shares).where(or(eq(shares.ownerId, id), eq(shares.memberId, id))).run();
    this.directory.delete(users).where(eq(users.id, id)).run();
    await rm(join(this.base.dataDir, user.dataPath), { recursive: true, force: true });
  }

  close() {
    for (const id of [...this.open.keys()]) this.closeTenant(id);
    this.directory.close();
  }
}
