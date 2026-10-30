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
