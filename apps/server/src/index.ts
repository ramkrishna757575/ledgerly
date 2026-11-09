import { rmSync } from 'node:fs';
import { ensureStarterCategories, resetDemoData, seedDefaults } from '@ledgerly/core';
import { openDb } from '@ledgerly/db';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { schedulerFor } from './scheduler.ts';
import { initSecrets } from './secrets.ts';
import { Tenants } from './tenants.ts';

const config = loadConfig();
initSecrets(config.dataDir);

if (config.demoMode) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(config.dbPath + suffix, { force: true });
}

let log: (message: string) => void = () => {};
const stops: (() => void)[] = [];
let close: () => Promise<void> = async () => {};

if (config.multiUser) {
  // Several people, each with their own separate books and files.
  const tenants = new Tenants(config);
  await tenants.bootstrap(config.adminUsername, config.authPassword!);
  const app = await buildApp(openDb(':memory:'), config, { logger: true, tenants });
  log = (message) => app.log.info(message);
  const scheduler = schedulerFor(config, (m) => log(m), tenants);
  scheduler.start();
  close = async () => {
    scheduler.stop();
    await app.close();
    tenants.close();
  };
  await app.listen({ port: config.port, host: config.host });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      await close();
      process.exit(0);
    });
  }
} else {
  const db = openDb(config.dbPath);
  if (config.demoMode) resetDemoData(db);
  else {
    seedDefaults(db);
    ensureStarterCategories(db);
  }
  const app = await buildApp(db, config, { logger: true });
  log = (message) => app.log.info(message);
  const solo = { id: 0, username: '', isAdmin: true, db, dataDir: config.dataDir };
  const scheduler = schedulerFor(config, (m) => log(m), undefined, solo);
  scheduler.start();
  stops.push(() => scheduler.stop());
  await app.listen({ port: config.port, host: config.host });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      stops.forEach((stop) => stop());
      await app.close();
      db.close();
      process.exit(0);
    });
  }
}
