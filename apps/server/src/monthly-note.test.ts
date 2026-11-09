import { openDb } from '@ledgerly/db';
import { describe, expect, it } from 'vitest';
import type { Config } from './config.ts';
import { monthlyOn, setMonthlyOn, tickMonthlyNote } from './monthly-note.ts';

const config = { ai: { provider: 'openai', model: 'm', baseUrl: 'http://localhost:1/v1' }, demoMode: false } as unknown as Config;

describe('the monthly check-in', () => {
  it('stays off until turned on, and waits until statements have had time to arrive', async () => {
    const db = openDb(':memory:');
    const log: string[] = [];
    expect(monthlyOn(db)).toBe(false);
    // Off: nothing is attempted (an attempt would fail to connect and be logged).
    await tickMonthlyNote(db, config, (m) => log.push(m), new Date('2026-11-10T10:00:00Z'));
    setMonthlyOn(db, true);
    // On, but too early in the month.
    await tickMonthlyNote(db, config, (m) => log.push(m), new Date('2026-11-02T10:00:00Z'));
    expect(log).toEqual([]);
  });

  it('says so in the log when it cannot write one, instead of failing the scheduler', async () => {
    const db = openDb(':memory:');
    setMonthlyOn(db, true);
    const log: string[] = [];
    await tickMonthlyNote(db, config, (m) => log.push(m), new Date('2026-11-10T10:00:00Z'));
    expect(log[0]).toMatch(/Could not write/);
  });
});
