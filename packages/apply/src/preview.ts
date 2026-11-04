/**
 * Review previews: a link that shows a person one held photo, straight from
 * the private pending bucket, so the review PR can be checked before merging.
 * The apply run signs a link for each photo it holds for a person, and the
 * intake serves it at
 * `GET /v1/photos/review/<photo id>/<full|thumb>.jpg?expires=<Unix seconds>&sig=<HMAC-SHA256, base64url>`,
 * both with the same secret. A link works until it expires, and only for the
 * photo it names.
 */

/** How long a review link works: long enough for a review PR to wait a few weeks. */
export const PREVIEW_TTL_SECONDS = 30 * 24 * 60 * 60;

const PHOTO_ID = /^pho_[0-9A-HJKMNP-TV-Z]{26}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/;

function key(secret: string, usage: "sign" | "verify") {
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

const message = (photoId: string, expires: number) => new TextEncoder().encode(`review.${photoId}.${expires}`);

/** Whether `id` is a photo id a review link can name. */
export const isPhotoId = (id: string): boolean => PHOTO_ID.test(id);

/** The link to one held photo at `size`, served by the intake at `base`, working until `expires` (Unix seconds). */
export async function previewUrl(base: string, secret: string, photoId: string, size: "full" | "thumb", expires: number): Promise<string> {
  const sig = base64url(await crypto.subtle.sign("HMAC", await key(secret, "sign"), message(photoId, expires)));
  const url = new URL(`v1/photos/review/${photoId}/${size}.jpg`, base.endsWith("/") ? base : `${base}/`);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("sig", sig);
  return url.toString();
}

/** Whether a review link's signature is good for this photo and it has not expired. */
export async function verifyPreview(secret: string, photoId: string, expiresText: string, sig: string, nowMs: number): Promise<boolean> {
  if (!isPhotoId(photoId) || !/^\d{10}$/.test(expiresText) || !SIG.test(sig)) return false;
  const expires = Number(expiresText);
  if (expires * 1000 <= nowMs) return false;
  return crypto.subtle.verify("HMAC", await key(secret, "verify"), fromBase64url(sig), message(photoId, expires));
}
