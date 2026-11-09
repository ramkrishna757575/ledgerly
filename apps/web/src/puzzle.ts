// The small piece of work asked before sign-up: find a number whose hash, with
// the token, starts with enough zero bits. A person's browser does this in a
// moment; a thousand fake sign-ups would each have to.
const zeroBits = (bytes: Uint8Array) => {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) bits += 8;
    else return bits + Math.clz32(byte) - 24;
  }
  return bits;
};

export async function solvePuzzle(token: string, difficulty: number) {
  const encoder = new TextEncoder();
  const BATCH = 64;
  for (let start = 0; ; start += BATCH) {
    const results = await Promise.all(
      Array.from({ length: BATCH }, async (_, i) => {
        const nonce = String(start + i);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${token}:${nonce}`)));
        return zeroBits(digest) >= difficulty ? nonce : null;
      }),
    );
    const found = results.find((r) => r !== null);
    if (found) return found;
  }
}
