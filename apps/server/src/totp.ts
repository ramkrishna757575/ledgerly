import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// One-time codes from an authenticator app (RFC 6238): six digits that change every 30 seconds.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32(bytes: Buffer) {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function unbase32(text: string) {
  let bits = '';
  for (const char of text.replace(/=+$/, '').toUpperCase()) bits += ALPHABET.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export const newTotpSecret = () => base32(randomBytes(20));

export function totpCode(secret: string, step: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', unbase32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

const stepOf = (now: number) => Math.floor(now / 1000 / STEP_SECONDS);

// The step a code belongs to, if it is right for now (allowing a step either side for clock
// drift) and has not been used already. A code is good once, so a watcher cannot replay it.
export function verifyTotp(secret: string, code: string, lastUsedStep: number, now = Date.now()) {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = stepOf(now);
  for (const step of [current, current - 1, current + 1]) {
    if (step <= lastUsedStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(given))) return step;
  }
  return null;
}

export const otpauthUri = (issuer: string, account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

// Codes to use once if the phone is lost. Only their hashes are kept.
export function newRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
export const hashRecoveryCode = (code: string) => createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex');
