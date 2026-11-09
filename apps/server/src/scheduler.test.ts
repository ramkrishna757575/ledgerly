import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@ledgerly/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { listBackups } from './backup.ts';
import { loadConfig } from './config.ts';
import { nextSlot, Scheduler } from './scheduler.ts';
import { initSecrets } from './secrets.ts';
import { Tenants, type Tenant } from './tenants.ts';

beforeAll(() => initSecrets(mkdtempSync(join(tmpdir(), 'ledgerly-sched-'))));
const HOURS = 3_600_000;
// A moment a little after an hour on the clock, so no job's slot falls within a second of it.
const ON_THE_HOUR = Math.floor(Date.now() / HOURS) * HOURS;

function ledger(): Tenant {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-sched-'));
  return { id: 1, username: 'x', isAdmin: true, db: openDb(join(dataDir, 'ledgerly.db')), dataDir };
}

describe('the clock a job runs on', () => {
  it('falls on the quarter hour plus a fixed few seconds of the person\'s own', () => {
    const noon = Date.UTC(2026, 10, 6, 6, 30, 0); // 12:00 in India
    const mine = nextSlot(noon + 5_000, 15 * MIN, 1);
    expect((mine - Date.UTC(2026, 10, 6, 6, 30, 0)) % (15 * MIN)).toBeLessThan(60_000);
    expect(mine).toBeGreaterThan(noon + 5_000);
    expect(mine - noon).toBeLessThanOrEqual(15 * MIN + 60_000);
    // Stable: asking again, or after a restart, gives the same time.
    expect(nextSlot(noon + 5_000, 15 * MIN, 1)).toBe(mine);
    // Someone else's is a different few seconds, not a different quarter hour.
    expect(Math.abs(nextSlot(noon + 5_000, 15 * MIN, 2) - mine)).toBeLessThan(60_000);
  });
});

describe('the scheduler', () => {
  it('does nothing until something is due, then does each job once and reschedules it', async () => {
    const tenant = ledger();
    const config = { ...loadConfig({ DATA_DIR: tenant.dataDir }) };
    let opened = 0;
    const logs: string[] = [];
    const scheduler = new Scheduler(config, (m) => logs.push(m), () => [{ id: 1, open: () => (opened++, tenant) }]);
    const t0 = ON_THE_HOUR + 100_000;

    await scheduler.sweep(t0 - 1); // nothing due yet (first checks are spread out over their interval)
    expect(opened).toBe(0);
    expect(await listBackups({ ...config, dataDir: tenant.dataDir })).toEqual([]);

    await scheduler.sweep(t0 + 7 * HOURS); // every job is now due
    expect(opened).toBe(1);
    expect(await listBackups({ ...config, dataDir: tenant.dataDir })).toHaveLength(1);
    expect(logs.some((l) => /Backup written/.test(l))).toBe(true);

    await scheduler.sweep(t0 + 7 * HOURS + 1000); // just did them all
    expect(opened).toBe(1);
    await scheduler.sweep(t0 + 7 * HOURS + 6 * MIN); // only the five-minute job is due again
    expect(opened).toBe(2);
  });

  it('carries on with the next person and job when one fails, and says so', async () => {
    const good = ledger();
    const config = { ...loadConfig({ DATA_DIR: good.dataDir }) };
    const broken: Tenant = { ...ledger(), id: 2, db: { run() { throw new Error('disk is gone'); } } as never };
    const logs: string[] = [];
    const people = [
      { id: 2, open: () => { throw new Error('cannot open'); } },
      { id: 1, open: () => good },
    ];
    void broken;
    const scheduler = new Scheduler(config, (m) => logs.push(m), () => people);
    const t0 = ON_THE_HOUR + 100_000;
    await scheduler.sweep(t0); // the first look only plans when each job will run
    await scheduler.sweep(t0 + 7 * HOURS);
    expect(logs.some((l) => /Could not open books 2: cannot open/.test(l))).toBe(true);
    expect(await listBackups({ ...config, dataDir: good.dataDir })).toHaveLength(1);
  });

  it('does not overlap itself', async () => {
    const tenant = ledger();
    const config = { ...loadConfig({ DATA_DIR: tenant.dataDir }) };
    let opened = 0;
    const scheduler = new Scheduler(config, () => {}, () => [{ id: 1, open: () => (opened++, tenant) }]);
    const t0 = ON_THE_HOUR + 100_000;
    await scheduler.sweep(t0);
    await Promise.all([scheduler.sweep(t0 + 7 * HOURS), scheduler.sweep(t0 + 7 * HOURS)]);
    expect(opened).toBe(1);
  });
});

const MIN = 60_000;

describe('keeping only some books open', () => {
  it('closes the ones that have been idle longest, once too many are open', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ledgerly-lru-'));
    const config = loadConfig({ DATA_DIR: dataDir, MULTI_USER: 'true', AUTH_PASSWORD: 'admin-password' });
    const tenants = new Tenants(config);
    tenants.maxOpen = 2;
    tenants.idleMs = 1000;
    await tenants.bootstrap('asha', 'admin-password');
    for (const name of ['ben', 'cara', 'dev']) await tenants.create({ username: name, password: 'quiet-river-stone-1', role: 'user' });
    expect(tenants.openCount).toBe(3);

    tenants.evictIdle(Date.now()); // nothing has been idle for a second
    expect(tenants.openCount).toBe(3);
    tenants.evictIdle(Date.now() + 5_000);
    expect(tenants.openCount).toBe(2);

    // A closed ledger opens again when needed, with its data.
    const ben = tenants.findByName('ben')!;
    expect(tenants.tenantFor(ben).db.select().from((await import('@ledgerly/db')).accounts).all().length).toBeGreaterThan(0);
    tenants.close();
  });
});
