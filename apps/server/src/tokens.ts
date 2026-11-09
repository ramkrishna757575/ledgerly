import { timingSafeEqual } from 'node:crypto';
import { signValue } from './secrets.ts';

// A link in an email carries one of these. It says what it is for and who, when it stops
// working, and a fingerprint of something that changes once it has been used (such as the
// password hash), so a link works once. The server signs it, so it cannot be forged.
export function makeToken(kind: 'verify' | 'reset', userId: number, lifetimeMs: number, fingerprint = '', data = '', now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ k: kind, u: userId, e: now + lifetimeMs, f: fingerprint, d: data })).toString('base64url');
  return `${body}.${signValue(`token:${body}`)}`;
}

export function readToken(token: string, kind: 'verify' | 'reset', now = Date.now()): { userId: number; fingerprint: string; data: string } | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(signValue(`token:${body}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as { k: string; u: number; e: number; f: string; d: string };
    if (parsed.k !== kind || parsed.e < now || !Number.isInteger(parsed.u)) return null;
    return { userId: parsed.u, fingerprint: parsed.f, data: parsed.d };
  } catch {
    return null;
  }
}
