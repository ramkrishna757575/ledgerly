import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DomainError } from '@ledgerly/core';

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

export function isPrivateAddress(address: string) {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  return isIP(a) === 4 ? PRIVATE_V4.some((r) => r.test(a)) : a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80');
}

// A name or address that is on the public internet. On a server shared by many
// people, anyone but the administrator may only make it call outward, never at
// machines inside its own network.
export async function assertPublicHost(host: string) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(bare)) throw new DomainError('invalid', 'That address is inside a private network, which is not allowed here');
  const addresses = isIP(bare) ? [bare] : (await lookup(bare, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new DomainError('invalid', 'That address could not be found');
  if (addresses.some(isPrivateAddress)) throw new DomainError('invalid', 'That address is inside a private network, which is not allowed here');
}

export async function assertPublicUrl(url: string, options: { https?: boolean } = { https: true }) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DomainError('invalid', 'That is not a web address');
  }
  if (options.https !== false && parsed.protocol !== 'https:') throw new DomainError('invalid', 'Use an https address');
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new DomainError('invalid', 'That is not a web address');
  await assertPublicHost(parsed.hostname);
}
