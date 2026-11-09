import { dismissals, settings, type Db } from '@ledgerly/db';
import { eq } from 'drizzle-orm';

export function getSetting(db: Db, key: string) {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

export function setSetting(db: Db, key: string, value: string) {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

export function isDismissed(db: Db, key: string) {
  return db.select().from(dismissals).where(eq(dismissals.key, key)).get() !== undefined;
}

export function dismiss(db: Db, key: string) {
  db.insert(dismissals).values({ key }).onConflictDoNothing().run();
}

export function undismiss(db: Db, key: string) {
  db.delete(dismissals).where(eq(dismissals.key, key)).run();
}

export function dismissedKeys(db: Db) {
  return new Set(db.select({ key: dismissals.key }).from(dismissals).all().map((row) => row.key));
}
