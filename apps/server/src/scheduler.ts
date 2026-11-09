import { accrueDeposits } from '@ledgerly/core';
import type { Config } from './config.ts';
import { tickBackup } from './backup.ts';
import { tickInbox } from './inbox.ts';
import { tickMail } from './mail.ts';
import { tickSummary } from './summary-mail.ts';
import { tickMonthlyNote } from './monthly-note.ts';
import { tickAlerts } from './notify.ts';
import { tickPrices } from './prices.ts';
import { liveConfig, type Tenant, type Tenants } from './tenants.ts';

const MIN = 60_000;
type Job = { name: string; every: number; run: (tenant: Tenant, config: Config, log: (m: string) => void) => Promise<void> | void };

const JOBS: Job[] = [
  { name: 'accrue', every: 6 * 60 * MIN, run: (t) => void accrueDeposits(t.db) },
  { name: 'alerts', every: 60 * MIN, run: (t, c, log) => tickAlerts(t.db, c, log) },
  { name: 'inbox', every: 5 * MIN, run: (t, c, log) => tickInbox(t.db, c, log) },
  { name: 'mail', every: 15 * MIN, run: (t, c, log) => tickMail(t.db, c, log) },
  { name: 'prices', every: 60 * MIN, run: (t, c, log) => tickPrices(t.db, c, log) },
  { name: 'summary', every: 60 * MIN, run: (t, c, log) => tickSummary(t.db, c, t.emailOf?.(), log) },
  { name: 'monthly-note', every: 6 * 60 * MIN, run: (t, c, log) => tickMonthlyNote(t.db, c, log) },
  { name: 'backup', every: 60 * MIN, run: (t, c, log) => tickBackup(t.db, c, log, t.username || 'main') },
];

// The things that run by themselves for everyone's books: deposits growing,
// backups, prices, alerts, the statement folder and the mailbox. One loop goes
// through the people in turn, opening a person's books only when something of
// theirs is due, so a site with many people does not hold them all open, and
// each person's checks fall on the clock a few seconds apart from everyone else's.
// Jobs run on the clock: a 15 minute job at :00, :15, :30 and :45, an hourly one on the hour.
// Each person gets a fixed few seconds of their own, so a site with many people does not
// ask every mailbox at the same instant, and a restart does not move anyone's times.
export function nextSlot(now: number, every: number, personId: number) {
  const offset = ((personId * 2_654_435_761) % 60) * 1000;
  return Math.floor((now - offset) / every) * every + offset + every;
}

// The scheduler that is running now, so a page can say when something is next due.
let current: Scheduler | undefined;

export function nextRun(personId: number, job: string): string | null {
  const at = current?.dueAt(personId, job);
  return at === undefined ? null : new Date(at).toISOString();
}

export class Scheduler {
  private due = new Map<string, number>();
  private running = false;
  private timer?: ReturnType<typeof setInterval>;

  private base: Config;
  private log: (message: string) => void;
  // Who to look after, as ids with a way to open their books.
  private people: () => { id: number; open: () => Tenant }[];
  private after?: () => void;

  constructor(base: Config, log: (message: string) => void, people: () => { id: number; open: () => Tenant }[], after?: () => void) {
    this.base = base;
    this.log = log;
    this.people = people;
    this.after = after;
    current = this;
  }

  dueAt(personId: number, job: string) {
    return this.due.get(`${personId}:${job}`);
  }

  start(everyMs = 30_000) {
    this.timer = setInterval(() => void this.sweep(), everyMs);
    this.timer.unref();
    setTimeout(() => void this.sweep(), 5_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private dueJobs(id: number, now: number) {
    return JOBS.filter((job) => {
      const key = `${id}:${job.name}`;
      if (!this.due.has(key)) this.due.set(key, nextSlot(now, job.every, id));
      return now >= this.due.get(key)!;
    });
  }

  async sweep(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const person of this.people()) {
        const jobs = this.dueJobs(person.id, now);
        if (jobs.length === 0) continue;
        let tenant: Tenant;
        try {
          tenant = person.open();
        } catch (error) {
          this.log(`Could not open books ${person.id}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const config = liveConfig(this.base, tenant);
        for (const job of jobs) {
          this.due.set(`${person.id}:${job.name}`, nextSlot(now, job.every, person.id));
          try {
            await job.run(tenant, config, this.log);
          } catch (error) {
            this.log(`${job.name} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        this.after?.();
      }
    } finally {
      this.running = false;
    }
  }
}

export function schedulerFor(base: Config, log: (message: string) => void, tenants?: Tenants, solo?: Tenant) {
  const people = () =>
    tenants
      ? tenants
          .list()
          .filter((u) => !u.disabled && !u.pending)
          .map((u) => ({ id: u.id, open: () => tenants.tenantFor(u) }))
      : solo
        ? [{ id: solo.id, open: () => solo }]
        : [];
  return new Scheduler(base, log, people, tenants ? () => tenants.evictIdle() : undefined);
}
