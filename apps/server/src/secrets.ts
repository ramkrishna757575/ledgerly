import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Keys and passwords a person enters (an AI key, a mailbox password) are kept
// encrypted in their own database, so a copy of the database alone does not
// give them away. The key that opens them is not in the database: it is in
// SECRETS_KEY, or a file in the data folder that only this server can read.
let key: Buffer | undefined;

export function initSecrets(dataDir: string, fromEnv = process.env.SECRETS_KEY) {
  if (fromEnv) {
    const decoded = Buffer.from(fromEnv, 'base64');
    if (decoded.length !== 32) throw new Error('SECRETS_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)');
    key = decoded;
    return;
  }
  const path = join(dataDir, 'secret.key');
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
}

const need = () => {
  if (!key) throw new Error('Secrets are not set up');
  return key;
};

export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', need(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

export function decryptSecret(stored: string | undefined | null) {
  if (!stored?.startsWith('enc1:')) return undefined;
  try {
    const raw = Buffer.from(stored.slice(5), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', need(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    // A different key, or damage: treated as not set, never as a crash.
    return undefined;
  }
}

// A signature only this server can make, for tokens it hands out and checks later.
export const signValue = (value: string) => createHmac('sha256', need()).update(`sign:${value}`).digest('base64url');
