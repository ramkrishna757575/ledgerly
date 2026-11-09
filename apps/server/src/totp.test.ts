import { describe, expect, it } from 'vitest';
import { base32, hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, totpCode, verifyTotp } from './totp.ts';

// The test vector from RFC 6238: the key "12345678901234567890" at 59 seconds is 94287082 (eight digits).
describe('one-time codes', () => {
  const key = base32(Buffer.from('12345678901234567890'));

  it('agrees with the published test vectors', () => {
    expect(totpCode(key, 1)).toBe('287082'); // 59 seconds
    expect(totpCode(key, 37037036)).toBe('081804'); // 1111111109 seconds
    expect(totpCode(key, 41152263)).toBe('005924'); // 1234567890 seconds
  });

  it('accepts the current code and one step either side, but not older, and never twice', () => {
    const secret = newTotpSecret();
    const now = Date.UTC(2026, 10, 6, 10, 0, 0);
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step), 0, now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), 0, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), 0, now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 3), 0, now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), step, now)).toBeNull(); // already used
    expect(verifyTotp(secret, '12345', 0, now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', 0, now)).toBeNull();
  });

  it('builds the link an authenticator app reads, and recovery codes that hash the same however typed', () => {
    expect(otpauthUri('Ledgerly', 'asha', 'ABC')).toBe('otpauth://totp/Ledgerly:asha?secret=ABC&issuer=Ledgerly&algorithm=SHA1&digits=6&period=30');
    const [code] = newRecoveryCodes(1);
    expect(code).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
    expect(hashRecoveryCode(code!)).toBe(hashRecoveryCode(code!.toUpperCase().replace('-', ' ')));
  });
});
