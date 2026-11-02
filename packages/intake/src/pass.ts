/**
 * Photo passes: short-lived proof that a request for a photo comes from a
 * genuine copy of an app. The intake signs one for an attested install, and
 * the photo server checks it, both with the same secret. A pass reads
 * `p1.<app>.<expiry, Unix seconds>.<HMAC-SHA256, base64url>`.
 */

/** How long a pass works. */
export const PASS_TTL_SECONDS = 60 * 60;
const PASS = /^p1\.([a-z0-9][a-z0-9_-]{0,39})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;

function key(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=");
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** A pass for `app` that works until `expires` (Unix seconds). */
export async function signPass(secret: string, app: string, expires: number): Promise<string> {
  const body = `p1.${app}.${expires}`;
  return `${body}.${base64url(await crypto.subtle.sign("HMAC", await key(secret, "sign"), new TextEncoder().encode(body)))}`;
}

/** The pass's app when its signature is good and it has not expired. Undefined otherwise. */
export async function verifyPass(secret: string, pass: string, nowMs: number): Promise<{ app: string; expires: number } | undefined> {
  const match = PASS.exec(pass);
  if (!match) return undefined;
  const [, app, expiresText, mac] = match as unknown as [string, string, string, string];
  const expires = Number(expiresText);
  if (expires * 1000 <= nowMs) return undefined;
  const good = await crypto.subtle.verify(
    "HMAC",
    await key(secret, "verify"),
    fromBase64url(mac),
    new TextEncoder().encode(`p1.${app}.${expiresText}`),
  );
  return good ? { app, expires } : undefined;
}
