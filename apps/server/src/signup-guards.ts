import { createHash, randomBytes } from 'node:crypto';
import { signValue } from './secrets.ts';

// ---- Passwords ---------------------------------------------------------------

const COMMON = new Set(['password', 'password1', 'password12', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'qwerty12345', 'iloveyou123', 'letmein1234', 'welcome1234', 'admin12345', 'abcdefghij', 'passw0rd123', '0123456789', '1q2w3e4r5t', 'qazwsxedcr', 'changeme123']);

export const MIN_PASSWORD = 10;

// Enough to turn away the obvious, without rules that make people write them down.
export function passwordProblem(password: string, username: string) {
  if (password.length < MIN_PASSWORD) return `A password needs at least ${MIN_PASSWORD} characters`;
  if (password.length > 200) return 'That password is too long';
  const plain = password.toLowerCase();
  if (COMMON.has(plain) || /^(.)\1+$/.test(plain)) return 'That password is too easy to guess';
  if (username && plain.includes(username.toLowerCase())) return 'A password should not contain your username';
  if (new Set(plain).size < 5) return 'That password is too easy to guess';
  return null;
}

// ---- A small puzzle before sign-up -------------------------------------------------
// Automated sign-ups cost a little work each. A visitor's browser finds a number
// whose hash starts with zeros, which takes a moment for one person and adds up
// for a thousand fake accounts. No outside service is involved.

const DIFFICULTY = 15;
const LIFETIME_MS = 10 * 60 * 1000;
const spent = new Map<string, number>();

export function issueChallenge(now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ n: randomBytes(12).toString('base64url'), exp: now + LIFETIME_MS, d: DIFFICULTY })).toString('base64url');
  return { token: `${payload}.${signValue(payload)}`, difficulty: DIFFICULTY };
}

const leadingZeroBits = (digest: Buffer) => {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) bits += 8;
    else {
      bits += Math.clz32(byte) - 24;
      break;
    }
  }
  return bits;
};

export function verifyChallenge(token: string, nonce: string, now = Date.now()) {
  const [payload, signature] = token.split('.');
  if (!payload || !signature || signature !== signValue(payload)) return false;
  let data: { n: string; exp: number; d: number };
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (data.exp < now || spent.has(data.n)) return false;
  if (leadingZeroBits(createHash('sha256').update(`${token}:${nonce}`).digest()) < data.d) return false;
  // Each puzzle works once.
  spent.set(data.n, data.exp);
  for (const [key, exp] of spent) if (exp < now) spent.delete(key);
  return true;
}

// Solving it, as a browser does (here for tests).
export function solveChallenge(token: string, difficulty: number) {
  for (let i = 0; ; i++) {
    if (leadingZeroBits(createHash('sha256').update(`${token}:${i}`).digest()) >= difficulty) return String(i);
  }
}

// ---- Guessing passwords ---------------------------------------------------------------

const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 8;

// After a few wrong passwords for one name, that name is paused for a while, whoever is asking.
export function loginBlocked(username: string, now = Date.now()) {
  const f = failures.get(username.toLowerCase());
  if (!f) return false;
  if (now - f.first > WINDOW_MS) {
    failures.delete(username.toLowerCase());
    return false;
  }
  return f.count >= LIMIT;
}
export function loginFailed(username: string, now = Date.now()) {
  const key = username.toLowerCase();
  const f = failures.get(key);
  if (!f || now - f.first > WINDOW_MS) failures.set(key, { count: 1, first: now });
  else f.count += 1;
}
export const loginSucceeded = (username: string) => void failures.delete(username.toLowerCase());

// For tests, which share one process.
export const resetLoginThrottle = () => failures.clear();
