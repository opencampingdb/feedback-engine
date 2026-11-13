/**
 * Photo passes: short-lived proof that a request for a photo comes from a
 * genuine copy of an app. The intake signs one for an attested install, and
 * the photo server checks it, both with the same secret. A pass reads
 * `p2.<app>.<install>.<expiry, Unix seconds>.<HMAC-SHA256, base64url>`, where
 * `install` names the install the pass was issued to, so the photo server can
 * count its limit per install. Passes signed before installs were named read
 * `p1.<app>.<expiry>.<HMAC>` and still verify until they expire.
 */

/** How long a pass works. */
export const PASS_TTL_SECONDS = 60 * 60;
const PASS_V1 = /^p1\.([a-z0-9][a-z0-9_-]{0,39})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;
const PASS_V2 = /^p2\.([a-z0-9][a-z0-9_-]{0,39})\.([0-9a-f]{16})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;
/** An install name: 16 lowercase hex characters. */
export const INSTALL = /^[0-9a-f]{16}$/;

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

/**
 * A pass for `app` that works until `expires` (Unix seconds). With `install`
 * (16 lowercase hex characters) it names the install, as every pass the
 * intake issues does. Without it, it reads like a pass from before installs
 * were named.
 */
export async function signPass(secret: string, app: string, expires: number, install?: string): Promise<string> {
  if (install !== undefined && !INSTALL.test(install)) throw new Error("install must be 16 lowercase hex characters");
  const body = install === undefined ? `p1.${app}.${expires}` : `p2.${app}.${install}.${expires}`;
  return `${body}.${base64url(await crypto.subtle.sign("HMAC", await key(secret, "sign"), new TextEncoder().encode(body)))}`;
}

/**
 * The pass's app, and the install it names when it names one, when its
 * signature is good and it has not expired. Undefined otherwise.
 */
export async function verifyPass(
  secret: string,
  pass: string,
  nowMs: number,
): Promise<{ app: string; expires: number; install?: string } | undefined> {
  const v2 = PASS_V2.exec(pass);
  const v1 = v2 ? null : PASS_V1.exec(pass);
  if (!v2 && !v1) return undefined;
  const [app, install, expiresText, mac] = v2 ? [v2[1]!, v2[2], v2[3]!, v2[4]!] : [v1![1]!, undefined, v1![2]!, v1![3]!];
  const expires = Number(expiresText);
  if (expires * 1000 <= nowMs) return undefined;
  const body = install === undefined ? `p1.${app}.${expiresText}` : `p2.${app}.${install}.${expiresText}`;
  const good = await crypto.subtle.verify("HMAC", await key(secret, "verify"), fromBase64url(mac), new TextEncoder().encode(body));
  if (!good) return undefined;
  return install === undefined ? { app, expires } : { app, expires, install };
}
