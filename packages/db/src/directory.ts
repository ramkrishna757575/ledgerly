import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Who can sign in. Each person's books live in their own database file, so
// nothing a person owns is in this one but their name and a password hash.
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  // The folder holding this person's data, relative to the data folder. Empty
  // for the first administrator, whose books were there before there were users.
  dataPath: text('data_path').notNull(),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  // Signed up and waiting for an administrator to let them in.
  pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
  // For verification, a forgotten password and the monthly summary. Accounts made before
  // email existed count as verified.
  email: text('email'),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(true),
  lastLoginAt: text('last_login_at'),
  // When they agreed to the terms and privacy pages, if the site asks for that.
  termsAcceptedAt: text('terms_accepted_at'),
  // Two-step sign-in. The secret is sealed, a code is good once (the last step used), and
  // only hashes of the recovery codes are kept.
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  totpLastStep: integer('totp_last_step').notNull().default(0),
  recoveryHashes: text('recovery_hashes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const userSessions = sqliteTable('user_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: integer('user_id').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const directorySettings = sqliteTable('directory_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// A code that lets one person sign up. Only its hash is kept.
export const invites = sqliteTable('invites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  codeHash: text('code_hash').notNull().unique(),
  role: text('role', { enum: ['admin', 'user'] }).notNull().default('user'),
  note: text('note'),
  createdBy: integer('created_by').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  expiresAt: text('expires_at').notNull(),
  usedBy: integer('used_by'),
  usedAt: text('used_at'),
});

// One person letting another into their books. The books stay in the owner's folder; this
// only says who else may open them, and whether they may change anything.
export const shares = sqliteTable('shares', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ownerId: integer('owner_id').notNull(),
  memberId: integer('member_id').notNull(),
  role: text('role', { enum: ['editor', 'viewer'] }).notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export function openDirectory(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      data_path TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS directory_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'user',
      note TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at TEXT NOT NULL,
      used_by INTEGER,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (owner_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  // A directory made before sign-up existed gets the new column.
  if (!sqlite.prepare("PRAGMA table_info(users)").all().some((c) => (c as { name: string }).name === 'pending')) {
    sqlite.exec('ALTER TABLE users ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
  }
  const have = new Set((sqlite.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name));
  for (const [column, ddl] of [
    ['totp_secret', 'TEXT'],
    ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
    ['totp_last_step', 'INTEGER NOT NULL DEFAULT 0'],
    ['recovery_hashes', "TEXT NOT NULL DEFAULT '[]'"],
    ['last_login_at', 'TEXT'],
    ['terms_accepted_at', 'TEXT'],
    ['email', 'TEXT'],
    ['email_verified', 'INTEGER NOT NULL DEFAULT 1'],
  ] as const) {
    if (!have.has(column)) sqlite.exec(`ALTER TABLE users ADD COLUMN ${column} ${ddl}`);
  }
  const db = drizzle(sqlite, { schema: { users, userSessions, directorySettings, invites, shares } });
  return Object.assign(db, { close: () => sqlite.close() });
}

export type Directory = ReturnType<typeof openDirectory>;
