// A short memory of failed sign-ins, so an administrator can see someone guessing. Kept
// only in memory (it is gone on a restart), and a name is recorded only if it is a real
// account, since a mistyped one may really be a password.
export type SecurityEvent = { at: string; kind: 'wrong_password' | 'wrong_code' | 'paused' | 'unknown_name'; username: string | null; ip: string };

const events: SecurityEvent[] = [];
const MAX = 200;

export function recordFailure(event: Omit<SecurityEvent, 'at'>) {
  events.unshift({ at: new Date().toISOString(), ...event });
  if (events.length > MAX) events.length = MAX;
}

export const recentFailures = (limit = 50) => events.slice(0, limit);
export const clearFailures = () => void (events.length = 0);
