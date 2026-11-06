const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generates a ULID: 48 bits of milliseconds then 80 random bits, in Crockford base 32. */
export function ulid(nowMs: number, randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  let time = "";
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let random = "";
  for (let i = 0; i < 16; i++) random += CROCKFORD[bytes[i]! % 32];
  return time + random;
}

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** The milliseconds a ULID's first 10 characters hold. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/**
 * ULIDs for the items of one batch, all in the same millisecond: the first is
 * random, and each after it is the one before plus one, so the items sort by
 * id in the order they were sent, as the recent list's newest change needs.
 */
export function monotonicUlids(nowMs: number, randomBytes: (n: number) => Uint8Array = defaultRandomBytes): () => string {
  let last: string | undefined;
  return () => {
    if (last === undefined) {
      last = ulid(nowMs, randomBytes);
      return last;
    }
    const chars = last.split("");
    for (let i = chars.length - 1; i >= 10; i--) {
      const digit = CROCKFORD.indexOf(chars[i]!);
      if (digit < 31) {
        chars[i] = CROCKFORD[digit + 1]!;
        break;
      }
      chars[i] = CROCKFORD[0]!;
    }
    last = chars.join("");
    return last;
  };
}
