/**
 * Contributor proofs: a short-lived token the app's own server signs to say
 * that the signed-in account may remove one of its photos, or erase all of
 * its photos or all of its reviews. An app key with `contributor_proof_key`
 * (an Ed25519 public key) makes the intake accept `photo_removal`,
 * `photo_erasure` and `review_erasure` only with a valid proof, so knowing a
 * traveller's contributor value is not enough to delete what they sent.
 *
 * The token is `<payload>.<signature>`: the payload is base64url JSON of the
 * claims below, and the signature is Ed25519 over the payload's characters,
 * base64url. `signContributorProof` runs on the app's server, which holds the
 * private key; the intake calls `verifyContributorProof`.
 */

/** The longest a proof may live, from `issued` to `expires`: one hour. */
export const MAX_PROOF_SECONDS = 3600;
/** How far ahead of the intake's clock `issued` may be, for clock drift. */
const CLOCK_SKEW_SECONDS = 60;
/** Longest token the intake reads. */
export const MAX_PROOF_LENGTH = 2048;

export type ProofAction = "photo_removal" | "photo_erasure" | "review_erasure";

/** The app server's Ed25519 private key, a WebCrypto CryptoKey (`crypto.subtle.generateKey({ name: "Ed25519" }, ...)` or `importKey`). */
export type ProofSigningKey = Parameters<typeof crypto.subtle.sign>[1];

export interface ContributorProofClaims {
  /** The app name of the app key the proof is for. */
  app: string;
  /** The contributor value the app sends, before the intake hashes it. */
  contributor: string;
  action: ProofAction;
  /** The photo id for a `photo_removal`, `"*"` for a `photo_erasure` or `review_erasure`. */
  photo: string;
  /** Unix seconds the proof was made. */
  issued: number;
  /** Unix seconds after which it is refused, at most MAX_PROOF_SECONDS after `issued`. */
  expires: number;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]!;
  }
  return out;
}

function fromBase64(text: string, url: boolean): Uint8Array<ArrayBuffer> | undefined {
  const clean = url ? text : text.replace(/=+$/, "");
  const pattern = url ? /^[A-Za-z0-9_-]*$/ : /^[A-Za-z0-9+/]*$/;
  if (!pattern.test(clean) || clean.length % 4 === 1) return undefined;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = url ? ALPHABET.indexOf(char) : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(char);
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Signs a proof with the app server's Ed25519 private key. Make one right
 * before the app removes a photo or erases an account's photos, for the
 * signed-in account only, and pass it as `contributorProof`.
 */
export async function signContributorProof(privateKey: ProofSigningKey, claims: ContributorProofClaims): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(payload)));
  return `${payload}.${toBase64Url(signature)}`;
}

/**
 * `"ok"` when `proof` was signed by the key whose raw 32-byte public half is
 * `publicKey` (base64), names exactly the expected app, contributor, action
 * and photo, and is live at `now` (milliseconds); otherwise `"invalid"`.
 */
export async function verifyContributorProof(
  publicKey: string,
  proof: string,
  expected: { app: string; contributor: string; action: ProofAction; photo: string; now: number },
): Promise<"ok" | "invalid"> {
  if (typeof proof !== "string" || proof.length > MAX_PROOF_LENGTH) return "invalid";
  const parts = proof.split(".");
  if (parts.length !== 2) return "invalid";
  const [payload, sig] = parts as [string, string];
  const signature = fromBase64(sig, true);
  const body = fromBase64(payload, true);
  const raw = fromBase64(publicKey, false);
  if (!signature || !body || !raw || raw.length !== 32 || signature.length !== 64) return "invalid";
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, signature, new TextEncoder().encode(payload)))) return "invalid";
  } catch {
    return "invalid";
  }
  let claims: Partial<ContributorProofClaims>;
  try {
    claims = JSON.parse(new TextDecoder().decode(body)) as Partial<ContributorProofClaims>;
  } catch {
    return "invalid";
  }
  if (typeof claims !== "object" || claims === null) return "invalid";
  const now = expected.now / 1000;
  const { issued, expires } = claims;
  if (typeof issued !== "number" || typeof expires !== "number") return "invalid";
  if (issued > now + CLOCK_SKEW_SECONDS || expires <= now || expires <= issued || expires - issued > MAX_PROOF_SECONDS) return "invalid";
  if (claims.app !== expected.app || claims.contributor !== expected.contributor) return "invalid";
  if (claims.action !== expected.action || claims.photo !== expected.photo) return "invalid";
  return "ok";
}

/** Whether `text` is a base64 raw Ed25519 public key (32 bytes), as `contributor_proof_key` holds. */
export function isProofPublicKey(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return fromBase64(text, false)?.length === 32;
}
