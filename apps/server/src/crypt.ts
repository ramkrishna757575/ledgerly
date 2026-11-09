import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const derive = promisify(scrypt) as (password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const MAGIC = Buffer.from('LGBK1');
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + SALT + IV;
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

// AES-256-GCM with a key stretched from the passphrase by scrypt. The file
// holds a header (marker, salt, nonce), the encrypted data, then the tag that
// proves nothing was changed.
export async function encryptFile(input: string, output: string, passphrase: string) {
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', await derive(passphrase, salt, 32, KDF), iv);
  const out = createWriteStream(output, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(createReadStream(input), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), (error?: Error | null) => (error ? reject(error) : resolve())));
}

export class WrongPassphrase extends Error {
  constructor() {
    super('Wrong passphrase, or the backup is damaged');
  }
}

export async function decryptFile(input: string, output: string, passphrase: string) {
  const handle = await open(input, 'r');
  try {
    const { size } = await handle.stat();
    if (size < HEADER + TAG) throw new Error('Not an encrypted Ledgerly backup');
    const header = Buffer.alloc(HEADER);
    await handle.read(header, 0, HEADER, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted Ledgerly backup');
    const tag = Buffer.alloc(TAG);
    await handle.read(tag, 0, TAG, size - TAG);

    const salt = header.subarray(MAGIC.length, MAGIC.length + SALT);
    const iv = header.subarray(MAGIC.length + SALT);
    const decipher = createDecipheriv('aes-256-gcm', await derive(passphrase, salt, 32, KDF), iv);
    decipher.setAuthTag(tag);
    try {
      await pipeline(createReadStream(input, { start: HEADER, end: size - TAG - 1 }), decipher, createWriteStream(output, { mode: 0o600 }));
    } catch {
      throw new WrongPassphrase();
    }
  } finally {
    await handle.close();
  }
}
