import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import * as schema from './schema.ts';

export * from './schema.ts';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'drizzle');

// An earlier "Start over" also emptied the record of which migrations had run, so the
// next start tried to build tables that were already there. If the tables exist but
// the record is empty, the schema is whole, so write the record back.
function restoreMigrationRecord(sqlite: Database.Database) {
  const has = (name: string) => sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  if (!has('__drizzle_migrations') || !has('accounts')) return;
  if ((sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }).n > 0) return;
  const insert = sqlite.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)');
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR })) insert.run(m.hash, m.folderMillis);
}

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  restoreMigrationRecord(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return Object.assign(db, { close: () => sqlite.close() });
}

export type Db = ReturnType<typeof openDb>;
export * from './directory.ts';
